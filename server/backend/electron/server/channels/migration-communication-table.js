// The migration table of agent communication — a leaf WITHOUT imports. The ONLY file under server/backend/electron/server/
// and server/backend/electron/mcp/ in which the seven old tool names may stand as strings (name guard
// server/backend/test/communication-old-names.test.js, the exception is named there, narrowed to the seven keys of
// TOOL_REPLACEMENT): the migration (./migration-communication.js) must know what it replaces, and channel delivery
// (./delivery.js) recognizes by the pattern OLD_CHANNEL_RESPONSE a preamble that was queued before the change.
//
// Read by: ./migration-communication.js (agent definitions, stored channel prompts), ./delivery.js (reply path of the
// preamble, queued preambles).

/** Old → new, in the order of the old catalog. One name can point to several new ones (channel_send ⇒ agent_send + agents_list). */
export const TOOL_REPLACEMENT = Object.freeze({
  cbase_runs_overview: Object.freeze(["cbase_agents_list"]),
  cbase_chat_list: Object.freeze(["cbase_agents_list"]),
  cbase_chat_read: Object.freeze(["cbase_agents_list"]),
  cbase_channel_read: Object.freeze(["cbase_agents_list"]),
  cbase_channel_status: Object.freeze(["cbase_agents_list"]),
  cbase_channel_send: Object.freeze(["cbase_agent_send", "cbase_agents_list"]),
  cbase_channel_create: Object.freeze(["cbase_chat_assign"]),
});

// The preamble of a channel delivery before the change (channels/delivery.js channelPrompt). An entry stored back then
// (queue run_inputs, parked run pending_resumes, interrupted run active_runs) carries it in its prompt: the queue is
// refreshed by channels/delivery.js on restart, the other two by the one-time migration. The pattern matches STORED
// German text and must stay as it is.
const OLD_CHANNEL_RESPONSE = /Antworte über cbase_channel_send \(channelId: ([0-9a-f-]+)\)/g;
/** The preamble's reply path since the change — ONE version for channels/delivery.js (build and refresh) and the migration. */
export const channelResponseRow = (channelId) => `Reply through cbase_agent_send (to: "channel:${channelId}")`;
/** Replaces the old reply path with `newSet(channelId)` (default: channelResponseRow). */
export function replaceOldChannelPreamble(text, newSet = channelResponseRow) {
  return String(text ?? "").replace(OLD_CHANNEL_RESPONSE, (_, id) => newSet(id));
}
