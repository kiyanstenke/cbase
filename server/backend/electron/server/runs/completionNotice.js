// A subagent's completion notice — in the format of Claude Code (`task-notification`: task-id, tool-use-id, output-file, status,
// summary, result, diagnostics or recovery, usage). Plus an element of its own, `<name>`: the agent's name, which the clients read
// for the system line — read from the summary it was ambiguous as soon as the error text itself carried `"…" failed`. Notices
// without the element (old data) are read by Web and iOS from the summary, by THE SAME rule (web/test/completion-notice-binding).
//
// It goes to a chat whose turn does not hold its agents (the Coding chat, runs/hooks.js `hold`): through the ONE wake path
// (runs/queue.js deliverUserPrompt, cause "agent") — if a turn is running, with Claude at the next tool boundary (a message
// arriving on stdin in the middle of a turn stands in the next model request behind the tool result, ONE result), with Codex and
// the loop engine as the next turn; if the chat is idle, as a turn of its own. It is stored under the role of a user message — TWO
// KINDS under one role: the marker is the start `<task-notification>` (FINISHED_MARKER), and every reading view needs the case
// distinction.
//
// A leaf without imports: called by runs/agents.js (delivery), read by runs/queue.js (marking).

export const FINISHED_MARKER = "<task-notification>";
// As in Claude Code: the result in the notice is truncated, the full report is in the output file.
export const FINISHED_RESULT_MAX = 8_000;

const xml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Is this text a completion notice (and not a user message)? */
export const isCompletionNotice = (text) => typeof text === "string" && text.startsWith(FINISHED_MARKER);

/**
 * The completion notice from the core's report (providers/agent-runtime.js report()).
 * @param {Object} r  report: status, agentId, description, agentType, error, report, notes, outputFile,
 *                    totalTokens, tokenKind, totalToolUseCount, totalDurationMs, worktree
 * @param {{toolUseId?: string}} [o]  the call block under which the agent hangs in the history
 * @returns {string}
 */
export function completionNotice(r, { toolUseId = "" } = {}) {
  const status = r.status === "completed" ? "completed" : r.status === "stopped" ? "stopped" : "failed";
  const name = r.description || r.agentType || r.agentId;
  const summary = status === "completed" ? `Agent "${name}" completed`
    : status === "stopped" ? `Agent "${name}" was stopped`
      : `Agent "${name}" failed: ${String(r.error || "Unknown error").split("\n")[0].slice(0, 300)}`;
  const full = String(r.report || "").trim();
  const result = full.length > FINISHED_RESULT_MAX
    ? `${full.slice(0, FINISHED_RESULT_MAX)}\n[… truncated — the full report is in the output file]`
    : full;
  const rows = [
    FINISHED_MARKER,
    `<task-id>${xml(r.agentId)}</task-id>`,
    ...(toolUseId ? [`<tool-use-id>${xml(toolUseId)}</tool-use-id>`] : []),
    ...(r.outputFile ? [`<output-file>${xml(r.outputFile)}</output-file>`] : []),
    `<status>${status}</status>`,
    `<name>${xml(name)}</name>`,
    `<summary>${xml(summary)}</summary>`,
    `<result>${xml(result)}</result>`,
  ];
  // Finished: what one needs to know to go on (notes, worktree, continuing). Failed: how to go on.
  const hints = [
    String(r.notes || "").trim(),
    r.worktree ? `Worktree: ${r.worktree}` : "",
    status === "completed"
      ? `Follow-up questions to the same subagent go through cbase_agent_send (agentId ${r.agentId}) — it keeps its context.`
      : `What it had until then is in its output file. Continue with cbase_agent_send (agentId ${r.agentId}).`,
  ].filter(Boolean).join("\n");
  rows.push(status === "completed" ? `<diagnostics>${xml(hints)}</diagnostics>` : `<recovery>${xml(hints)}</recovery>`);
  const lowerLimit = r.tokenKind && r.tokenKind !== "full" ? ` kind="min."` : "";
  rows.push(`<usage><total_tokens${lowerLimit}>${Number(r.totalTokens) || 0}</total_tokens><tool_uses>${Number(r.totalToolUseCount) || 0}</tool_uses><duration_ms>${Number(r.totalDurationMs) || 0}</duration_ms></usage>`);
  rows.push("<note>This is a system notice about your subagent, not a user reply. Evaluate it and keep working.</note>");
  rows.push("</task-notification>");
  return rows.join("\n");
}

/**
 * A message that never reached its subagent: cbase_agent_send had acknowledged it with "delivered after the end", then the
 * subagent failed, was stopped, or the credit gate stood before the hand-in. It goes to the main agent instead of into the void —
 * in the form of a completion notice (the same kind; Web and iOS show it as a "system notice" because the summary is not
 * `Agent "…"`), without <status>: the agent's outcome is in ITS completion notice.
 * @param {{agentId: string, name?: string, status?: string, message: string, reason?: string}} o
 * @returns {string}
 */
export function notDelivered({ agentId, name = "", status = "", message, reason = "" }) {
  const why = reason ? String(reason).split("\n")[0].slice(0, 400)
    : status === "stopped" ? "it was stopped before it could read it"
      : status === "failed" ? "it failed before it could read it"
        : "it ended before it could read it";
  return [
    FINISHED_MARKER,
    `<task-id>${xml(agentId)}</task-id>`,
    `<summary>${xml(`Message to subagent "${name || agentId}" not delivered: ${why}`)}</summary>`,
    `<result>${xml(message)}</result>`,
    "<note>This is a system notice, not a user reply: the message above did not reach its subagent. If it still applies,"
      + ` send it again with cbase_agent_send (agentId ${xml(agentId)}) or do the thing yourself.</note>`,
    "</task-notification>",
  ].join("\n");
}
