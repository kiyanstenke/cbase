// MCP tools: app plumbing: the permission prompt (cbase_permission_prompt, called by Claude Code via --permission-prompt-tool) and
// skill access (cbase_skill).
// One contiguous slice of the tool array, in source order: cbase-mcp.js spreads the groups back together into TOOLS; the order
// is part of the prompt prefix (cache), guard: server/backend/test/mcp-catalog.test.js.

import process from "node:process";
import { WORKFLOW_AGENT, api, enc, runEnvironment, obj, str } from "../lib.js";
import { WORKFLOW_AGENT_REJECTION } from "../visibility.js";

/** The heading of the skill catalog in the system prompt (server/toolchain/skill-catalog.js skillCatalog: "## <title>"). */
export const SKILL_CATALOG_TITLE = "Available skills";

const appTools = [
  {
    // INTERNAL: Claude Code calls this via --permission-prompt-tool when a tool needs an approval in "ask"/"auto-edit" mode.
    // The handler reports the request to the app and waits (long poll) until the user picks allow/deny in the UI; then it returns
    // the Claude Code decision {behavior:"allow",updatedInput} or {behavior:"deny",message}.
    name: "cbase_permission_prompt",
    description: "Internal (permission prompt of the cbase app). Do NOT call directly: it is requested automatically by Claude Code.",
    inputSchema: obj({
      tool_name: str("requested tool"),
      input: { type: "object", additionalProperties: true, description: "Input of the requested tool" },
      tool_use_id: str("tool_use_id (optional)"),
    }, ["tool_name"]),
    handler: async (a) => {
      const chatId = process.env.CBASE_CHAT_ID;
      if (!chatId) return { behavior: "allow", updatedInput: a.input || {} }; // do not block without a chat context
      // No human in the run: a workflow agent gets the rejection immediately; no card in the chat.
      if (WORKFLOW_AGENT) return { behavior: "deny", message: WORKFLOW_AGENT_REJECTION };
      try {
        // `profileKey`: a subagent's server carries its profile, so the card belongs to the agent that asks and goes with it
        // instead of being rejected at the end of the main run's turn.
        return await api("POST", `/api/chats/${enc(chatId)}/permission-request`, { toolName: a.tool_name, input: a.input || {}, toolUseId: a.tool_use_id || null, profileKey: process.env.CBASE_PROFILE_KEY || null });
      } catch (e) {
        return { behavior: "deny", message: "Permission request failed: " + (e && e.message ? e.message : e) };
      }
    },
  },
  // ── Skills: the one way to load a guide ─────────────
  // Every provider speaks MCP, so there is exactly one tool here; the catalog (name + purpose per skill) is in the system
  // prompt, which cbase writes the same for every provider.
  //
  // Offered if the run has skills (CBASE_SKILLS) OR may write skills (CBASE_SKILL_WRITE, offering.js): a name that a resumed run
  // (--resume) remembers from an earlier catalog hits the server (404).
  {
    name: "cbase_skill",
    // Depends on the run: without a catalog (CBASE_SKILLS empty, only CBASE_SKILL_WRITE) there is no list in the system prompt;
    // the description says so instead of pointing to it. The title SKILL_CATALOG_TITLE is bound to the heading of
    // server/toolchain/skill-catalog.js skillCatalog (guard server/backend/test/prompt-audit.test.js).
    description: (u = runEnvironment()) => (u.withSkillCatalog
      ? `Load the complete guide of a skill. Which ones exist is listed (“${SKILL_CATALOG_TITLE}”) in your system prompt: there with name and purpose, here with content. Load a skill BEFORE you tackle a task it describes, and then work by it. It costs context only when loaded, so better one on purpose than all as a precaution.`
      : "Load the complete guide of a skill. NO skill is currently assigned to this chat, so your system prompt carries no list; you can load a skill you created in this chat with cbase_skill_write (under its name). The answer carries id, version and level."),
    // No `enum`: a skill the main agent has just created with cbase_skill_write is loadable in the same turn; the fixed list from
    // CBASE_SKILLS did not know it. Checked in the server against the chat's set (chats/routes.js, chatSkills). The answer
    // carries id, version and level.
    inputSchema: (u = runEnvironment()) => obj({ name: str(u.withSkillCatalog ? `Name of the skill from the catalog “${SKILL_CATALOG_TITLE}” in your system prompt (or of one just created)` : "Name of a skill you created with cbase_skill_write") }, ["name"]),
    handler: async (a) => {
      const chatId = process.env.CBASE_CHAT_ID;
      if (!chatId) throw new Error("Without a chat there are no skills.");
      return api("GET", `/api/chats/${enc(chatId)}/skills/${enc(String(a.name || ""))}`);
    },
  },
];

export { appTools };
