// MCP tool: writing skills: `cbase_skill_write`. Route: POST /api/chats/:id/skill-write (server/toolchain/skill-routes.js, logic
// server/toolchain/skill-change.js); the chat in the path is this run's chat (CBASE_CHAT_ID). Reading stays `cbase_skill`
// (tools/app.js); it returns id, version and level.
//
// Who sees it (../offering.js, ../visibility.js): ONLY the main run of a coding chat, and only with the marker CBASE_SKILL_WRITE=1,
// which server/toolchain/mcp-config.js writes exactly then (role "coding" without markers, workspace switch on). Additionally
// locked for subagents (VIEW_BY_DEPTH.alwaysLocked), workflow agents (WORKFLOW_AGENT_INDIVIDUAL), the outer loop
// (OUTER_LOOP_LOCKED) and the special runs (ONLY_CODING_MAIN_RUN). The server checks the same once more (markers AFTER the model's
// arguments, senderOf): description side = execution side.
//
// The group stands LAST in the catalog (../catalog.js): the prefix before it stays the same for every run. The description is
// fixed (prompt cache).

import process from "node:process";
import { WORKFLOW_AGENT, OUTER_LOOP, api, enc, needChat, obj, str } from "../lib.js";

const ACTIONS = ["create", "change", "erase"];

// The sender markers (as with cbase_agenda_write): AFTER the model's arguments, so it cannot pass itself off as the main agent.
const depth = () => Number(process.env.CBASE_AGENT_DEPTH) || 0;
const markers = () => ({
  ...(process.env.CBASE_PROFILE_KEY || depth() > 0 ? { ofProfile: process.env.CBASE_PROFILE_KEY || "depth" } : {}),
  ...(WORKFLOW_AGENT ? { workflowAgent: WORKFLOW_AGENT } : {}),
  ...(OUTER_LOOP ? { outerLoop: OUTER_LOOP } : {}),
});

const skillTools = [
  {
    name: "cbase_skill_write",
    description: "Creates coding skills of this workspace, changes them or requests their deletion. Creating and changing take effect immediately and are in the history with the previous state, which the human can revert; the new skill is immediately loadable with cbase_skill, in the catalog of your system prompt it appears from the next turn. Deleting is only a request: the human approves or rejects it, and you learn the result as a hint. For change and erase read the skill beforehand with cbase_skill (id, version); if it is different meanwhile, the call fails with a conflict. If a skill is in the skill list of an agent definition, renaming and deleting fail with the list of definitions.",
    inputSchema: obj({
      action: { type: "string", enum: ACTIONS, description: "create | change | erase (erase files a request)" },
      name: str("create (required), change (= rename): lowercase kebab-case (a-z, 0-9, -), at most 64 characters, unique on the level"),
      description: str("create, change: the purpose in one sentence; it stands in the catalog of every turn (at most 1,000 characters)"),
      guide: str("create, change: the complete guide as Markdown; REPLACES the previous one (at most 100,000 characters)"),
      level: { type: "string", enum: ["project", "workspace"], description: "create: project | workspace; without it the level of this chat (project chat: its project)" },
      project: str("create with level project from a workspace chat: name or id of the project"),
      id: str("change, erase: the id of the skill (from cbase_skill)"),
      version: str("change, erase: the version you read with cbase_skill"),
      reason: str("erase: why the skill should go; the human reads it on the request card"),
    }, ["action"]),
    handler: async (a) => {
      const chatId = needChat();
      // The markers come AFTER the model's arguments; fields of the same name sent along are dropped beforehand.
      const { ofProfile: _p, workflowAgent: _w, outerLoop: _o, ...args } = a;
      return api("POST", `/api/chats/${enc(chatId)}/skill-write`, { ...args, ...markers() });
    },
  },
];

export { skillTools, ACTIONS as SKILL_ACTIONS_MCP };
