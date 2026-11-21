// Owner of the subagents per CHAT: holds the provider-neutral agent core (providers/agent-runtime.js), builds a
// subagent's run spec from an EXPLICIT context (agentSpecFactory) and keeps the event sink, call blocks (explicit id or
// Codex mapping, no stack), live agents, open reports and consumption.
//
// What the turn still passes in (`turn`): `event` (the addendum to the call block goes through ITS distribution — it is
// not the run's limit evidence: an agent at the limit parks itself) and `atStart`/`atEnd` (keeping open, tick, display,
// delivery). The turn closes the owner in its finally (closeAgents).
//
// Lifetime: subagents belong to the CHAT, not the turn. If the run kind holds (`context.hold`, special chats and graph
// chats), the turn waits and the report goes into its process (reports). If it does not (the Coding chat), EVERY
// report not picked up goes as a completion notice (runs/completionNotice.js) over the chat's one wake path
// (`context.deliver`, runs/queue.js deliverUserPrompt with cause "agent") — whether the turn still runs or not.
// Consumption is booked per agent IMMEDIATELY at its end.
//
// A subagent's events run through its OWN sink (underEvent), not the turn's. Otherwise a subagent's
// ScheduleWakeup/CronCreate would set the wakeup or schedule of the MAIN RUN and hold the chat open without the main
// agent knowing.
//
// Import rules: neither do-run.js nor queue.js (the runs cycle must not grow, cycle guard), no domain folder.

import fs from "node:fs";
import path from "node:path";
import { PROVIDERS, agentHosts, effortDesired, effortRunning, resolveModelRef, runChat, startGateVerdict } from "../providers/index.js";
import { saverOn, saverField } from "./saver.js";
import { createAgentRuntime, subagentFrame, workflowStallRule, unregisterWorktree } from "../providers/agent-runtime.js";
import { adjustableClock } from "../providers/stall-watchdog.js";
import { subscriptionBooking, meteredBooking } from "../providers/connectors/consumption.js";
import { codexIntersectionOfTheBuiltins } from "../providers/codex-builtins.js";
import { agentToolset, codingSet, engineAllowlist, externAllowed, workflowAgentSet } from "./agent-set.js";
import { AGENT_DEPTH_MAX, OUTER_LOOP_REJECTION, VIEW_BY_DEPTH, WORKFLOW_AGENT_REJECTION } from "../../mcp/visibility.js";
import * as store from "../store.js";
import { agentMcpFileIn, allLocations, removeTrace, createLocation, locationFor, locationForChat, locationForProject, playwrightProfileRoot, worktreeRoot } from "./runtime-location.js";
import { instanceFromIdentifier, instanceForProject, instanceIdentifierOf, instanceOfChat, projectFromIdentifier, switchAfterTurn } from "./instance.js";
import { gitInProject, withOpen, worktreeTeardown } from "./git-post-work.js";
import { backendAccessFor } from "./backend-access.js";
import { lfsLockForStdio } from "./lfs-environment.js";
import { agentOutputs } from "./outputs.js";
import { removeInRuntimeFolder } from "./runtime-write.js";
import { readInRuntimeFolder } from "./runtime-limit.js";
import { depositHint, hintFence, withHints } from "./hints.js";
import { sessionConfirmed, sessionForStart, sessionTransferHint } from "./session-location.js";
import { loadAgentHooks } from "../toolchain/profiles.js";
import { instructionsFor } from "../toolchain/instructions.js";
import { skillCatalog, skillsResolve, skillStock } from "../toolchain/skill-catalog.js";
import { playwrightConfigPath, resolveChatHeadless } from "../toolchain/playwright.js";
import { chatProfileDir } from "../browser-profiles.js";
import { approvalOverMcp, writeMcpConfig } from "../toolchain/mcp-config.js";
import { expiry as airlockExpiry } from "../toolchain/airlock-token.js";
import { hasFree } from "../toolchain/mcp-tools.js";
import { loadPermissionRules, loadWebSearchConfig, rememberPermissionRule, requestPermission } from "./permissions.js";
import { agentCardsIntoTheBackground, clearAgentPermissions } from "./approvals.js";
import { managerLocked } from "./manager-lock.js";
import { T } from "../i18n.js";
import { boundResult, boundToolInput, buildEngineTranscript, focusedProject, projectFocus, projectMemory, resolveCwd, toolDetail } from "./system-prompt.js";
import { offeringOfTheEntry } from "../../mcp/offering.js";
import { projectRepos } from "../git.js";
import { sse } from "../runtime/sse.js";
import { createCallBlocks } from "./call-blocks.js";
import { fireHooks } from "./hooks.js";
import { fireAgentHook } from "../providers/hook-run.js";
import { observeMonitors, liveMonitors } from "./monitors.js";
import { observeWakeup, wakeupOf } from "./wakeup.js";
import { completionNotice, notDelivered } from "./completionNotice.js";
import { defaultModelFor } from "../account/providers.js";
import * as limits from "../limits.js";

// chatId -> agent controller of the chat. The agent routes read here (agentsOf).
const owner = new Map();
// EVERY open core, including one whose turn has already ended (run kind without holding) — a new turn of the same chat
// may already have replaced it in `owner`, its agents run on regardless. The ONE query for open background work reads
// from this set (liveAgents → runs/background.js).
const open = new Set();
// The OWN cores (dynamic workflows, `own`): not in `open` (they belong to their run, not the chat), but counted for the
// question "who is working in the project?". Entered on opening, removed in close().
const ownCores = new Set();
// How long a Codex start waits for its call block: the CLI stream and the MCP request reach the server on two paths,
// the request can arrive before `item.started`. Knob for tests.
const BLOCK_WAIT_MS = Number(process.env.CBASE_AGENT_BLOCK_WAIT_MS) || 5_000;
// Wakeups of parked agents. They hang on the SERVER RUN: agentsAtServerEnd (server.js, on `close`) closes all open
// cores and thereby clears every wakeup — otherwise a wakeup from an ended server run would wake an agent into the
// next one (tests run dozens of servers in one process).
const parkWakeup = new Set();
function wakeup(ms, fn) {
  const entry = { t: null, fn };
  entry.t = setTimeout(() => { parkWakeup.delete(entry); fn(); }, Math.min(ms, 2 ** 31 - 1));
  entry.t.unref?.();
  parkWakeup.add(entry);
  return () => { clearTimeout(entry.t); parkWakeup.delete(entry); };
}
// The two connections WITHOUT a turn, set at boot in server.js from runs/do-run.js — this file must not import
// do-run.js (cycle guard). `openCore(chatId)`: a core without a turn carrying the chat's context (the restart picks up
// a parked agent in it). `catchUp(chatId)`: the deferred verdict at the end of work. Unset (unit tests without a
// server) neither happens — a parked agent is then reported as orphaned.
let withoutTurn = { openCore: null, catchUp: null };
export function setWithoutTurn({ openCore = null, catchUp = null } = {}) { withoutTurn = { openCore, catchUp }; }

// A chat's background work became empty without a turn (the last live agent of a core without a turn ended): catch up
// the deferred verdict. In a microtask — only AFTER the caller (stopInCore deposits the hint of its stop after the
// stop; onFinish has already delivered a completion notice: its turn runs then, and catchUp leaves the verdict to it).
// Whether nothing is open any more, catchUp asks itself.
// ONE observer learns BEFORE the catch-up that a chat's background work became empty (the last agent of a core without
// a turn, a dynamic workflow — runs/background.js backgroundEnds calls here). Set in server.js (the layout re-checks its
// quiet state); runs/ does not import the domain side.
let emptyObserver = null;
export function setWorkEmptyObserver(fn) { emptyObserver = typeof fn === "function" ? fn : null; }
export function workEmpty(chatId) {
  if (emptyObserver) { try { emptyObserver(chatId); } catch (e) { console.error("[agent] observer \"work empty\":", chatId, e?.message || e); } }
  if (!withoutTurn.catchUp) return;
  queueMicrotask(() => {
    try { withoutTurn.catchUp(chatId); } catch (e) { console.error("[agent] deferred verdict not caught up:", chatId, e?.message || e); }
  });
}

/** A park wakeup for waiters that are not agents (a workflow agent at the credit gate before it starts) — the same
 *  set as the parked agents': `wakeParkedNow` wakes it too, the server end clears it. */
export const setParkWakeup = (ms, fn) => wakeup(Math.max(0, Number(ms) || 0), fn);
/** How many park wakeups are set — for guards (stop and delete take them along). */
export const parkWakeupCount = () => parkWakeup.size;
/** Fire every park wakeup NOW as if the reset were reached — the test seam that makes the parked state observable
 *  without a clock (the test parks for an hour, looks, then wakes itself). Returns the number woken. */
export function wakeParkedNow() {
  const all = [...parkWakeup];
  for (const e of all) { clearTimeout(e.t); parkWakeup.delete(e); e.fn(); }
  return all.length;
}

// The clock of the stall watchdogs of ALL subagents of the process: the wall clock in production, advanceable in tests
// — a test raises the deadline (CBASE_AGENT_STALL_MS) and advances the clock itself instead of waiting 600 s. A
// watchdog ends with its turn and takes its wakeup along.
const stallClock = adjustableClock();
/** Test seam: advance the stall clock by `ms` — every watchdog due checks immediately. Returns the number of checks. */
export const advanceStallClock = (ms) => stallClock.advance(ms);
/** Test seam: the stall watchdog state of a subagent, or null. */
export function stallState(chatId, agentId) {
  return coreWithAgent(chatId, agentId)?.stallState(agentId) ?? null;
}

// ── The cap per chat ─────────────────────────────────────────────────────────────────────────────────────────────
// At most N subagents live in a chat at the same time — foreground and background, all cores of the chat (including
// that of a past turn whose agents still live; a parked one lives) and all levels together. Counted HERE, in the owner,
// not per run and not per parent agent. Under ultracode (chat field) there is none, as in Claude Code.
// No queue: the call above the cap fails immediately and is not caught up. A continuation via cbase_agent_send does not
// ask and occupies its slot afterwards. Knob: CBASE_AGENT_CAP.
export const AGENT_CAP_DEFAULT = 20;

/** The cap in force now — the environment at call time, otherwise the default. */
export function agentCap() {
  const n = Number(process.env.CBASE_AGENT_CAP);
  return Number.isInteger(n) && n > 0 ? n : AGENT_CAP_DEFAULT;
}

/**
 * Is the chat's cap reached? The error text names the boundary explicitly — otherwise a model would repeat the call in
 * a loop.
 * @returns {string|null}  error text or null (slot free, or ultracode)
 */
export function agentCapFull(chatId, chat = null) {
  if ((store.getChat(chatId) || chat)?.ultracode) return null;
  const limit = agentCap();
  const occupied = coresOf(chatId).reduce((n, k) => n + k.liveCount(), 0);
  if (occupied < limit) return null;
  return `Cap reached: ${occupied} subagents are already running in this chat at the same time, the boundary is ${limit} per chat`
    + " (foreground and background together). NO subagent was started, and the call is not caught up."
    + " Do not repeat: wait for the reports of the running subagents (they arrive on their own) or do the"
    + " subtask yourself. Only when one has finished is a slot free again.";
}

/**
 * A subagent failed — does it park at the usage limit? Same detection and same choice of waiting time as when a whole
 * run parks (runs/auto-continue.js maybeAutoContinue: limits.detectLimitHit + chooseWait), but for ITS provider and
 * ITS model, and without a waiting row: the pause belongs to the agent, not the chat. Unlike there, no evidence is
 * required (requireReset): the agent's turn HAS failed.
 *
 * @param {Object} a  { errorText, provider, model, sessionId, attempts, chat }
 * @param {{window:(provider:string, chat:Object)=>Promise<Object[]>, autoContinueOn:()=>boolean}} limit
 * @returns {Promise<null|{dueAt:number, resetsAt:number}|{note:string}>}
 */
export async function agentLimitChoice({ errorText, provider, model, sessionId, attempts = 0, chat }, limit) {
  const now = Date.now();
  const hit = limits.detectLimitHit({ stderr: errorText, now });
  if (!hit.hit) return null;
  if (!limit?.autoContinueOn?.()) {
    return { note: T("Usage limit reached — auto-continue is switched off, the subagent does not wait.") };
  }
  if (attempts >= limits.MAX_CONTINUES) {
    return { note: T`Usage limit: giving up after ${attempts} continuations.` };
  }
  // Codex reads its windows from the thread's session file — the AGENT's, not the chat's.
  const window = await Promise.resolve(limit.window(provider, { ...chat, model: model || chat?.model || "", claudeSessionId: sessionId || "" })).catch(() => []);
  const wait = limits.chooseWait({ windows: window || [], now, hintResetAt: hit.resetAt, creditsHint: hit.credits });
  if (wait.ok) return { dueAt: wait.resumeAt, resetsAt: wait.window?.resetsAt || hit.resetAt || 0 };
  // Reset unknown: look again in growing steps — as for the run (probeDelayMs).
  if (wait.reason === "unknown") return { dueAt: now + limits.probeDelayMs(attempts), resetsAt: 0 };
  return { note: wait.reason === "credits"
    ? T("Usage credits or the spend cap are exhausted — that does not recover on its own, the subagent does not wait.")
    : T("The reset is too far out — the subagent does not wait.") };
}

/**
 * Run spec of a subagent — as a factory with an EXPLICIT context instead of a closure over the turn.
 *
 * @param {Object} context
 * @param {Object} context.chat        chat row (id, projectId, workspaceId, claudeSessionId, effort, …)
 * @param {string} context.provider    provider id of the parent run (for the real fork of a native CLI)
 * @param {Object} context.profile     { permissionMode, addDirs, builtinTools } — the run's permissions
 * @param {Object} context.tools       { toolset, cbase (read-only set, null = no cut), extraServers, extern
 *                                     (external MCP servers of the run kind), mcpAllow, skills (the chat's catalog) }
 * @param {number} [context.depth=1]   depth of the chat's DIRECT subagents; an agent carries its own (o.depth)
 * @param {{frame?: string, workflowAgent?: boolean}} [opts]
 *        `frame`: frame behind the role; without it the one computed from depth and set (subagentFrame).
 *        `workflowAgent`: the agents of a dynamic workflow — the chat's set 1:1 minus delegation, workflows, question,
 *        wakeup and monitor via the MCP server's OWN marker (not via depth), and every approval request is declined
 *        without a card (no human in the run).
 * @returns {(o:Object) => Promise<Object>}  buildSpec for createAgentRuntime — async because the project memory of a
 *        COPY is read by its container (system-prompt.js projectMemoryPromptIn)
 */
export function agentSpecFactory({ chat, provider, profile, tools: toolsValue, depth: depthOfTheChildren = 1, runtime = null }, { frame = null, workflowAgent = false, outerLoop = null, location = null, instance = null } = {}) {
  const { permissionMode, addDirs, builtinTools } = profile;
  // The runtime folder of this factory's agents: that of the core opening them — fixed ONCE, not per start (a project
  // switch does not move anything for a running core).
  const runLocation = location || runtime || locationForChat(chat);
  // Same for the instance: the core's. An agent whose record carries ANOTHER one (picked up after a project switch)
  // runs in that one — including the MCP file in its project's location; if it no longer exists, it runs in the backend.
  const coreIdentifier = instanceIdentifierOf(instance);
  const { toolset, cbase, extraServers, extern, mcpAllow, skills: catalogOfTheChats } = toolsValue;
  const skillNames = catalogOfTheChats.map((s) => s.name);
  // An outer-loop run: `{ agentId, runId }` — only from an own core (openAgents). Its set arrives READY from the outer
  // loop (cbase list including cbase_chat_analysis, chosen builtins, chosen external servers without marks); its
  // permissions are the allowlist: chosen builtins + MCP tools free upfront, NO permissionPromptTool (the CLI declines
  // everything else itself under `-p`), the engine declines every request without a card. Own marker
  // (CBASE_OUTER_LOOP), own profile, own MCP file (no workflow marker: the deploy counts it as busy).
  const ol = outerLoop?.agentId && outerLoop?.runId ? { agentId: String(outerLoop.agentId), runId: String(outerLoop.runId) } : null;
  const olExtern = ol ? Object.fromEntries((extern || []).map((x) => [x.server.key, x.tools.map((t) => t.name)])) : null;
  // Deliberately the same shape as the main run's spec (same permissions, same directories, same MCP set) — with three
  // differences: own system prompt, own MCP config (depth → no further delegation, no question, own browser profile)
  // and no builtin agent tool.
  return async function buildAgentSpec({ agentId, systemPrompt: sysPrompt, input: agentInput, provider: prov, model: mdl, effort: agentLevel = "", cwd: agentCwd, tools, skills, sessionId: sid, transcript: hist, inheritContext, depth: ownDepth, parentSet, structure = null, instance: agentIdentifier = coreIdentifier, mcp: typeChoice = null }) {
    const agentInstance = (agentIdentifier || null) === coreIdentifier ? instance : instanceFromIdentifier(agentIdentifier);
    const agentLocation = locationOfTheAgents(runLocation, coreIdentifier, agentIdentifier);
    if (agentLocation !== runLocation) createLocation(agentLocation);
    // Depth and set of THIS agent — ONE computation for execution (MCP list, block list, engine marker) and description
    // (frame): the parent agent's set ∩ definition/call ∩ depth table.
    const depth = Math.max(1, Number(ownDepth) || depthOfTheChildren);
    const set = ol
      ? agentToolset({ parent: { cbase: Array.isArray(toolsValue.cbase) ? toolsValue.cbase : [], builtin: Array.isArray(builtinTools) ? builtinTools : [], extern: olExtern, skill: false }, required: null, depth: 1 })
      : workflowAgent
        ? workflowAgentSet({ parent: { cbase: Array.isArray(toolsValue.cbase) ? toolsValue.cbase : null, builtin: null }, required: tools })
        : setFor(toolsValue, { parentSet, tools, depth });
    // The Coding MCP servers of THIS agent (runs/agent-set.js codingSet): what its agent type brings (`typeChoice`, the
    // definition's choice) ∩ what its parent has, plus the servers with "subagents inherit". ONE computation for MCP
    // file, run token and allowlist. An outer-loop run has its own choice (above, olExtern).
    const coding = ol ? null : codingSet({ parent: parentSet?.coding ?? null, type: typeChoice, server: extraServers });
    const fromType = coding && typeChoice ? Object.keys(coding).filter((id) => Object.hasOwn(typeChoice, id)) : [];
    const cfgPath = agentMcpFile(chat.id, agentId, { workflowAgent, outerLoop: ol, location: agentLocation });
    // The permission prompt: ONE computation for the CLI flag and the tool's offering.
    const approvalTool = !ol && approvalOverMcp(PROVIDERS[prov]?.caps, permissionMode);
    const { names, servers, airlock: airlockNames } = writeMcpConfig(cfgPath, {
      projectId: chat.projectId, workspaceId: chat.workspaceId, chatId: chat.id, approval: approvalTool,
      // Coding MCP airlock: the Coding servers only with "subagents inherit", with this agent's OWN run token.
      extraServers, agentId, setProject: focusedProject(chat)?.id ?? null, headless: resolveChatHeadless(chat), toolset,
      ...(coding ? { codingChoice: coding, fromType } : {}),
      agentDepth: depth, profileKey: profileOf(chat.id, agentId, ol), vision: PROVIDERS[prov]?.caps?.vision !== false,
      // A subagent inherits its parent's catalog: it does a piece of the parent's work and should follow the same
      // guides — unless its tool list leaves out the skill tool.
      skills: set.skill ? skillNames : [],
      // Foreign MCP servers only as far as the list names them: that also cuts Codex, which does not read a
      // definition's list. The cbase server always stays (CBASE_TOOLS cuts its part).
      // An outer-loop run: only its chosen external servers — no Playwright, no workspace server (its `set.extern` is never null).
      onlyServer: set.extern ? Object.keys(set.extern) : null,
      // The set as an EXPLICIT list. Without it `CBASE_TOOLS` is not set, the MCP server falls back to the named set or
      // the full catalog — and a subagent would inherit the writing tools. Only at depth 1 without any cut is it omitted.
      tools: set.cbase,
      workflowAgent: workflowAgent ? agentId : "",
      outerLoop: ol ? `${ol.agentId}:${ol.runId}` : "",
      // The schema of an agent(prompt, {schema}) with its reference — only then does the MCP server show the messenger.
      structure: structure?.schema && structure?.reference ? { schema: structure.schema, reference: structure.reference } : null,
      runtime: agentLocation,
      // Address and token of THIS agent's instance (that of its record); without an instance nothing.
      ...backendAccessFor(agentInstance),
      // Like the main run — only a Claude subagent with an LFS environment (runs/lfs-environment.js).
      ...(lfsLockForStdio(agentInstance, prov) ? { lfsLock: true } : {}),
    });
    // The external tools must also be on the allowlist — as in the main run. Without them the server would be in the
    // config and the CLI could call none of its tools.
    // With a tool list only what it allows: a whole server as `mcp__<server>`, a single tool under its full name — the
    // Claude Code notation.
    const externFree = set.extern;
    // Cut set (toolset) or outer loop: free upfront are the cbase server as a whole and the run's allowlist, as far as
    // the set allows them. The outer loop already removes marked tools from its set.
    const upfrontExtern = toolset || ol ? mcpAllow.filter((n) => allowedName(externFree, n)) : [];
    // Outer loop: the chosen builtins are on the allowlist too — they run without asking, the CLI declines everything else.
    const allowedForAgent = ol
      ? [...(set.builtin || []), "mcp__cbase", ...upfrontExtern]
      : toolset
        ? ["mcp__cbase", ...upfrontExtern]
        : ["mcp__cbase", ...(externFree ? [] : ["mcp__playwright"]), ...names.flatMap((n) => airlockNames.includes(n) ? wrappersNames(n, coding, extraServers) : approvalNames(externFree, n))];
    // Tool allowlist of the agent type: builtin tools are cut by the provider (Claude --tools, engine
    // spec.builtinTools/agentTools; Codex only in stages, codexCut below); cbase names by the cbase server (CBASE_TOOLS),
    // foreign servers by the MCP config (onlyServer) and per tool by allowedTools or enabled_tools.
    const wanted = set.builtin;
    const ownsAgentLoop = PROVIDERS[prov]?.caps?.ownsAgentLoop !== false;
    // "fork" inherits the chat's context. A native CLI can do that FOR REAL (resume of the session with its own branch,
    // so the running main process keeps its session); a completion provider gets the history as a transcript.
    const forkNative = Boolean(inheritContext && ownsAgentLoop && prov === provider && chat.claudeSessionId && !sid);
    // The OWN session of a continued subagent lies, before the spawn, in its instance's home, in the slug of its
    // working folder (runs/session-location.js). A fork branches off the chat's session — the turn has fetched that.
    // The move travels with the spec: only the successful turn at the new location confirms it (agent-runtime.js drive →
    // `confirmSession`), then the old copies go.
    const sessionTransaction = sid ? sessionForStart({ sid, provider: prov, instance: agentInstance, cwd: agentCwd }) : null;
    // If `<sid>/` moved along (tool results under the old absolute path), a fenced preamble on this turn's input says
    // so — the same form as the chat's silent hint (runs/hints.js), only without deposit.
    const relocationPreamble = hintFence([{ source: "session_transfer", text: sessionTransferHint(sessionTransaction) }].filter((h) => h.text));
    // The catalog WITHOUT the loaded skills: those are already fully in the subagent's system prompt (skills block in
    // the core) — a catalog row next to them would mean "fetch what you have".
    const loaded = new Set((skills || []).map((sk) => sk.name));
    // Without the skill tool no catalog either: it would mean "fetch with a tool you do not have".
    const catalog = set.skill ? catalogOfTheChats.filter((sk) => !loaded.has(sk.name)) : [];
    // The CORE resolved the model (providers/agent-runtime.js resolveModel): argument ▸ agent type ▸ the parent's model
    // at the same provider ▸ the provider's default — with the default as a callback (`defaultModel` in openAgents),
    // not in the connector: that must not ask the registry (cycle). A second resolution here would not know the chat's
    // model, and gate, record and report would see "" instead of the model.
    const agentModel = mdl || "";
    // The frame (depth, remaining levels, "report briefly at the end") stands BEHIND the role and BEFORE the catalog.
    // It names the subagent tool only if the set contains it.
    const delegated = depth < AGENT_DEPTH_MAX && (set.cbase === null || set.cbase.includes("cbase_agent"));
    // With a schema, the caller's addition follows — runs/ does not know it, it arrives with the start.
    // Coding MCP airlock: Coding servers this agent does not inherit are named by one sentence in BOTH frames — without
    // them byte-identical. Whether "main" is open to this agent is computed by writeMcpConfig (marker
    // CBASE_MAIN_ADDRESS: a subagent of a Coding chat that is offered cbase_agent_send — not a workflow agent, it does
    // not have the tool).
    const mainMay = servers?.cbase?.env?.CBASE_MAIN_ADDRESS === "1";
    const onlyMain = !mainMay ? [] : (extraServers || []).filter((x) => hasFree(x) && !airlockNames.includes(x.name)).map((x) => x.name);
    const mainSentence = onlyMain.length ? `\n\nOnly the main agent has these MCP servers: ${onlyMain.join(", ")} — if you need one, write to it with cbase_agent_send to "main".` : "";
    const withFrame = `${sysPrompt}${frame ?? subagentFrame({ depth, delegated })}${mainSentence}${structure?.frame ? String(structure.frame) : ""}`;
    // Individually allowed tools of a foreign server: Codex cuts them via `enabled_tools` (codex.js), the Claude CLI via
    // allowedTools, the engine via agentTools.
    // An airlock wrapper stands whole (the airlock decides choice and card) — no enabledTools from the list.
    const mcpServers = withSingleApprovals(servers, externFree && Object.fromEntries(Object.entries(externFree).filter(([k]) => !airlockNames.includes(k))));
    // Project focus and project memory — THE SAME computation as in the main run (system-prompt.js
    // projectFocus/projectMemory), for every provider; without them a subagent would not know which project it works in
    // and what its CLAUDE.md/AGENTS.md prescribe. Without the main run's base block.
    //   - The project is the one the agent RUNS in: that of its instance (a picked-up agent carries that of its record),
    //     otherwise the core's (the chat at opening) — never the one the chat carries by now. Read as in the main run
    //     via the CHAT's working folder (resolveCwd) and BEHIND it via the agent's (a worktree, a sub-repo), each from
    //     the git root downward.
    //   - The focus names only tools its cbase server offers (mcp/offering.js offeringOfTheEntry — the entry Codex
    //     gets too): a workflow agent reads nothing about fetching, clearing or switching instances.
    //   - Order as in the main run: behind role and frame (equal for all agents of a type), focus before memory, both
    //     before the skill catalog — the changeable (a CLAUDE.md edited during the run) behind the fixed.
    //   - Not an outer-loop run: it observes chats, works in no project and runs sandboxed.
    //   - If the instance of its record can no longer be resolved, the identifier's project counts and the memory asks
    //     the instance NOW (projectMemory `identifier`) — the backend never reads a converted project via the path.
    const agentProject = agentInstance?.projectId ?? projectFromIdentifier(agentIdentifier);
    const projectChat = agentProject && String(agentProject) !== String(chat.projectId ?? "") ? { ...chat, projectId: agentProject } : chat;
    const projectParts = ol ? [] : [
      projectFocus(projectChat, { instance: agentInstance, tools: new Set(offeringOfTheEntry(mcpServers.cbase)) }),
      await projectMemory(projectChat, { cwd: resolveCwd(projectChat, { instance: agentInstance }), instance: agentInstance, identifier: agentIdentifier, agentCwd }),
    ].filter(Boolean);
    // The user's instructions: every subagent and workflow agent of every provider carries the sections of scope `all`
    // and `sub` — of the workspace and of the project it RUNS in (like the focus). Behind role and frame, before focus
    // and memory. Not an outer-loop run (own, sandboxed job).
    const instructions = ol ? "" : instructionsFor({ workspaceId: chat.workspaceId, projectId: projectChat.projectId || null, role: "sub" });
    const hinterFrame = [instructions, ...projectParts].filter(Boolean);
    const withProject = hinterFrame.length ? `${withFrame}\n\n${hinterFrame.join("\n\n")}` : withFrame;
    const codexCut = prov === "codex" && !ol ? codexIntersectionOfTheBuiltins(set.builtin, permissionMode) : { permissionMode };
    return {
      cwd: agentCwd,
      instance: agentInstance, // start in the project container; null = in the backend
      // CPU saver: every agent of this core is background work — with the toggle on `saver: true` (nice, waiting before
      // Bash), otherwise the field is missing (runs/saver.js). Read per turn.
      ...saverField(saverOn()),
      systemPrompt: catalog.length ? `${withProject}\n\n${skillCatalog(catalog)}` : withProject,
      addDirs,
      permissionMode: codexCut.permissionMode,
      mcpConfigPath: cfgPath,
      mcpServers,
      allowedTools: allowedForAgent,
      builtinTools: wanted || builtinTools,
      // The Claude CLI's builtin agent tool stays forbidden (it would bypass the core: no cap, no depth); delegation
      // goes only via cbase_agent. At the depth boundary its family is on the block list too — the same count as in
      // the MCP server.
      disallowedTools: ["Agent", "Task", "Skill", ...CLI_LOCK_AT_THE_LIMIT(depth)],
      permissionPromptTool: approvalTool,
      // Codex knows no allowlist of builtins: an outer-loop run WITHOUT chosen builtins runs without shell and without
      // view_image — otherwise it would read the whole file system in the read-only sandbox while its frame says "no
      // file access". With chosen builtins the shell stays; the frame names it.
      // A Codex SUBAGENT with a tool list (providers/codex-builtins.js): without builtins likewise without file
      // access, with only reading ones read-only — matching what the description of cbase_agent `tools` promises.
      ...((ol && !(set.builtin || []).length) || codexCut.codexWithoutFileAccess ? { codexWithoutFileAccess: true } : {}),
      // The loop engine's marker: the depth instead of "is a subagent". The engine provides no `Task` (delegation goes
      // only via cbase_agent, whose boundary the MCP server draws); the marker only carries ExitPlanMode and the step
      // cap there. Workflow agent and outer loop stand at the boundary for the engine.
      agentDepth: workflowAgent || ol ? AGENT_DEPTH_MAX : depth,
      // The engine's allowlist: builtins AND MCP names of the list. Empty means empty, not "no filter".
      // The messenger StructuredOutput survives this cut too: a list not naming it would otherwise take it from the
      // engine although the MCP server offers it.
      agentTools: engineAllowlist(set, { bote: Boolean(structure?.schema) }),
      // Isolation against a `.claude/skills` in the working directory — by ITS provider, not the chat's.
      settingSources: ownsAgentLoop && prov !== "codex" ? "user" : "",
      model: agentModel,
      // The subagent's level (argument of cbase_agent, otherwise that of the calling agent), otherwise the chat's —
      // clamped to ITS model by the one fallback rule, the same resolution as for the main run. If the chat carries
      // none, the subagent inherits the default level of the PARENT provider, not its own.
      // An outer-loop run inherits NOTHING from the observed chat: its level is the agent's, otherwise ITS provider's default.
      effort: effortRunning(prov, agentModel, agentLevel || (ol ? effortDesired(prov, "") : effortDesired(provider, chat.effort)), { report: true }),
      sessionId: forkNative ? chat.claudeSessionId : (sid || null),
      forkPending: forkNative,
      input: withHints(relocationPreamble, agentInput),
      // After a successful turn with the same session the old copies go; without a move nothing.
      confirmSession: sessionTransaction ? (sidAfter) => sessionConfirmed(sessionTransaction, sidAfter) : null,
      transcript: ownsAgentLoop ? [] : (hist || []),
      // Completion providers need the engine context. No startMonitor/stopMonitor: a subagent does not hold a run
      // open, it reports and ends.
      engine: ownsAgentLoop ? null : {
        // The card belongs to THIS agent — from its context, not from the time of the request.
        // A workflow agent: no human in the run — declined without a card, the agent gets the reason.
        requestPermission: ol
          ? async () => ({ behavior: "deny", message: OUTER_LOOP_REJECTION })
          : workflowAgent
            ? async () => ({ behavior: "deny", message: WORKFLOW_AGENT_REJECTION })
            : (a) => requestPermission(chat.id, { ...a, agent: agentAsOwner(chat.id, agentId) }),
        hooks: loadAgentHooks(),
        allowRules: loadPermissionRules(),
        rememberRule: (rule) => rememberPermissionRule(rule),
        webSearch: loadWebSearchConfig(),
      },
      attachments: null,
    };
  };
}

// The approval of a foreign server in the Claude CLI notation (whole or per tool).
function approvalNames(extern, server) {
  if (!extern) return [`mcp__${server}`];
  if (!externAllowed(extern, server)) return [];
  return extern[server] === null ? [`mcp__${server}`] : extern[server].map((w) => `mcp__${server}__${w}`);
}
// The approval of an airlock wrapper in the Claude CLI notation: whole (`mcp__<name>` — the airlock decides choice and
// card), unless the agent's set names only individual tools for this server (agent type with a selection, codingSet) —
// then exactly those, the same answer as the airlock.
function wrappersNames(name, coding, extraServers) {
  const id = (extraServers || []).find((x) => x.name === name)?.id;
  const w = coding && id != null ? coding[id] : undefined;
  return Array.isArray(w) ? w.map((x) => `mcp__${name}__${x}`) : [`mcp__${name}`];
}
// A full tool name `mcp__<server>__<tool>` against the approval (the run's allowlist).
function allowedName(extern, name) {
  const m = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/.exec(name);
  return !m || externAllowed(extern, m[1], m[2]);
}
// The server map for the spawn, with `enabledTools` on every server of which the list names only individual tools.
function withSingleApprovals(servers, extern) {
  if (!extern) return servers;
  return Object.fromEntries(Object.entries(servers).map(([k, e]) => [k, Array.isArray(extern[k]) ? { ...e, enabledTools: extern[k] } : e]));
}

// The cbase_agent* family as Claude CLI names — on the block list at the depth boundary.
const CLI_LOCK_AT_THE_LIMIT = (depth) => (depth >= AGENT_DEPTH_MAX ? VIEW_BY_DEPTH.onlyAtTheLimit.map((n) => `mcp__cbase__${n}`) : []);

// An agent's set: parent set (at depth 1 the chat's: `tools.cbase`, the run's builtins) ∩ required.
function setFor(toolsValue, { parentSet, tools, depth }) {
  const parent = parentSet ?? { cbase: Array.isArray(toolsValue.cbase) ? toolsValue.cbase : null, builtin: null };
  return agentToolset({ parent, required: tools, depth });
}

// The subagents' event sink: persistence under the call block (parent_tool_use_id, always set by agent-runtime — if
// need be synthetically "agent:<id>") and the same chat stream. NO context counter, no main answer, no turn change —
// and no wakeups/schedules/monitors/background commands: those belong to the main run.
// Row shapes as in the turn's distribution (do-run.js handleRunEvent), so web and iOS notice nothing.
function underEvent(chatId, evt) {
  const parentId = evt.parent_tool_use_id ?? null;
  if (evt.type === "assistant") {
    for (const blk of evt.message?.content ?? []) {
      if (blk.type === "text" && blk.text?.trim()) {
        store.addMessage(chatId, "sub_text", JSON.stringify({ text: String(blk.text).slice(0, 12000), parent: parentId }));
      } else if (blk.type === "thinking" && blk.thinking?.trim()) {
        store.addMessage(chatId, "thinking", JSON.stringify({ text: String(blk.thinking).slice(0, 12000), parent: parentId }));
      } else if (blk.type === "tool_use") {
        store.addMessage(chatId, "tool", JSON.stringify({ name: blk.name, detail: toolDetail(blk.input), id: blk.id, input: boundToolInput(blk.input), parent: parentId }));
      }
    }
  } else if (evt.type === "user") {
    for (const blk of evt.message?.content ?? []) {
      if (blk?.type === "tool_result" && blk.tool_use_id) {
        store.addMessage(chatId, "tool_result", JSON.stringify({ id: blk.tool_use_id, result: boundResult(blk.content), isError: Boolean(blk.is_error) }));
      }
    }
  }
  sse(chatId, evt);
}

// Report of a finished subagent that no waiting call picked up — as a system message to the main agent.
const reportPrompt = (r) => [
  `[Subagent finished: ${r.description || r.agentType} (agentId ${r.agentId}, ${r.provider}${r.resolvedModel ? `/${r.resolvedModel}` : ""}, status ${r.status})]`,
  String(r.report || r.error || "").trim() || "(no report)",
  r.notes ? String(r.notes) : "",
  "",
  "Evaluate the report and continue working. This is a system message, not a user reply."
    + ` Follow-up questions to the same subagent go with cbase_agent_send (agentId ${r.agentId}).`,
].filter(Boolean).join("\n");

// The runtime folder of ONE agent — the core's, unless its record carries ANOTHER instance (picked up after a project
// switch): then the location of ITS project; if the instance no longer exists, the core's. ONE computation for the spec
// factory (MCP file, profile) and the cleanup at the agent's end — otherwise the MCP file of a picked-up agent would
// stay behind in its project's location. Creates nothing.
function locationOfTheAgents(runLocation, coreIdentifier, agentIdentifier) {
  if ((agentIdentifier || null) === coreIdentifier) return runLocation;
  const inst = instanceFromIdentifier(agentIdentifier);
  return inst ? locationFor({ projectId: inst.projectId, converted: true }) : runLocation;
}

// The worktree root for the instance of an identifier "<project>/<instance>". The main instance and "no identifier"
// take the core's location; a copy the location of ITS project (the agent carries its record's identifier, even after
// the chat switched projects) — runs/runtime-location.js checks name and location. Never a fallback to main: an
// identifier outside the form throws.
function worktreeRootTheIdentifier(runLocation, identifier) {
  const instance = typeof identifier === "string" && identifier.includes("/") ? identifier.slice(identifier.lastIndexOf("/") + 1) : "main";
  if (instance === "main") return worktreeRoot(runLocation);
  const pid = projectFromIdentifier(identifier);
  return worktreeRoot(runLocation.projectId === pid ? runLocation : locationForProject(pid), instance);
}

/**
 * Open the core for a chat and enter it as its owner.
 *
 * @param {Object} context  like agentSpecFactory, plus `cwd` (default working folder) and `agentDefs` (raw).
 *        `hold`: does the run kind keep the turn open while an agent lives? Default yes.
 *        `deliver(text)`: the chat's wake path for a completion notice (only needed when not holding).
 *        `booking`: the assignment of the consumption rows (chatId, runId, step) — from the turn opening the core.
 *        `overruled`: the turn opening this core ran under "start anyway" — an ARGUMENT of the turn that applies to
 *        the subagents starting while it runs (see gateForAgent), and to none later.
 * @param {{event:(evt:Object)=>void, atStart?:(rec:Object)=>void, atSwitch?:(rec:Object)=>void, atEnd?:(rec:Object, info:Object, o:{wasLive:boolean})=>void, background?:()=>void}} turn
 *        `background`: report the background event OF THE TURN — a core without a turn in the same chat reports its
 *        changes through it while a turn runs (otherwise it would overwrite the turn's monitors and commands with empty)
 * @param {{frame?: string, own?: boolean, sink?: (evt:Object) => void, workflowAgent?: boolean}} [opts]
 *        `own` (the agents of a dynamic workflow): a core that does not belong to the CHAT — it neither becomes owner
 *        (`agentsOf`, the main agent's agent routes) nor counts as open background work of the chat (`liveAgents`,
 *        cap, bar, server end); it creates no records (no cbase_agent_send continues its agents, and the restart does
 *        not report them as orphaned). Its owner closes it.
 *        `sink`: where its agents' events go (default: history and stream of the chat under the call block).
 *        `workflowAgent` (only with `own`): its agents are workflow agents (see agentSpecFactory) — with the stall
 *        rule of workflow agents (agent-runtime.js workflowStallRule).
 *        `deposit` (only with `own`): `{ remember(image), row(agentId, row) }` like the record deposit — that is how
 *        the owner keeps the parked state of its agents (dynamic workflow journal).
 */
export function openAgents(context, turn, { frame, own = false, sink: ownSink = null, workflowAgent = false, outerLoop = null, deposit: ownDeposit = null } = {}) {
  const { chat, cwd, provider: providerName, tools, agentDefs, limit = null, hold = true, deliver = null, booking = null, overruled = false } = context;
  const chatId = chat.id;
  // An outer-loop run — only in an OWN core (see agentSpecFactory).
  const ol = own && outerLoop?.agentId && outerLoop?.runId ? { agentId: String(outerLoop.agentId), runId: String(outerLoop.runId) } : null;
  const sink = typeof ownSink === "function" ? ownSink : (evt) => underEvent(chatId, evt);
  // This core's runtime folder: that of the turn opening it, otherwise the chat's current one — remembered for its
  // whole life. MCP files, profiles, worktrees, outputs and the cleanup at the agent's end all live HERE, even if the
  // chat has switched projects by now (running subagents stay in the old one).
  const runLocation = createLocation(context.runtime || locationForChat(chat));
  // This core's instance: that of the turn opening it (`null` is a statement too), otherwise from its location.
  const instance = context.instance !== undefined ? context.instance : instanceOfChat(chat, runLocation);
  // This core's PROJECT: the instance's, otherwise the chat's at opening — pinned like location and instance. Idle
  // state and lock of a project ask for it (coresInProject, gateForAgent), not for the project the chat carries NOW:
  // after a project switch its agents keep working here.
  const coreProject = instance?.projectId ? String(instance.projectId) : (chat.projectId ? String(chat.projectId) : null);
  // Since when this core's WORK has been running — the "layout" lock lets through, in `waits`, every subagent whose
  // work began BEFORE the job (otherwise the turn waiting for it would hold the takeover that waits for the turn). The
  // opening time alone is too late for cores continuing old work:
  //   - the core of a graph step (doRun opens a new one per step): the start of its workflow run, the same number
  //     the driver uses to get the step through the lock (workflows/driver.js `parentSince: run.startedAt`) —
  //     otherwise the step got through but its subagents did not;
  //   - a core without a turn picking up parked agents from the records (restart): the start of the oldest picked up
  //     (pickUpParked, below);
  //   - the own core of a dynamic workflow (opened lazily at the first agent()): 0 — there the run's gate judges
  //     BEFORE every start with the run's beginning; workflow agents do not delegate, so nothing else passes this gate.
  // Outside `waits` every start waits anyway — the number only matters there.
  let coreSince = own && workflowAgent ? 0 : Date.now();
  //   - the core of a turn: the start of the turn (`turn.since`, do-run.js) — the resume retry opens a new core for
  //     THE SAME turn.
  if (Number.isFinite(turn?.since) && turn.since > 0) coreSince = Math.min(coreSince, turn.since);
  if (!own && booking?.runId) {
    try {
      const run = store.getWorkflowRun(chatId);
      const begin = run && run.id === booking.runId && !run.endedAt ? Number(run.startedAt) : NaN;
      if (Number.isFinite(begin) && begin > 0) coreSince = Math.min(coreSince, begin);
    } catch { /* without a readable run: the opening time */ }
  }
  // An agent's project: that of its instance identifier (a picked-up agent carries its record's), otherwise the core's.
  const projectOfThe = (identifier) => projectFromIdentifier(identifier) || coreProject;
  const outputFolder = agentOutputs(chatId, runLocation); // durable and readable (runs/outputs.js)
  // "SubagentStop" (see onFinish): the hooks from the settings, in the CORE's shell (its instance, its working
  // folder). Payload: `agent` = type, `result` or for "failed" `error`, at most 4,000 characters each, `cwd`,
  // `session_id` of the chat's session, plus `agent_id`; the matcher checks the type.
  const subagentStopHook = (rep) => {
    if (!rep?.status || rep.status === "running") return;
    const hooks = loadAgentHooks().filter((h) => h.event === "SubagentStop");
    if (!hooks.length) return;
    const type = String(rep.agentType || "");
    const content = rep.status === "failed" ? { error: String(rep.error || "").slice(0, 4000) } : { result: String(rep.report || "").slice(0, 4000) };
    let sessionId = "";
    try { sessionId = store.getChat(chatId)?.claudeSessionId || ""; } catch { /* without a session empty */ }
    fireAgentHook("SubagentStop", { agent: type, agent_id: String(rep.agentId || ""), ...content }, { hooks, instance: instance || null, cwd, name: type, sessionId })
      .catch((e) => console.error("[agent] SubagentStop hook:", e?.message || e));
  };
  const live = new Set(); // agentId of the live subagents
  const reports = [];   // reports still to be delivered to the main agent
  // Which call block does a start belong to? Claude and the loop engine name the id explicitly (MCP `_meta`), Codex
  // does not — there the stream's open blocks decide (runs/call-blocks.js). Never a stack.
  const blocks = createCallBlocks();
  const selected = new Map(); // block → { provisional, stream } between assignment and the core's onStart
  // Events of a PROVISIONALLY assigned subagent wait until its block confirms it — otherwise they would stand in the
  // history, in web and iOS, under a block that turns out to be the wrong one when it closes.
  const buffer = new Map(); // agentId → events
  const gibFree = (agentId, block, reason = "") => {
    const evts = buffer.get(agentId);
    buffer.delete(agentId);
    if (reason && evts?.length) console.warn(`[agent] ${chatId}: ${evts.length} events of ${agentId} ${reason} under ${block}`);
    for (const evt of evts || []) {
      try { sink({ ...evt, parent_tool_use_id: block }); } catch (e) { console.error("[agent] event not processed:", e?.message || e); }
    }
  };
  const provisionalAgent = (block) => {
    for (const agentId of buffer.keys()) if (blocks.blockOf(agentId) === block) return agentId;
    return null;
  };

  // The turn is over, its agents still live (closeAgents with `leaveLive`): from then on the core reports nothing to
  // the turn — its distribution, tick and display no longer exist — and closes itself as soon as the last agent ends.
  let turnPast = false;
  // While detachFromTurn switches the foreground agents: their switches do not report per agent — the turn end reports
  // the survivors afterwards with ONE event (do-run.js finally).
  let switchAtTurnEnd = false;
  // The chat is deleted (closeAgentsOfTheChat): its agents end silently — no completion notice, no more rows in the
  // history; the chat they would go to is gone. BOOKED all the same: the tokens are paid, and usage explicitly keeps
  // deleted chats.
  let silenced = false;
  // The server run ends (agentsAtServerEnd): from here the core writes nothing more to the deposit — its still live
  // agents stay "running" there, and the restart reports them as orphaned, as after a crash.
  let depositFrom = false;
  let ctl = null;

  // Consumption of ONE subagent, booked immediately — with ITS provider, model and billing kind (a subscription
  // subagent in a third-party chat must not land in that price list and vice versa). Duration belongs to the run.
  // Booked is `increase` — what was added since its last booking —, NEVER `usage` (the sum over all its turns): a
  // continuation via cbase_agent_send ends with a second onFinish, and the sum would book the earlier turns again.
  // Without `increase` nothing is booked.
  // The row carries `agent_id` (an outer-loop run overwrites it via `booking` with its agent), the cache separately,
  // the generation ids (OpenRouter) and the booking's STATE in the records: if the process dies in the middle of its
  // next turn, the restart books the rest from its session file, from exactly here (runs/lateBooking.js).
  // An increase WITHOUT tokens but with generation ids is a row too: the only round of an OpenRouter subagent broke
  // off after the response head (stop, network) — without the row the tick would never ask for the amount.
  // After the chat was deleted (`silenced`): the row at the old chatId, but no state in the records (the rows are gone).
  const bookConsumption = (info, agentId = "") => {
    const u = info.increase || {};
    if (!u.input && !u.output && !u.cached && !(Array.isArray(u.generations) && u.generations.length)) return;
    const metered = info.billing === "metered";
    try {
      store.addUsageEvent({
        chatId, runId: "", step: 0, agentId, ...(booking || {}),
        provider: info.provider || providerName,
        model: info.model || "",
        // Reported cost (OpenRouter, USD; null ⇒ the tick asks or estimates), generation ids, the last round's provider.
        ...(metered ? meteredBooking(u) : subscriptionBooking(u)),
        kind: "sub",
        secs: 0,
        upstream: metered ? u.upstream || "" : "",
      });
      if (agentId && !own && !silenced) store.subagentBooked(chatId, agentId, Date.now());
    } catch (e) { console.error("[agent] consumption not booked:", e?.message || e); }
  };

  const runtime = createAgentRuntime({
    chatId,
    cwd,
    parentProvider: providerName,
    // What a subagent without a model inherits: the chat's model at the same provider, otherwise the default — the
    // same resolution as for the main run (`chat.model || defaultModelFor(…)`, runs/do-run.js).
    parentModel: chat.model || "",
    defaultModel: (p) => { try { return defaultModelFor(p) || ""; } catch { return ""; } },
    agentDefs: () => agentDefs,
    hosts: () => agentHosts(),
    resolveRef: (ref, fallback) => resolveModelRef(ref, fallback),
    // Against the chat's set PLUS the workspace skills an applicable workspace agent names in its definition
    // (toolchain/skill-catalog.js skillStock — the same computation as the type's description).
    resolveSkills: (names, def) => skillsResolve(names, skillStock(chat, def, tools.skills)),
    buildSpec: agentSpecFactory(context, { frame, workflowAgent: own && workflowAgent, outerLoop: ol, location: runLocation, instance }),
    instance: instanceIdentifierOf(instance),
    // An instance's management git for the subagents' worktrees — the identifier resolved as in the spec factory (the
    // core's, otherwise instanceFromIdentifier: a picked-up agent carries its record's; if it no longer exists, null).
    // With an instance every git runs in the project container (runs/git-post-work.js).
    gitFor: (identifier) => {
      const inst = (identifier || null) === instanceIdentifierOf(instance) ? instance : instanceFromIdentifier(identifier);
      return inst ? gitInProject(inst) : null;
    },
    frame: "", // the factory appends it
    runChat: (a) => runChat(a),
    // Per identifier — the worktrees folder in main (also without an identifier), a per-copy folder in a copy.
    worktreeRoot: (identifier) => worktreeRootTheIdentifier(runLocation, identifier),
    // The repos for isolation:"worktree" — ONE resolution with the git tree (git.js). Project AND instance of the
    // CORE, not the project the chat carries NOW — the git of `makeWorktree` comes from the core's instance
    // (providers/agent-runtime.js). After a project switch A → B mid-turn, `worktree add` would otherwise run in B on
    // B's repo; the other way round git in B's container on a folder of A. If neither the core nor the current project
    // carries an instance, the current focus project is used (without an ops marker there never is an instance).
    repoCandidates: () => {
      const now = store.getChat(chatId) || chat;
      const focus = focusedProject(now);
      const fromCore = Boolean(instance) || Boolean(focus && instanceOfChat(now)); // the chat's instance
      const proj = !fromCore ? focus : coreProject ? focusedProject({ ...now, projectId: coreProject }) : null;
      // The core's instance — null on the path without an instance (fromCore false).
      return proj?.path ? projectRepos(proj.path, { instance }) : [];
    },
    forkTranscript: () => buildEngineTranscript(chatId, { contextWindow: 0 }),
    // Limit parking per agent: only with the run's limit connections (`context.limit` — they live in the runs cycle
    // this file must not import). Without them an agent fails at the limit.
    atLimit: limit ? (a, errorText, { attempts, sessionId }) => agentLimitChoice({
      errorText, provider: a.provider, model: a.model, sessionId, attempts, chat: store.getChat(chatId) || chat,
    }, limit) : null,
    wakeup,
    stallClock,
    // Workflow agents: 180 s, up to 5 restarts — the same watchdog, parameterised (agent-runtime.js).
    ...(own && workflowAgent ? { stallRule: workflowStallRule } : {}),
    slotMissing: own ? () => null : () => agentCapFull(chatId, chat), // a workflow has its own concurrency cap
    // The records in the database (store/subagents.js): from them cbase_agent_send continues an agent no open core
    // knows any more (restart, idle cleanup). A deleted chat writes nothing more.
    // An own core (dynamic workflow) creates no records — the owner gets the images itself if it passes a deposit
    // (the parked state of a workflow agent belongs in its run's journal).
    deposit: own ? ownDeposit : {
      remember: (image) => { if (!silenced && !depositFrom) store.rememberSubagent(chatId, image); },
      row: (agentId, row) => { if (!silenced && !depositFrom) store.subagentRow(chatId, agentId, row); },
    },
    // The credit gate before EVERY new process (also continuation and follow-up): for the SUBAGENT's provider, the
    // turn's approval only while it runs. A continuation names the approval of the turn sending it (`free`, see
    // ctl.send) — the agent can live in a core of an earlier turn.
    // `instance`: the identifier the agent runs in — the lock judges by ITS project and ITS instance: without an
    // agent identifier the core's, pinned like its project.
    startGate: ({ provider, model, overruled: free, instance: identifier }) => gateForAgent({ chatId, provider, model,
      overruled: free === undefined ? overruled === true && !turnPast : free === true, projectId: projectOfThe(identifier),
      identifier: identifier || instanceIdentifierOf(instance), parentSince: coreSince }),
    atResumptionError: (a, reason) => {
      console.error(`[agent] ${chatId}: continuation of ${a.agentId} after the limit failed:`, reason);
      try {
        store.addMessage(chatId, "hint", T`Subagent "${a.description || a.name}" could not continue after the usage limit: ${String(reason).slice(0, 400)}`);
      } catch { /* the row is information, not a contract */ }
    },
    onEvent: (evt) => {
      // The cbase_agent blocks of a SUBAGENT: stream = its call block. Codex names no id at a grandchild start —
      // there the open blocks of ITS stream decide (runs/call-blocks.js), as for the main run.
      if (evt.parent_tool_use_id) observeUnderBlocks(evt, evt.parent_tool_use_id);
      const waiting = evt.parent_tool_use_id ? provisionalAgent(evt.parent_tool_use_id) : null;
      if (waiting) { buffer.get(waiting).push(evt); return; }
      try { sink(evt); } catch (e) { console.error("[agent] event not processed:", e?.message || e); }
    },
    onStart: (rec) => {
      // The block `start` chose for this call gets its agent — BEFORE the first event.
      const choice = selected.get(rec.parentToolUseId);
      if (choice) {
        selected.delete(rec.parentToolUseId);
        // In the stream the block stands in: a grandchild block stands in its parent agent's substream — without
        // `stream` it would stay "free" there, and a second grandchild would fall onto the same block.
        blocks.bind(rec.parentToolUseId, rec.agentId, { provisional: choice.provisional, stream: choice.stream });
        if (choice.provisional) buffer.set(rec.agentId, []);
      }
      // Every LIVE subagent is background work: it keeps the run open and stands in the agent bar — a foreground
      // agent too (its call can return before it).
      live.add(rec.agentId);
      if (!turnPast) turn.atStart?.(rec);
      else { reportBackground(chatId); setIdle(ctl); } // a grandchild after the turn, a continuation
    },
    // Parked or continued: without a turn there is no tick that would notice the new status.
    onStatus: () => { if (turnPast && !silenced) reportBackground(chatId); },
    // Foreground → background (deadline or button): from now on an ordinary background agent — `/stop`
    // (stopForeground) and the turn end let it live, its report arrives as a completion notice. Only the turn's display
    // needs to learn it; without a turn (a grandchild after the turn) the owner reports the row itself.
    // Its open cards switch with it (approvals.js agentCardsIntoTheBackground) — BEFORE the turn end the switch
    // triggers: otherwise clearChatPermissions declines them as cards of a foreground agent.
    onSwitch: (rec) => {
      agentCardsIntoTheBackground(chatId, rec.agentId);
      if (switchAtTurnEnd) return; // the turn end reports ONCE for all (do-run.js finally)
      if (!turnPast) turn.atSwitch?.(rec); else if (!silenced) reportBackground(chatId);
    },
    // What an agent ended mid-turn reports only AFTER onFinish (agent-runtime.js).
    atLateConsumption: (rec, info) => bookConsumption(info, rec.agentId), // also when silenced (see `silenced`)
    onFinish: (rec, info) => {
      // Profile and MCP file go with it — BEFORE everything else, so an agent vanishing from the bar leaves no traces.
      // The output file stays (until the chat is deleted); a continuation via cbase_agent_send recreates both through
      // buildSpec.
      // In the AGENT's location (locationOfTheAgents) — a picked-up agent of a foreign instance has its traces in its
      // project's location. The core knows its identifier (`instanceOf`); the public image `rec` does not carry it.
      cleanUpAgent(chatId, rec.agentId, { workflowAgent: own && workflowAgent, outerLoop: ol, location: locationOfTheAgents(runLocation, instanceIdentifierOf(instance), runtime.instanceOf(rec.agentId)) });
      // Its open approval cards go with it — whether it finished, failed or was closed with the turn. Wording and
      // origin as at the turn end. A stop via ctl.stop has already declined its cards before.
      clearAgentPermissions(chatId, rec.agentId, "Run ended");
      if (silenced) { bookConsumption(info, rec.agentId); live.delete(rec.agentId); return; } // booked but not reported (see `silenced`)
      // The "SubagentStop" hook: HERE, at the end of every subagent and workflow agent of every provider — `settle`
      // calls onFinish exactly once per end. Not when silenced (the chat is deleted), not for an outer-loop run (it
      // observes, it is no subagent). Not awaited: a hook never stops the core.
      if (!ol) subagentStopHook(info.report);
      bookConsumption(info, rec.agentId);
      // Nobody waited for the report (background agent or expired waiting time). If the turn holds, the report goes
      // into ITS process (reports). Otherwise as a completion notice via the wake path — unless the agent was
      // stopped: a human stop reports itself as a silent hint, the main agent knows its own stop, and an agent ending
      // with its core has nobody left to report to.
      const held = hold && !turnPast;
      if (!info.delivered && info.report) {
        // The report of a child at depth ≥ 2 goes to its PARENT agent while that lives — the same path as
        // cbase_agent_send to a running agent (next tool round; for Codex after its end as a continuation). If it no
        // longer lives, the report goes to the main agent like any other.
        const parent = info.stopped ? "" : runtime.origin(rec.agentId)?.parentAgent || "";
        const toParent = parent ? runtime.message(parent, completionNotice(info.report, { toolUseId: rec.parentToolUseId || "" }), { report: info.report }) : null;
        if (toParent) { /* delivered or handed in later — the parent agent reports itself */ }
        else if (held) reports.push(info.report);
        else if (!info.stopped && deliver) {
          try { deliver(completionNotice(info.report, { toolUseId: rec.parentToolUseId || "" })); }
          catch (e) { console.error("[agent] completion notice not delivered:", e?.message || e); }
        }
      }
      // What was handed in for it and never reached it (it failed, was stopped — also by the human —, or the gate
      // stood in the way) goes to the MAIN AGENT, never into the void: a grandchild report on the same path as one
      // without a live parent agent, a message (cbase_agent_send "after the end") as a "not delivered" system message.
      // The core took them out when emptying — no later path delivers them again.
      for (const e of info.undelivered || []) {
        const text = e.kind === "report" ? e.text
          : notDelivered({ agentId: rec.agentId, name: rec.description || rec.name, status: info.report?.status || rec.status, message: e.text, reason: e.reason });
        if (held) reports.push(e.kind === "report" && e.report ? e.report : { systemText: text });
        else if (deliver) {
          try { deliver(text); } catch (err) { console.error("[agent] handed-in item not delivered:", err?.message || err); }
        }
      }
      // The report also belongs at ITS call block: if that carries only the placeholder, "status: running" would stand
      // there forever. A second tool_result with the same tool_use id overwrites it. The condition is the PLACEHOLDER,
      // not the delivery (a report fetched via cbase_agent_output would otherwise stay blind).
      const onlyPlaceholder = rec.background || !info.delivered;
      if (info.report && rec.parentToolUseId && onlyPlaceholder) {
        // Already delivered elsewhere ⇒ only the NUMBERS follow, otherwise the report would be in the transcript twice.
        const to = info.delivered
          ? { ...info.report, report: "The report was fetched in the same turn via cbase_agent_output and stands there." }
          : info.report;
        // `is_error` ONLY for `status: "failed"` — an abort is a result, not an error.
        // Through the TURN's distribution (display, block assignment) — it is not the run's limit evidence.
        // If the turn is over, through the own sink: row and stream as there, otherwise "status: running" would stand
        // at the block forever.
        const addendum = {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: rec.parentToolUseId,
            content: JSON.stringify(to, null, 2), is_error: info.report.status === "failed" }] },
        };
        if (turnPast) {
          try { sink(addendum); } catch (e) { console.error("[agent] addendum not processed:", e?.message || e); }
        } else turn.event(addendum);
      }
      // The FINISHED agent does not stay here: the agent bar reconstructs it from the history.
      const wasLive = live.delete(rec.agentId);
      // Without a turn the core does NOT close with the last agent: the completion notice wakes a turn, and that one
      // should be able to continue the agent with cbase_agent_send or read it with cbase_agent_output — a closed core
      // no longer knows it. It stays open as long as it knows an agent (closeAgents).
      // The display learns its end all the same: otherwise it would stand as running in bar and sheet forever.
      if (turnPast) {
        if (wasLive) reportBackground(chatId);
        setIdle(ctl); // the last live one is gone: the idle deadline runs from now
        // Not when the server run ends (`depositFrom`): then the work is not finished but interrupted, and the verdict
        // belongs to the restart.
        if (wasLive && !depositFrom && !coresOf(chatId).some((k) => k.liveCount() > 0)) workEmpty(chatId);
        return;
      }
      turn.atEnd?.(rec, info, { wasLive });
    },
  });

  // Pick up an agent this core does not know from the records. Nothing stored ⇒ nothing picked up (the core answers
  // "unknown"). Without a stored session it cannot be continued — the call says so honestly instead of starting an
  // agent without memory with the message alone.
  function fromInventory(idOrName, { resume = false } = {}) {
    if (!idOrName || runtime.has(idOrName)) return;
    const image = store.readSubagent(chatId, idOrName);
    if (!image) return;
    if (resume && !image.sessionId && image.stoppedOf !== "human") {
      throw new Error(`Subagent "${image.agentId}" can no longer be continued: no session of it is stored (it ended`
        + " before its provider reported one). Start it anew with cbase_agent if the subtask is still needed.");
    }
    runtime.pickUp(image);
  }

  // cbase_agent calls in the subagents' streams: open at the tool_use, close at the result.
  const underCalls = new Set();
  function observeUnderBlocks(evt, stream) {
    if (evt.type === "assistant") {
      for (const blk of evt.message?.content ?? []) {
        if (blk?.type === "tool_use" && blk.name === "mcp__cbase__cbase_agent" && blk.id) {
          underCalls.add(blk.id);
          blocks.on(blk.id, blk.input, stream);
        }
      }
    } else if (evt.type === "user") {
      for (const blk of evt.message?.content ?? []) {
        if (blk?.type === "tool_result" && underCalls.has(blk.tool_use_id)) {
          underCalls.delete(blk.tool_use_id);
          ctl.blockTo(blk.tool_use_id, blk.content, stream);
        }
      }
    }
  }

  ctl = {
    chatId,
    location: runLocation, // the core's runtime folder, remembered for its whole life
    instance: instanceIdentifierOf(instance), // the core's instance as an identifier
    project: coreProject, // the core's project (pinned like the instance)
    own, // an own core (dynamic workflow, outer-loop run) — not in `open`, but in `ownCores`
    outerLoop: ol, // `{ agentId, runId }` of an outer-loop run, otherwise null
    // The live agents of this core working in project `pid` (idle state per project).
    liveInProject: (pid) => [...live].filter((agentId) => projectOfThe(runtime.instanceOf(agentId)) === pid)
      .map((agentId) => { const a = runtime.get(agentId); return { agentId, name: a?.name || a?.description || agentId, identifier: runtime.instanceOf(agentId) || null }; }),
    // Does an agent of this core live in instance `identifier` (a picked-up agent carries its record's, a new one the
    // core's)? The fence asks for it.
    aliveInInstance: (identifier) => [...live].some((agentId) => runtime.instanceOf(agentId) === identifier),
    // The instance (identifier) of an agent of this core — `null` if the core does not know it. The agent routes ask
    // for it on a request from a project network (runs/routes.js): the agent must live in the token's instance, not
    // just its chat.
    instanceOf: (agentId) => runtime.instanceOf(agentId),
    // `meta.parentToolUseId`: the explicitly named call id (Claude and engine via `_meta`).
    // Without it the stream decides for Codex, otherwise the start ends with an error — never guessed.
    // `meta.parentAgent`: the calling subagent (from its MCP server's profile) — it determines depth, set and stream
    // of the child. Without it the main agent calls.
    start: async (args, meta = {}) => {
      let block = meta.parentToolUseId || null;
      let provisional = false;
      let depth = 1;
      let parentSet = null;
      let stream = null;          // the stream the call block stands in (null = the main run's)
      let caller = providerName;      // the provider that triggered the start (Codex names no id)
      let parentEffort = "";     // the calling agent's level — "" = the chat's
      let parentProvider = "";   // provider and model of the calling agent — "" = the chat's
      let parentModel = "";
      const parentAgent = meta.parentAgent ? String(meta.parentAgent) : "";
      if (parentAgent) {
        const e = runtime.origin(parentAgent);
        if (!e) throw new Error(`The calling subagent "${parentAgent}" is not known to this chat — no subagent started.`);
        depth = e.depth + 1;
        if (depth > AGENT_DEPTH_MAX) {
          throw new Error(`Depth boundary reached: subagents exist down to level ${AGENT_DEPTH_MAX} below the chat — do the subtask yourself.`);
        }
        // Plus the calling agent's Coding servers: a child never gets more than it — not even via its type.
        parentSet = { ...setFor(context.tools, { parentSet: e.parentSet, tools: e.tools, depth: e.depth }),
          coding: codingSet({ parent: e.parentSet?.coding ?? null, type: e.mcp ?? null, server: context.tools.extraServers }) };
        stream = e.parentToolUseId || null;
        caller = e.provider;
        parentEffort = e.effort || "";
        parentProvider = e.provider || "";
        parentModel = e.model || "";
      }
      if (!block) {
        if (caller !== "codex") {
          console.warn(`[agent] ${chatId}: cbase_agent start without a call id (provider ${caller}) rejected`);
          throw new Error("The start carries no call id (MCP `_meta`) — the subagent could not be assigned to a call block and is not started.");
        }
        const deadline = Date.now() + BLOCK_WAIT_MS;
        for (;;) {
          const r = blocks.assign(args, stream);
          if (r.block) { block = r.block; provisional = r.provisional; break; }
          if (r.error) {
            console.warn(`[agent] ${chatId}: Codex start cannot be assigned — ${r.error}`);
            throw new Error(r.error);
          }
          const rest = deadline - Date.now();
          let clock = null;
          const came = await Promise.race([
            blocks.nextBlock(stream).then(() => true),
            new Promise((res) => { clock = setTimeout(() => res(false), Math.max(0, rest)); }),
          ]);
          clearTimeout(clock);
          if (!came) {
            const reason = "No open cbase_agent call in the stream of this Codex run — the start cannot be assigned to a call block.";
            console.warn(`[agent] ${chatId}: ${reason}`);
            throw new Error(reason);
          }
        }
      }
      selected.set(block, { provisional, stream });
      try {
        return await runtime.start(args, { parentToolUseId: block, outputDir: outputFolder, depth, parentSet, parentAgent, parentEffort, parentProvider, parentModel,
          // The schema of an agent(prompt, {schema}) — only a workflow run passes it.
          ...(meta.structure ? { structure: meta.structure } : {}) });
      } finally {
        selected.delete(block);
      }
    },
    // A follow-up task stays under the block of its start (null = keep the old id). If no core knows the agent any
    // more (restart, idle), it comes from the records.
    // `overruled`: the approval of the SENDING turn (see `approval`) — a continuation asks the gate like a start.
    // `parentAgent`: the calling agent ("" = the main agent), only from cbase_agent_send.
    send: (args, { overruled: free, parentAgent } = {}) => {
      fromInventory(args.agentId || args.to || args.name, { resume: true });
      return runtime.send({ ...args, parentToolUseId: null }, { overruled: free === true, ...(parentAgent === undefined ? {} : { parentAgent }) });
    },
    // Does this core's turn run under "start anyway"? The approval a start from it carries — and a continuation it sends.
    approval: () => overruled === true && !turnPast,
    output: (args, meta) => { fromInventory(args.agentId || args.task_id || args.name); return runtime.output(args, meta); },
    // A stopped agent takes exactly ITS open cards along — with the wording of a stop, BEFORE the signal (settle ⇒
    // onFinish would otherwise find them as "Run ended"). The main run's cards stay open.
    stop: (id, opts) => {
      const a = runtime.get(id);
      if (a) clearAgentPermissions(chatId, a.agentId, T("Agent stopped"), "stop");
      return runtime.stop(id, opts);
    },
    // Restart of ONE running agent (workflow agents): the old attempt takes its open cards along like a stop — its
    // process ends, an answer would find nobody.
    restart: (id) => {
      const a = runtime.get(id);
      const r = runtime.restart(id);
      if (r.ok && a) clearAgentPermissions(chatId, a.agentId, T("Agent restarted"), "stop");
      return r;
    },
    // "Into the background" button: a foreground agent switches immediately, its waiting call returns.
    intoTheBackground: (id) => runtime.intoTheBackground(id),
    // A message to an agent of a dynamic workflow: never a continuation of a finished one — "delivered" |
    // "after_end" | null (agent-runtime control).
    control: (id, text, entry) => runtime.control(id, text, entry),
    get: (id) => runtime.get(id),
    origin: (id) => runtime.origin(id),
    stallState: (id) => runtime.stallState(id),
    list: () => runtime.list(),
    types: () => runtime.types(),
    hosts: () => agentHosts(),
    close: () => {
      ownCores.delete(ctl);
      // What stayed unconfirmed to the end stands under its provisional block — with a log line, not silently.
      for (const agentId of [...buffer.keys()]) gibFree(agentId, blocks.blockOf(agentId), "unconfirmed");
      return runtime.close();
    },
    // The turn ends, its live agents stay (see `turnPast`). A foreground agent of the main agent thereby loses the call
    // that waited for it (turn end, also through `run_error`) — it switches to the background, the same transition as
    // the button. Not a foreground grandchild: its parent agent waits for it, not the turn.
    releaseFromTurn: () => {
      switchAtTurnEnd = true;
      try {
        for (const agentId of [...live]) {
          const h = runtime.origin(agentId);
          if (h && !h.parentAgent && runtime.get(agentId)?.background !== true) runtime.intoTheBackground(agentId, "turn-end");
        }
      } finally { switchAtTurnEnd = false; }
      turnPast = true;
    },
    // The background event of the turn this core hangs on (null without a turn) — see reportBackground.
    reportTurn: () => { if (turnPast || typeof turn.background !== "function") return false; turn.background(); return true; },
    // The chat is deleted: the agents end without a completion notice (see `silenced`).
    silence: () => { silenced = true; },
    // The server run ends: the deposit stays as it is (see `depositFrom`).
    depositHalt: () => { depositFrom = true; },
    // `/stop`: the turn ends with its FOREGROUND agents; background agents run on. A foreground agent is one a call
    // waits for (`run_in_background: false`) — without the turn nobody waits.
    // Not a foreground GRANDCHILD — its parent agent waits for it, not the turn (the same set as releaseFromTurn). If
    // the parent agent lives on in the background, the grandchild keeps working too; if the parent agent ends here, the
    // grandchild switches to the background with its end (agent-runtime.js) and stays continuable.
    stopForeground: () => {
      for (const agentId of [...live]) {
        if (runtime.get(agentId)?.background === true || runtime.origin(agentId)?.parentAgent) continue;
        clearAgentPermissions(chatId, agentId, T("Agent stopped"), "stop");
        runtime.stop(agentId, { ofHuman: true });
      }
    },
    // From the turn's distribution: a cbase_agent call block opens or closes (stream = parent id, null for the main
    // stream). On closing, the result confirms or swaps a provisional assignment.
    blockOpen: (toolUseId, input, stream = null) => blocks.on(toolUseId, input, stream),
    blockTo: (toolUseId, content, stream = null) => {
      for (const { agentId, block, confirmed } of blocks.close(toolUseId, content, stream)) {
        runtime.reattach(agentId, block);
        if (confirmed) gibFree(agentId, block);
      }
    },
    // Pick up a PARKED agent from the records (only in a core without a turn, see coreWithoutTurn in do-run.js):
    // afterwards it stands parked and live in the core, with its wakeup — as before the restart. Returns the public
    // record; if it is NOT parked afterwards (no continuation time), it only stays known.
    pickUpParked: (image) => {
      const a = runtime.pickUp(image);
      // The continuation of a picked-up agent is work from back then (see `coreSince` above).
      const began = Number(image?.startedAt);
      if (Number.isFinite(began) && began > 0) coreSince = Math.min(coreSince, began);
      if (a.status === "parked") {
        live.add(a.agentId);
        reportBackground(chatId);
      }
      setIdle(ctl);
      return a;
    },
    liveCount: () => live.size,
    // Continuable agents of this core: every one it knows — a finished one or one stopped by the agent continues via
    // cbase_agent_send (one stopped by the human declines there but stays known).
    knownCount: () => runtime.list().length,
    // Does this agent (id or name) live in THIS core? A finished one still stands in the core but does not live.
    alive: (id) => { const a = runtime.get(id); return Boolean(a && live.has(a.agentId)); },
    // Does the core still hang on its turn? After `releaseFromTurn` the wake path delivers its reports, not the turn.
    inTurn: () => !turnPast,
    // Is a turn holding these agents right now (run kind with holding, turn still on)?
    held: () => hold && !turnPast,
    // The live agents that "stop all background agents" hits: those started in the background — and in a core without
    // a turn every live one (there is no foreground left that a call waits for).
    backgroundIds: () => [...live].filter((agentId) => turnPast || runtime.get(agentId)?.background === true),
    // The live subagents in the shape web and iOS read — rebuilt on EVERY report (tokens, tool count and status grow
    // in the event stream).
    rows: () => {
      const out = [];
      for (const agentId of live) {
        const a = runtime.get(agentId);
        if (!a) continue; // empty is not unknown: without a record nothing is claimed
        out.push({
          taskId: a.agentId,
          agentId: a.agentId,
          // The call block this subagent hangs under in the history (joining live report and block).
          toolUseId: a.parentToolUseId || "",
          description: a.description || a.name || "",
          name: a.name || "",
          provider: a.provider || "",
          model: a.model || "",
          status: a.status || "running",
          // Parked at the usage limit: when it continues and when the window resets — ONLY on a parked agent (a running
          // agent's row stays byte-identical, golden `subagent`).
          ...(a.status === "parked" ? { parkedUntil: a.parkedUntil || 0, resetsAt: a.resetsAt || 0 } : {}),
          startedAt: a.startedAt || 0,
          tokens: a.tokens || 0,
          tokenKind: a.tokenKind || "only_output",
          toolUses: a.toolUses || 0,
          // A foreground agent (a call waits for it) carries the marker — for the "into the background" button in web
          // and iOS. A background agent's row stays byte-identical (golden `subagent-background`).
          ...(a.background === true ? {} : { foreground: true }),
          // CPU saver: only while a Bash command waits for CPU before starting — otherwise byte-identical.
          ...(a.waitingForCpu === true ? { waitingForCpu: true } : {}),
        });
      }
      return out;
    },
    reportsOpen: () => reports.length,
    takeReports: () => reports.splice(0),
    createBack: (batch) => { reports.unshift(...batch); },
    // An entry with `systemText` is a finished system message (a message never delivered), not a report.
    reportText: (batch) => batch.map((b) => b.systemText || reportPrompt(b)).join("\n\n---\n\n").slice(-120_000),
  };
  if (!own) {
    owner.set(chatId, ctl);
    open.add(ctl);
  } else ownCores.add(ctl);
  return ctl;
}

// A subagent's browser profile — also its identifier in the MCP environment (CBASE_PROFILE_KEY). The cbase MCP
// server's permission prompt sends it along; runs/routes.js reads the requesting agent from it.
// Web and iOS rely on the scheme "<chat>-agent-<agentId>" (a web test is bound to EXACTLY this line). An outer-loop
// run has its OWN profile `<chat>-outerloop-<agentId>-<runId>` — it is no subagent of the chat, and
// browser-profiles.js never reads a name without "-agent-" as a subagent browser.
const profileKeyValue = (chatId, agentId) => `${chatId}-agent-${agentId}`;
const outerLoopProfile = (chatId, ol) => `${chatId}-outerloop-${ol.agentId}-${ol.runId}`;
const profileOf = (chatId, agentId, outerLoop = null) => (outerLoop ? outerLoopProfile(chatId, outerLoop) : profileKeyValue(chatId, agentId));

// What a subagent leaves behind outside the output file: its MCP configuration (agentSpecFactory), its Chromium
// profile with the two Playwright configs (toolchain/mcp-config.js → prepareChatProfile). One list — whoever adds a
// trace enters it here.
// An agent's MCP configuration — `<chat>.agent-<id>.mcp.json`, for a workflow agent
// `<chat>.agent-<id>.workflow.mcp.json`. The name is in the Claude CLI's command line (`--mcp-config`) and is the
// PROCESS MARKER there by which the deploy's oneshot detection tells a workflow agent from a subagent (the deploy
// waits for subagents, not for workflows; Codex carries the marker as `mcp_servers.cbase.env.CBASE_WORKFLOW_AGENT=…`).
// Prefix and suffix stay so the closing path (chat deletion) catches both forms. The folder is the core's runtime
// folder (`location`; without it the chat's current one) — the name stays the same everywhere.
// An outer-loop run: `<chat>.outerloop-<agentId>-<runId>.mcp.json` — does not match the workflow-agent pattern, the
// deploy counts it as busy (it has no journal).
export const agentMcpFile = (chatId, agentId, { workflowAgent = false, outerLoop = null, location = locationForChat(chatId) } = {}) =>
  agentMcpFileIn(location, chatId, agentId, { workflowAgent, outerLoop });

export function agentTraces(chatId, agentId, { workflowAgent = false, outerLoop = null, location = locationForChat(chatId) } = {}) {
  const profile = chatProfileDir(playwrightProfileRoot(location), profileOf(chatId, agentId, outerLoop));
  return [
    agentMcpFile(chatId, agentId, { workflowAgent, outerLoop, location }),
    profile,
    playwrightConfigPath(profile, true),
    playwrightConfigPath(profile, false),
  ];
}

/**
 * Clean up at the agent's end. If a trace fails (ENOTEMPTY: a child — Chromium, the MCP server — still writes into
 * it), that is WARNED, not hidden and not thrown: the agent's end does not depend on the cleanup.
 * @returns {string[]} the warnings (empty = all gone)
 */
// Default for `rm`: in the runtime folder — the project container still runs at the agent's end and mounts it rw — via
// pinned folders (runs/runtime-write.js; a recursive `fs.rmSync` is a rimraf over path names and would follow a part
// the container swaps for a link in between), otherwise fs.rmSync.
const removeAgentLane = (p, o) => { if (!removeInRuntimeFolder(p)) fs.rmSync(p, o); };
export function cleanUpAgent(chatId, agentId, { rm = removeAgentLane, warn = console.warn, workflowAgent = false, outerLoop = null, location = locationForChat(chatId) } = {}) {
  airlockExpiry(chatId, agentId); // this agent's run token of the Coding MCP airlock
  const warnings = [];
  for (const p of agentTraces(chatId, agentId, { workflowAgent, outerLoop, location })) {
    try { rm(p, { recursive: true, force: true }); }
    catch (e) {
      const w = `[agent] ${chatId}: cleanup of ${agentId} incomplete — ${p} (${e?.code || e?.message || e})`;
      warnings.push(w);
      try { warn(w); } catch { /* the warning must not topple the end */ }
    }
  }
  return warnings;
}

/**
 * Remove the worktrees of a chat's subagents when the chat falls. The only caller is the closing path (chat deletion),
 * AFTER closing the cores and BEFORE the records are deleted — the records name folder and repo. A changed worktree
 * stays at the agent's end (agent-runtime.js releaseWorktree), and its name does not carry the chat id — without this
 * step it would stay forever after the deletion. Only in the runtime folder of a converted project: "nothing of the
 * chat left after deletion" is the runtime folder's promise; a flat worktree stays, and without a project location
 * not even the records are read. Unregister with git (the branch stays), then the rest via removeTrace (root-owned ⇒
 * `rootFallback`). Never throws.
 * The row step of the closing path reads the entries BEFORE the records are deleted (`agentWorktreeEntries`) and
 * passes them as `opts.entries` — removal happens afterwards.
 * @returns {string[]} the warnings
 */
export function cleanUpAgentsWorktrees(chatId, opts = {}) {
  const { entries = null, ...rest } = opts;
  return cleanUpWorktreesInRuntimeFolder(chatId, () => entries || agentWorktreeEntries(chatId), { ...rest, who: "subagents" });
}

/** The worktrees of a chat's subagents from their records: `[{ dir, repo, agentId }]` (read-only; throws if the store throws). */
export function agentWorktreeEntries(chatId) {
  return store.subagentsOf(chatId).map((image) => {
    const wt = image.worktree && typeof image.worktree === "object" ? image.worktree : null;
    return { dir: wt?.dir, repo: wt?.repo, agentId: image.agentId };
  });
}

// A worktree's repo from its `.git` file ("gitdir: <repo>/.git/worktrees/<name>", next to it `commondir`) — for
// entries knowing only the folder (journal of a dynamic workflow). "" ⇒ unknown (then only remove, no unregistering).
// WITH an instance the project container creates both files — `.git` as a link would read a backend file, as a FIFO
// it would stall the backend when the chat is deleted, and `gitdir` could point `commondir` anywhere. Hence via the
// checked descriptor within the instance's area (runs/runtime-limit.js readInRuntimeFolder: project and runtime
// folder, regular files only, O_NONBLOCK); what is not there is unknown. Without an instance a plain read.
function repoOfOneWorktrees(dir, inst = null) {
  const read = (p) => readInRuntimeFolder(p, { instance: inst || null, encoding: "utf8" });
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(read(path.join(dir, ".git")));
    if (!m) return "";
    const gitdir = path.resolve(dir, m[1].trim());
    let common = path.dirname(path.dirname(gitdir));
    try { common = path.resolve(gitdir, read(path.join(gitdir, "commondir")).trim()); } catch { /* older git: two levels */ }
    return path.basename(common) === ".git" ? path.dirname(common) : common;
  } catch { return ""; }
}
/** Test seam. */
export const _repoOf_oneWorktrees = repoOfOneWorktrees;

/**
 * Remove a chat's worktrees in the runtime folder of a converted project — the ONE computation for the subagents
 * (cleanUpAgentsWorktrees) and the agents of its dynamic workflows (their worktrees stand only in the run's journal).
 * `supply()` returns `{ dir, repo?, agentId }` and is only asked if there is a project location at all. Only the
 * location's worktrees root with `agent-<aid>`; a flat worktree stays.
 * The worktrees of a COPY are NEVER touched by this path — neither git nor files, neither in main nor in the copy:
 * clearing the copy away first secures its work and then removes the location itself; deleting before would be a
 * loss, and a `worktree prune` in main would hit the wrong repo. Hence only the location's own worktrees root is searched.
 * Unregister with git (the branch stays), then the rest via removeTrace (root-owned ⇒ `rootFallback`).
 * If the location has an instance (converted project), NO git runs in the backend — the step goes as a teardown job
 * into the project container (runs/git-post-work.js worktreeTeardown: checked, removed only if unchanged, the branch
 * stays; if the container is stopped, into the post-work), and only afterwards, if it was unchanged, the rest via
 * removeTrace. A worktree with changes stays — with a warning. If the instance is not readable, it stays as well.
 * Never throws. @returns {string[]} the warnings (those of the jobs in the container come later, on the console)
 */
export function cleanUpWorktreesInRuntimeFolder(chatId, supply, { rootFallback = null, warn = console.warn, who = "agents" } = {}) {
  const warnings = [];
  try {
    const locations = allLocations().filter((o) => o.projectId);
    if (!locations.length) return warnings;
    const seen = new Set();
    for (const e of supply() || []) {
      const dir = typeof e?.dir === "string" ? e.dir : "";
      if (!dir || seen.has(dir) || path.basename(dir) !== `agent-${e.agentId}`) continue;
      seen.add(dir);
      const location = locations.find((o) => path.dirname(dir) === o.worktrees);
      if (!location) continue;
      // With an instance in the project container, as a job. The instance BEFORE the repo: it determines how the
      // `.git` file is read (repoOfOneWorktrees).
      let inst = null;
      try { inst = instanceForProject(location.projectId); } catch (err) {
        const w = `[agent] ${chatId}: worktree ${dir} stays — the instance of ${location.projectId} is not readable (${err?.message || err}), no git in the backend`;
        warnings.push(w);
        try { warn(w); } catch { /* see below */ }
        continue;
      }
      const repo = typeof e.repo === "string" && e.repo ? e.repo : repoOfOneWorktrees(dir, inst);
      if (inst) {
        withOpen(worktreeTeardown(inst, { who: `worktree of the ${who} (chat deleted)`, worktrees: [{ repo, dir }] }).then((r) => {
          if (r.changed) { warn(`[agent] ${chatId}: worktree of the ${who} with changes stays: ${dir}`); return; }
          if (r.postWork || !fs.existsSync(dir)) return;
          const w = removeTrace(dir, location, { rootFallback, warn });
          if (w) warn(w);
        }).catch((err) => warn(`[agent] ${chatId}: worktree ${dir}: ${err?.message || err}`)));
        continue;
      }
      const unregistered = unregisterWorktree({ dir, repo });
      if (!fs.existsSync(dir)) continue;
      const w = removeTrace(dir, location, { rootFallback, warn });
      if (w) warnings.push(w);
      else if (!unregistered) unregisterWorktree({ dir, repo }); // the folder is gone — `prune` clears the entry
    }
  } catch (e) {
    const w = `[agent] ${chatId}: worktrees of the ${who} not cleaned up — ${e?.message || e}`;
    warnings.push(w);
    try { warn(w); } catch { /* the warning must not topple the closing path */ }
  }
  return warnings;
}

// The credit gate for a subagent start — the same hook as for every oneshot (setStartGate in server.js), with
// `purpose: "agent"`. The model is the one the subagent runs with — resolved in the core (a model-specific window
// must know which model runs). → null (start) or the error text.
// `projectId`: the project the agent runs in (see openAgents `projectOfThe`) — the per-project lock judges by it
// instead of the project the chat carries by now. Without a project the field is missing.
// `identifier`: the instance for it — only with a project, and only if it belongs to it.
// `parentSince`: since when the core's work has been running (openAgents `coreSince`) — only the "layout" lock reads it.
async function gateForAgent({ chatId, provider, model, overruled, projectId = null, identifier = null, parentSince = null }) {
  const withIdentifier = projectId && identifier && projectFromIdentifier(identifier) === String(projectId);
  const u = await startGateVerdict({ provider, model: model || "", chatId, purpose: "agent", overruled,
    ...(projectId ? { projectId } : {}), ...(withIdentifier ? { identifier } : {}), ...(Number.isFinite(parentSince) ? { parentSince } : {}) });
  if (u && u.ok === true) return null;
  // The per-project lock answers at the same gate with its own reason (relocation, start, error, server end).
  if (u?.project) return String(u.text || "");
  const window = u?.window?.label || u?.window?.group || "?";
  const percent = typeof u?.percent === "number" ? u.percent : 100;
  return T`Credit gate: ${window} is at ${percent} % (threshold ${limits.START_GATE_PERCENT} %) — no subagent started (${provider}). Do not retry: the gate admits no new agent until the reset. The human can switch the credit gate off or release a turn with “Start anyway”.`;
}

// Who owns an approval card? `null` = the main run, otherwise `{ id, background }`. Searched in ALL open cores of the
// chat (a background agent can live in a core whose turn is over). If none knows the agent, it stays foreground — then
// the turn end at the latest declines its card; without an owner it would hang forever.
// `background` means "as seen from the TURN": the card survives the turn end, and without a turn it comes into being.
// That holds for a background agent, for a grandchild (its parent agent waits for it, not the turn — it survives the
// turn end, releaseFromTurn leaves it) and for every agent in a core whose turn is over.
export function agentAsOwner(chatId, agentId) {
  if (!agentId) return null;
  for (const k of open) {
    if (k.chatId !== chatId) continue;
    const a = k.get(agentId);
    if (a) return { id: a.agentId, background: a.background === true || Boolean(k.origin(a.agentId)?.parentAgent) || !k.inTurn() };
  }
  return { id: String(agentId), background: false };
}

// The requesting agent of an MCP request (permission prompt): the profile `<chat>-agent-<id>` ⇒ the agent; no or a
// foreign profile ⇒ the main run (`null`).
export function agentFromProfile(chatId, profileKey) {
  const prefix = profileKeyValue(chatId, "");
  const key = typeof profileKey === "string" ? profileKey : "";
  if (!key.startsWith(prefix) || key.length === prefix.length) return null;
  return agentAsOwner(chatId, key.slice(prefix.length));
}

// A chat's core — reachable without a running turn too (the routes ask here, not the turn).
export function agentsOf(chatId) {
  return owner.get(chatId) || null;
}

/**
 * Who calls the agent routes? The MCP server's profile (`ofProfile`) names a subagent ⇒ its core (the one it LIVES
 * in — its turn can be over) and its agentId as the parent agent. No or a foreign profile ⇒ the main agent (`null`):
 * the route then takes the chat's owner.
 * @returns {null | {core: Object|null, parentAgent: string}}
 */
export function callerOf(chatId, ofProfile) {
  const who = agentFromProfile(chatId, ofProfile);
  if (!who) return null;
  const cores = coresOf(chatId);
  const core = cores.find((k) => k.alive(who.id)) || null;
  return { core, parentAgent: who.id };
}

// Does `targetId` belong to the children of `parentAgent`? A subagent leads only ITS children (message, report, stop)
// — not the siblings the main agent started. If the core no longer knows the child (idle cleanup, restart), the same
// statement from the records counts (store/subagents.js): otherwise only the main agent could bring back a
// cleaned-up grandchild — fromInventory then picks it up into the parent agent's core.
export function isChildOf(core, targetId, parentAgent) {
  const h = core?.origin?.(targetId);
  if (h) return h.parentAgent === parentAgent;
  const image = core?.chatId && targetId ? store.subagentHeader(core.chatId, targetId) : null;
  return Boolean(image && image.agentId === targetId && image.parentAgent === parentAgent);
}

// ── Stop without a turn ───────────────────────────────────────────────────────────────────────────────────────
// The routes ask the OWNER, not the running turn: an agent can live in a core whose turn is over (and which a new
// turn has already replaced in `owner`) — hence the search covers all open cores of the chat.
const coresOf = (chatId) => [...open].filter((k) => k.chatId === chatId);

// A human stop that no turn delivers as a report announces itself as a SILENT hint in the next turn (runs/hints.js):
// no waking, no queueing. "Stopped by the human" is delivered on only two paths — as the result of the waiting call
// of a FOREGROUND agent in the running turn and via the reports of a HOLDING turn (special chats, graph chats); there
// a hint would be the same message twice. A background agent in a turn that does not hold (the Coding chat) has
// neither: its call returned with "running", and for a stopped one onFinish delivers no completion notice — so the
// hint is deposited with or without a turn.
// A stop by the main agent (`cbase_agent_stop`) reports nothing: it knows.
function stopInCore(chatId, core, agentId, { ofHuman }) {
  const a = core.get(agentId);
  const ran = core.alive(agentId);
  const delivered = core.held() || (core.inTurn() && a?.background !== true);
  const ok = core.stop(agentId, { ofHuman });
  if (ok && ran && ofHuman && !delivered && a) {
    const who = a.name || a.description || a.agentId;
    depositHint(chatId, `The subagent "${who}" (agentId ${a.agentId}) was stopped by the human. No result — `
      + "what it had until then is in its output file.", { source: "agent-stop" });
  }
  return { ok, agentId: a?.agentId || String(agentId) };
}

/**
 * Stop an agent — with or without a running turn.
 * `core`: the core resolveAgent found for this agent — then EXACTLY that one counts. Without it: a live hit before a
 * known one, a newer core before an older one (the same order as coreWithAgent, so that with equal names stop hits
 * the same agent as send/output).
 * @returns {null | {ok: boolean, agentId: string}}  null ⇒ the chat has no open core at all
 */
export function stopAgent(chatId, agentId, { ofHuman, core: named = null }) {
  const cores = coresOf(chatId).reverse();
  if (!cores.length) return null;
  const core = (named && cores.includes(named) ? named : null)
    || cores.find((k) => k.alive(agentId)) || cores.find((k) => k.get(agentId)) || owner.get(chatId) || cores[0];
  return stopInCore(chatId, core, agentId, { ofHuman });
}

/**
 * Which subagent does an id or a name mean? ONE rule for send, output and stop over all open cores of the chat and
 * the records — a short name like "agent-1" (counted anew per core) must not hit a different agent depending on the path.
 *   - An exact agentId counts (a live entry before a known one, a newer core before an older one).
 *   - A name: per core its bearer (the youngest, like runtime.find), plus the records (like fromInventory: the newest)
 *     — the caller's OWN children first (`parentAgent`, "" = the main agent), then a live one before a known one.
 *     If several remain, the name is ambiguous: error (status 400) with the candidates, never guessed.
 *   - `onlyInstance` (the fence's identifier, null = the backend; missing = without a fence): a NAME counts only among
 *     the agents of this instance — otherwise a copy's short name would become ambiguous as soon as a main core
 *     carries the same one (every core counts the default names `agent-N` anew), and the error would name id and
 *     description of the foreign agent that GET /agents hides. If the name hits ONLY foreign agents (or the exact id a
 *     foreign one), one of them comes back — the route's instance check then answers 403.
 * @returns {null | {agentId: string, core: Object|null}}  null ⇒ nobody knows it; `core` null ⇒ only in the records
 */
export function resolveAgent(chatId, idOrName, { parentAgent = "", onlyInstance } = {}) {
  const key = String(idOrName || "").trim();
  if (!key) return null;
  const candidates = [];
  const alongside = (c) => { if (!candidates.some((x) => x.agentId === c.agentId)) candidates.push(c); };
  const cores = coresOf(chatId).reverse();
  for (const k of [...cores.filter((k) => k.alive(key)), ...cores]) {
    const a = k.get(key);
    if (a) alongside({ agentId: a.agentId, core: k, description: a.description || a.name || "", status: a.status || "", parent: k.origin(a.agentId)?.parentAgent || "", alive: k.alive(a.agentId), instance: k.instanceOf(a.agentId) || null });
  }
  // An exact id that a core knows does not need the records.
  const inCore = candidates.find((c) => c.agentId === key);
  if (inCore) return { agentId: inCore.agentId, core: inCore.core };
  const image = store.subagentHeader(chatId, key);
  if (image) alongside({ agentId: image.agentId, core: null, description: image.description || image.name || "", status: image.state || "", parent: image.parentAgent || "", alive: false, instance: typeof image.instance === "string" && image.instance ? image.instance : null });
  if (!candidates.length) return null;
  const exactly = candidates.find((c) => c.agentId === key);
  if (exactly) return { agentId: exactly.agentId, core: exactly.core };
  let choice = candidates;
  if (onlyInstance !== undefined) {
    const here = choice.filter((c) => c.instance === (onlyInstance ?? null));
    if (!here.length) return { agentId: choice[0].agentId, core: choice[0].core };
    choice = here;
  }
  const own = choice.filter((c) => c.parent === String(parentAgent || ""));
  if (own.length) choice = own;
  const live = choice.filter((c) => c.alive);
  if (live.length) choice = live;
  if (choice.length === 1) return { agentId: choice[0].agentId, core: choice[0].core };
  const list = choice.map((c) => `${c.agentId} (${c.description || "?"}, ${c.status || "?"})`).join("; ");
  const error = new Error(T`The name "${key}" is ambiguous — it matches ${choice.length} subagents of this chat. Give the agentId: ${list}`);
  error.status = 400;
  error.candidates = choice.map((c) => c.agentId);
  throw error;
}

/**
 * The instance (identifier, null = the backend) in which an operation with `targetId` in core `core` takes effect —
 * EXACTLY the path of send/output: if the core knows the agent, its entry (null means the backend, no fallback to the
 * core's instance); otherwise the records like fromInventory. Asking memory alone would treat a main agent that only
 * stands in the records (idle closing, deploy) as "same instance", and a copy token would continue it in main.
 * `undefined` ⇒ nobody knows it (the operation then fails itself as "unknown").
 */
export function instanceOfTheTarget(chatId, core, targetId) {
  if (core?.get?.(targetId)) return core.instanceOf(targetId) || null;
  const image = targetId ? store.subagentHeader(chatId, targetId) : null;
  if (!image) return undefined;
  return typeof image.instance === "string" && image.instance ? image.instance : null;
}

/**
 * Send a foreground agent to the background — searched in all open cores of the chat, a live hit first (as for stop).
 * @returns {null | {ok: boolean, agentId?: string, background?: boolean, reason?: string}}  null ⇒ no open core
 */
export function sendIntoTheBackground(chatId, agentId) {
  const cores = coresOf(chatId);
  if (!cores.length) return null;
  const core = cores.find((k) => k.alive(agentId)) || cores.find((k) => k.get(agentId)) || null;
  if (!core) return { ok: false, agentId: String(agentId), reason: "unknown" };
  return core.intoTheBackground(agentId);
}

/** Stop all background agents of THIS chat (no other chat is asked). Returns the stopped ids. */
export function stopBackgroundAgents(chatId, { ofHuman }) {
  const stopped = [];
  for (const core of coresOf(chatId)) {
    for (const agentId of core.backgroundIds()) {
      if (stopInCore(chatId, core, agentId, { ofHuman }).ok) stopped.push(agentId);
    }
  }
  return stopped;
}

// ── The display of live agents ────────────────────────────────────────────────────────────────────────────────
// A background agent lives beyond its turn. What web and iOS know about it therefore comes from the OWNER, not the
// running turn: the connection event (reload), every turn's background event and the reports of a core without a
// turn read the same rows.

// Project switch: live subagents stay in their core's instance — a turn in ANOTHER one deposits a silent hint for the
// main agent (runs/hints.js), ONCE per situation (chat, new instance, agents there), so that not every further turn
// repeats the same sentence. Without an instance on both sides nothing happens.
const elsewhereReported = new Map(); // chatId → key of the situation reported last
const whereInstance = (k) => (k ? `in the project container ${k}` : "in the backend (without a project container)");
export function reportAgentsElsewhere(chatId, inst) {
  const identifier = instanceIdentifierOf(inst);
  const elsewhere = [];
  for (const k of coresOf(chatId)) {
    if ((k.instance || null) === identifier) continue;
    for (const z of k.rows()) elsewhere.push({ name: z.name || z.agentId, agentId: z.agentId, instance: k.instance || null });
  }
  const key = elsewhere.length ? `${identifier}|${elsewhere.map((a) => `${a.agentId}@${a.instance}`).sort().join(",")}` : "";
  if (!key) { elsewhereReported.delete(chatId); return 0; }
  if (elsewhereReported.get(chatId) === key) return 0;
  elsewhereReported.set(chatId, key);
  const text = `This chat now works ${whereInstance(identifier)}. These subagents keep running where they were started — ` +
    `their paths and processes belong there: ${elsewhere.map((a) => `${a.name} (${a.agentId}) ${whereInstance(a.instance)}`).join("; ")}.`;
  return depositHint(chatId, text, { source: "instance-switch" });
}

// The same hint for the TURN: if the project switched while a turn ran, it kept running in its instance to its end
// (runs/instance.js pinTurn). A silent hint never reaches the running turn but the next one — which learns here where
// the previous one ran, if that is another instance than its own. Once per switch (the marker falls on reading).
// Without an instance on both sides nothing happens.
export function reportTurnElsewhere(chatId, inst) {
  const prior = switchAfterTurn(chatId);
  const identifier = instanceIdentifierOf(inst);
  if (!prior || (prior.identifier || null) === identifier) return 0;
  // If not the project switched but the chat's copy (moving in at ready, moving out at removed), the sentence says so.
  const whereby = prior.reason === "copy" ? "This chat's copy became ready or was cleared away" : "This chat's project switched";
  const text = `${whereby} while the previous turn was running. That turn kept running to its end ` +
    `${whereInstance(prior.identifier)}; this turn works ${whereInstance(identifier)}. What the previous turn started there or ` +
    `created outside the chat folder (processes, files) belongs there.`;
  return depositHint(chatId, text, { source: "instance-switch" });
}

/**
 * Does a LIVE subagent of chat `chatId` work in instance `identifier` (its record's identifier), or is an own core of
 * a dynamic workflow of this chat open on it (its next agent() starts there)? The fence thereby admits calls from this
 * instance to the chat's routes even after the chat switched projects — only for THIS chat and only for this
 * instance. The running turn is asked by the fence in runs/instance.js.
 */
export function chatAliveInInstance(chatId, identifier) {
  if (!chatId || !identifier) return false;
  const id = String(chatId);
  for (const k of [...open, ...ownCores]) {
    if (k.chatId !== id) continue;
    if ((k.own && k.instance === identifier) || k.aliveInInstance(identifier)) return true;
  }
  return false;
}

/**
 * Does an open core of this chat at ANOTHER runtime folder than `location` still know an agent — a finished one too?
 * A core remembers its location for its whole life, and `cbase_agent_send` continues a finished agent in THIS core:
 * its output file (`outputFile`) is an absolute path at the old location. If the move took it away first, the
 * continuation would write a newer version at the old location and the next move would lose it. Hence such a core
 * counts when deferring the move (do-run.js) — until it closes (with the chat, the server or after idling); then the
 * next turn catches up. The rest (an agent continued from the records afterwards) is caught by the merge: the younger
 * file wins.
 */
export function coresElsewhereWithAgents(chatId, location) {
  const id = String(chatId);
  return [...open, ...ownCores].some((k) => k.chatId === id && k.location?.root !== location?.root && k.knownCount() > 0);
}

/**
 * Who works in project `projectId` — by the project of the CORES, not the chats: a core stays pinned to its project
 * after its chat switched projects (location, instance), its agents keep working there. Rows
 * `{ chatId, kind, agentId?, name }`: "agent" per live subagent (the chats' cores), and per open OWN core of a dynamic
 * workflow "workflow" (its next agent() starts there even if none lives right now) with its live workflow agents as
 * "workflowagent". Read by the project idle check.
 * Every row carries `identifier` — the instance the work is pinned to (an agent its record's, the workflow its
 * core's), null without an instance row — for the idle state per instance.
 */
export function coresInProject(projectId) {
  const pid = String(projectId || "");
  const out = [];
  if (!pid) return out;
  for (const k of open) for (const a of k.liveInProject(pid)) out.push({ chatId: k.chatId, kind: "agent", ...a });
  for (const k of ownCores) {
    // An outer-loop run counts if it runs in an instance at its chat's location (with tools); a sandboxed run without
    // tools runs in the backend in an empty folder and does not touch the project.
    if (k.outerLoop) {
      if (k.instance && k.project === pid) out.push({ chatId: k.chatId, kind: "outerloop", agentId: k.outerLoop.agentId, runId: k.outerLoop.runId, name: "", identifier: k.instance });
      continue;
    }
    if (k.project === pid) out.push({ chatId: k.chatId, kind: "workflow", name: "", identifier: k.instance || null });
    for (const a of k.liveInProject(pid)) out.push({ chatId: k.chatId, kind: "workflowagent", ...a });
  }
  return out;
}

/** The live subagents of ONE chat across all its open cores (older core first), each exactly once. */
export function liveRows(chatId) {
  const seen = new Set();
  const out = [];
  for (const k of coresOf(chatId)) {
    for (const z of k.rows()) {
      if (seen.has(z.agentId)) continue;
      seen.add(z.agentId);
      out.push(z);
    }
  }
  return out;
}

/**
 * Report a chat's agent situation to the clients. If a turn runs (its core still hangs on it), IT reports — its event
 * carries commands a core without a turn does not know. Otherwise an own `background` event: without a turn there are
 * no commands, but monitors (they belong to the chat, runs/monitors.js) and the wakeup (runs/wakeup.js).
 * Every report also sets the tick without a turn (see below) and remembers what it reported.
 */
export function reportBackground(chatId) {
  let overTurn = false;
  for (const k of coresOf(chatId)) if (k.reportTurn()) { overTurn = true; break; }
  if (!overTurn) {
    const w = wakeupOf(chatId);
    sse(chatId, { type: "harness", subtype: "background", monitors: liveMonitors(chatId), agents: liveRows(chatId), tasks: [],
      wakeupAt: w?.at || 0, wakeupReason: w?.reason || "", wakeupPrompt: (w?.prompt || "").slice(0, 600) });
  }
  tickSet(chatId);
}
// The monitors belong to the chat (runs/monitors.js) — their start and end change the situation like an agent: the
// same report (with a turn through it, otherwise the own `background`, whose `monitors` are the chat's).
observeMonitors((chatId) => reportBackground(chatId));
// Likewise the chat's wakeup (runs/wakeup.js): setting, cancelling and firing change the situation — the same report.
observeWakeup((chatId) => reportBackground(chatId));

// ── The tick without a turn ───────────────────────────────────────────────────────────────────────────────────
// Tokens, tool count and status of a subagent grow in the event stream; they are reported at sign-of-life points
// (start, switch, parking, end) and in between on the TICK. The turn's tick (runs/do-run.js armAgentTick) ends with
// its turn — a background agent surviving it would otherwise stand on the number of `run_done` until its end. Here is
// the tick for the agents no turn ticks — ONE per chat, throttled like the turn's (the same knob
// CBASE_AGENT_TICK_MS, default 2 s) and only on a real change (two equal measuring points are worthless for a rate).
// It stands as long as a core WITHOUT a turn has live agents, and is silent as long as a turn has live agents of its
// own: that turn's tick then reports ALL rows of the chat anyway (nativeAgentRows = liveRows).
const ticks = new Map(); // chatId -> { t, marker }
// The ONE marker of both ticks (here and runs/do-run.js armAgentTick). `waitingForCpu` belongs in it — an agent
// waiting for CPU changes nothing else, and the display would stand still.
export const tickMarker = (rows) => rows.map((a) => `${a.agentId}:${a.tokens}:${a.toolUses}:${a.status}:${a.waitingForCpu ? 1 : 0}`).join("|");
const withoutTurnLive = (chatId) => coresOf(chatId).some((k) => !k.inTurn() && k.liveCount() > 0);

function tickFrom(chatId) {
  const e = ticks.get(chatId);
  if (!e) return;
  clearInterval(e.t);
  ticks.delete(chatId);
}

// After every report: if work without a turn is still open, the tick runs (and knows the reported state), otherwise it is off.
function tickSet(chatId) {
  if (!withoutTurnLive(chatId)) return tickFrom(chatId);
  const marker = tickMarker(liveRows(chatId));
  const existing = ticks.get(chatId);
  if (existing) { existing.marker = marker; return; }
  const entry = { t: null, marker };
  entry.t = setInterval(() => tickStep(chatId), Number(process.env.CBASE_AGENT_TICK_MS) || 2_000);
  entry.t.unref?.();
  ticks.set(chatId, entry);
}

// One beat of the tick: reports if something changed since the last report. Returns whether it reported.
function tickStep(chatId) {
  const e = ticks.get(chatId);
  if (!e) return false;
  if (!withoutTurnLive(chatId)) { tickFrom(chatId); return false; }
  if (coresOf(chatId).some((k) => k.inTurn() && k.liveCount() > 0)) return false; // the turn's tick reports
  if (tickMarker(liveRows(chatId)) === e.marker) return false;
  reportBackground(chatId);
  return true;
}

/** How many ticks without a turn are set — for guards (a tick ends with the last agent, the deletion, the server). */
export const tickCount = () => ticks.size;
/** Let every tick beat NOW — the test seam that makes the tick observable without a clock (the test raises
 *  CBASE_AGENT_TICK_MS and beats itself). Returns the number of reports. */
export function tickNow() {
  let n = 0;
  for (const chatId of [...ticks.keys()]) if (tickStep(chatId)) n++;
  return n;
}

// The live subagents of ALL open cores, each with its chat — the source of the ONE query for open background work
// (runs/background.js). Rows like `rows()`, plus `chatId`.
export function liveAgents() {
  const out = [];
  for (const k of open) for (const z of k.rows()) out.push({ chatId: k.chatId, ...z });
  return out;
}

// Subagents die WITH the turn — if its run kind holds (default, runs/hooks.js `hold`). If it does not (`leaveAlive`),
// a core with live agents stays open and closes itself after the last one. Only remove the own instance: on a resume
// retry the recursive run has already entered its core before this finally runs.
export function closeAgents(chatId, ctl, { leaveAlive = false } = {}) {
  if (!ctl) return;
  // Older cores without a turn and without a live agent: they only stood open so a later turn reaches their agents
  // (see onFinish). The turn ending now was that opportunity.
  // Only EMPTY ones: a core knowing an agent stays open — every later turn continues it via cbase_agent_send
  // (otherwise an agent whose completion notice woke the turn in between would be unreachable afterwards). The idle
  // cleanup handles the rest.
  for (const k of [...open]) {
    if (k === ctl || k.chatId !== chatId || k.inTurn() || k.liveCount() > 0 || k.knownCount() > 0) continue;
    idleFrom(k);
    try { k.close(); } catch {}
    open.delete(k);
    if (owner.get(chatId) === k) owner.delete(chatId);
  }
  // If the run kind does not hold, the core stays open even with only FINISHED agents: the next turn continues them
  // via cbase_agent_send. It is closed with the chat (closeAgentsOfTheChat) or the server.
  if (leaveAlive && (ctl.liveCount() > 0 || ctl.knownCount() > 0)) {
    ctl.releaseFromTurn();
    setIdle(ctl); // without a live agent the idle deadline starts now
    return;
  }
  idleFrom(ctl);
  try { ctl.close(); } catch {}
  open.delete(ctl);
  if (owner.get(chatId) === ctl) {
    owner.delete(chatId);
    // If an agent still lives in an older core, the chat stays reachable through it (agentsOf, routes).
    const rest = coresOf(chatId);
    if (rest.length) owner.set(chatId, rest[rest.length - 1]);
  }
}

/**
 * The core that knows an agent: an agent lives beyond its turn in that turn's core, and a later turn asks for it (the
 * completion notice names its agentId). A live hit before a known one, a newer core before an older one. `null` ⇒ no
 * open core knows it.
 */
export function coreWithAgent(chatId, agentId) {
  const cores = coresOf(chatId).reverse();
  return cores.find((k) => k.alive(agentId)) || cores.find((k) => k.get(agentId)) || null;
}

/**
 * The agents of all open cores of a chat (list for `GET /agents`), newer core first. `onlyInstance`: only the agents
 * living in this instance identifier (the agent's own instance; null = the backend, without fallback to the core's —
 * the same question as instanceOfTheTarget) — for a call from a project network that must not learn the ids of an
 * agent in another instance. Without it all.
 */
export function agentsList(chatId, { onlyInstance } = {}) {
  return coresOf(chatId).reverse().flatMap((k) => {
    const list = k.list();
    if (onlyInstance === undefined) return list;
    // The agent's own instance — a known one without an instance lives in the backend, not in the core's.
    return list.filter((a) => (a?.agentId ? k.instanceOf?.(a.agentId) || null : k.instance || null) === onlyInstance);
  });
}

// Close all cores of a chat — including one whose turn is over (otherwise a parked agent with its wakeup would survive
// the deletion of its chat). The ONE closing path (chat deletion) calls this. First the cores a domain runs in this
// chat (running dynamic workflows with their agents, own cores) — via the hook kind "chatClosed", not via an import;
// BEFORE the chat's cores, so no script starts any more while they fall.
export function closeAgentsOfTheChat(chatId) {
  fireHooks("chatClosed", { chatId });
  for (const k of [...open]) {
    if (k.chatId !== chatId) continue;
    k.silence(); // the chat is gone: no completion notice
    closeAgents(chatId, k);
  }
  tickFrom(chatId); // silenced agents do not report their end — the tick would otherwise only stop at the next beat
}

// The server run ends: all open cores closed — their agents end as "stopped", every park wakeup is gone.
export function agentsAtServerEnd() {
  // An honest conclusion instead of a silent disappearance: an agent ending with the server has no auto-resume. The
  // RESTART reports it as orphaned (reportOrphaned) — here only the deposit is halted so closing does not overwrite it
  // there as "finished": an orderly end and a crash leave the same records, and the next start reports both alike.
  for (const k of open) k.depositHalt();
  for (const k of [...open]) closeAgents(k.chatId, k);
  for (const k of [...idleClocks.keys()]) idleFrom(k);
  for (const e of [...parkWakeup]) { clearTimeout(e.t); parkWakeup.delete(e); }
  for (const chatId of [...ticks.keys()]) tickFrom(chatId);
}

// ── Idle cleanup ──────────────────────────────────────────────────────────────────────────────────────────────
// A core stays open as long as it knows an agent — if the chat never runs again, it would lie in memory until the
// restart. A core WITHOUT a turn and WITHOUT a live agent (a parked one counts as live: it has not ended) is closed
// after the idle deadline. What a later continuation needs is in the records (store/subagents.js); cbase_agent_send
// picks the agent up from there again (fromInventory).
export const IDLE_DEFAULT_MS = 30 * 60_000;
/** A core's idle deadline — knob CBASE_AGENT_IDLE_MS, default 30 min. */
export function idleDeadline() {
  const v = Number(process.env.CBASE_AGENT_IDLE_MS);
  return Number.isFinite(v) && v > 0 ? v : IDLE_DEFAULT_MS;
}
const idleClocks = new Map(); // core → timeout
const inactive = (k) => open.has(k) && !k.inTurn() && k.liveCount() === 0;

function idleFrom(k) {
  const t = idleClocks.get(k);
  if (t) clearTimeout(t);
  idleClocks.delete(k);
}

// After every change of a core without a turn: inactive ⇒ the deadline runs (set once, not extended); otherwise off.
function setIdle(k) {
  if (!inactive(k)) return idleFrom(k);
  if (idleClocks.has(k)) return;
  const t = setTimeout(() => { idleClocks.delete(k); if (inactive(k)) coreClose(k); }, idleDeadline());
  t.unref?.();
  idleClocks.set(k, t);
}

function coreClose(k) {
  idleFrom(k);
  try { k.close(); } catch { /* a cleanup must never throw */ }
  open.delete(k);
  if (owner.get(k.chatId) === k) {
    owner.delete(k.chatId);
    const rest = coresOf(k.chatId);
    if (rest.length) owner.set(k.chatId, rest[rest.length - 1]);
  }
}

/** How many idle deadlines are running right now — for guards. */
export const idleCount = () => idleClocks.size;
/** Close every inactive core NOW — the test seam. Returns the number. */
export function idleNow() {
  let n = 0;
  for (const k of [...open]) if (inactive(k)) { coreClose(k); n++; }
  return n;
}

// ── Orphaned after a restart ──────────────────────────────────────────────────────────────────────────────────
// A subagent still recorded as running (or parked) when the server starts was running when the last server run ended
// — crash, swap with --force or an orderly end (see agentsAtServerEnd). Unlike a dynamic workflow it is NOT continued:
// it becomes "orphaned", and its chat learns it as a silent hint (runs/hints.js) in the next turn — no turn, no queue
// entry. The main agent decides whether to continue it via cbase_agent_send (fromInventory). The marking is
// conditional (only running ⇒ orphaned): a second restart reports none twice. Registered as the restart hook in
// server.js — a throw is a [hooks] line there.
export const orphanedText = (a) => `orphaned: ${a.agentId} — The subagent "${a.name || a.description || a.agentId}" (${a.provider}`
  + `${a.model ? `/${a.model}` : ""}) was still running when cbase restarted and was ended in the middle of its work. It is`
  + ` not continued on its own. If the subtask is still needed, cbase_agent_send with agentId "${a.agentId}"`
  + " continues it with its previous context — its report then arrives as a system message under the same agentId. What it"
  + " had until the restart is in its output file.";

//
// A PARKED one with a stored continuation time is NOT orphaned: it is picked up from the records in a core without a
// turn (withoutTurn.openCore, one per chat) and keeps parking there — it counts as open background work as before, and
// its wakeup continues it (immediately if the time has passed). A parked one WITHOUT a continuation time cannot be
// guessed: it is reported as orphaned, as is every one whose pick-up fails.
//
// Then the deferred verdicts: a chat whose last turn ended with open background work has none after the restart
// (orphaned means ended) — its verdict comes now, exactly once.
//
// The subagent of a MANAGER chat (runs/manager-lock.js) is LEFT as it is: not picked up (its core would run past the
// lock with the run-kind default — `bypassPermissions`, full catalog), not orphaned, no hint. The idle gate does not count one left standing: `agents`/`busy` of /api/runs/active
// read only LIVE cores, never the records.
function parkedPickUp(a, cores) {
  if (a.state !== "parked" || !(Number(a.parkedUntil) > 0) || !withoutTurn.openCore) return false;
  const chat = store.getChat(a.chatId);
  if (!chat || managerLocked(chat)) return false;
  try {
    let core = cores.get(a.chatId);
    if (!core) {
      core = withoutTurn.openCore(a.chatId);
      if (!core) return false;
      cores.set(a.chatId, core);
    }
    const image = store.readSubagent(a.chatId, a.agentId) || a;
    return core.pickUpParked(image).status === "parked";
  } catch (e) {
    console.error(`[agent] parked subagent ${a.agentId} not picked up again:`, e?.message || e);
    return false;
  }
}

// The not yet booked consumption of a PARKED one that is not picked up again: its last turn ended at the limit, a
// parked one is booked only at its end (agent-runtime.js deposit image `open`) — orphaned it has none any more, and
// runs/lateBooking.js skips parked ones because their rest is in the image. Without this booking the turn before
// parking would be missing forever. Exactly once: only if orphaning succeeded (conditional), and an orphaned image
// carries its `open` into no continuation. The same shape as bookConsumption in the core.
function bookOpenImage(a) {
  const u = a?.open;
  if (!u || typeof u !== "object") return false;
  if (!u.input && !u.output && !u.cached && !(Array.isArray(u.generations) && u.generations.length)) return false;
  const metered = a.billing === "metered";
  store.addUsageEvent({
    chatId: a.chatId, runId: "", step: 0, agentId: a.agentId, provider: a.provider, model: a.model || "",
    ...(metered ? meteredBooking(u) : subscriptionBooking(u)), kind: "sub", secs: 0, upstream: metered ? u.upstream || "" : "",
  });
  return true;
}

export function reportOrphaned() {
  let n = 0;
  let parked = 0;
  const cores = new Map(); // chatId → core without a turn of this restart
  const chats = new Set();
  for (const a of store.runningSubagents()) {
    // If it lives in THIS process, it is not orphaned (never in production: a restart is a new process).
    if (coreWithAgent(a.chatId, a.agentId)?.alive(a.agentId)) continue;
    if (managerLocked(store.getChat(a.chatId))) continue; // stays untouched (see above)
    if (parkedPickUp(a, cores)) { parked++; continue; }
    if (!store.orphanSubagent(a.chatId, a.agentId)) continue;
    if (a.state === "parked") {
      try { bookOpenImage(a); } catch (e) { console.error(`[agent] consumption of the parked ${a.agentId} not booked:`, e?.message || e); }
    }
    n++;
    if (!store.getChat(a.chatId)) continue; // a chat deleted past the closing path gets no hint
    depositHint(a.chatId, orphanedText(a), { source: "agent-orphaned" });
    chats.add(a.chatId);
  }
  if (n) console.log(`[agent] ${n} orphaned subagent(s) reported after the restart`);
  if (parked) console.log(`[agent] ${parked} parked subagent(s) picked up again after the restart`);
  if (withoutTurn.catchUp) {
    for (const chatId of chats) {
      try { withoutTurn.catchUp(chatId); } catch (e) { console.error("[agent] deferred verdict not caught up:", chatId, e?.message || e); }
    }
  }
  return n;
}
