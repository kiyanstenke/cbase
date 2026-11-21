// The wordings of the coding MCP airlock: what a rejected call tells the model — WHY, and for a subagent that it can ask
// "main". A leaf (i18n and the sentence for workflow agents), so that routes, wrapper and tests hold the same text.

import { T } from "../i18n.js";
import { OUTER_LOOP_REJECTION, WORKFLOW_AGENT_REJECTION } from "../../mcp/visibility.js";

/** Main agent: the tool is deselected (choice at the server). */
export const notSelected = (tool, server) => T`Tool ${tool} is not selected for coding chats (Coding → MCP, server ${server}).`;


/** A supplied tool list for an http server: cbase loads its list itself. */
export const listOnlyStdio = (server) => T`Gate: cbase loads the tool list of the http server ${server} itself — it does not accept a supplied list.`;

/**
 * Subagent or workflow agent without "Subagents inherit". `role` = the role of the run token: a workflow agent does not have
 * cbase_agent_send (mcp/visibility.js WORKFLOW_AGENT_FAMILIES) — the sentence names the way it does have: its result.
 */
export const onlyMain = (server, role = "subagent") => (role === "workflow"
  ? T`Only the main agent has server ${server} — state in your result what you need from it.`
  : T`Only the main agent has server ${server} — write to it with cbase_agent_send to "main".`);

/** Subagent with an agent type (toolchain/agent-mcp.js): the tool is not in its type's selection for this server. */
export const typeNotSelected = (tool, server) => T`Tool ${tool} is not selected for your agent type (server ${server}).`;

/** Server meanwhile off, deleted or no longer in the chat's set. */
export const notActive = (server) => T`Server ${server} is no longer active in this chat.`;

/** Workflow agent and marked tool: no card, declined at once. Without cbase_agent_send — it does not have it (see onlyMain). */
export const workflowMarker = () => `${WORKFLOW_AGENT_REJECTION} ${T(
  "The tool carries an approval mark.")}`;

/** Outer-loop run: the server or the tool is not in the choice of ITS agent. */
export const outerLoopNotSelected = (tool, server) => tool
  ? T`Tool ${tool} is not selected for this outer-loop agent (server ${server}).`
  : T`Server ${server} is not selected for this outer-loop agent (server ${server}).`;

/** Outer-loop run and marked tool: no card — there is no human in its run who could approve. */
export const outerLoopMarker = () => `${OUTER_LOOP_REJECTION} ${T(
  "The tool carries an approval mark.")}`;

/** The card was cancelled (wrapper closed, provider abort, deadline). */
export const cardsAbort = () => T(
  "Cancelled before the approval card was decided — the call was not executed.");

/** The card stayed open until the deadline (CARDS_DEADLINE_MS, below the providers' call timeout of 660 s). */
export const cardsDeadline = (minutes) => T`The approval card was not decided within ${minutes} min — declined, nothing executed. Ask again when the user is around.`;

/** An http server whose instance no longer exists (never silently from B). */
export const instanceGone = (server) => T`Server ${server}: this run's instance no longer exists — not forwarded.`;
