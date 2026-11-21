// MCP tools: start, observe and stop graph workflows from the chat: cbase_workflow_start (only on announcement: the human named the
// workflow in their message of this turn with /workflow:<shortname>; the route checks that, not the tool), cbase_workflow_status
// (read) and cbase_workflow_stop. Routes: server/workflows/graph-routes.js (the checks and the run view in
// server/workflows/graph-start.js).
//
// They are in the set of EVERY coding chat, ALWAYS (a changing set costs the prompt cache); never for a subagent of any depth
// (../visibility.js, alwaysLocked) and never for a workflow agent (WORKFLOW_AGENT_FAMILIES, family "cbase_workflow"). The
// descriptions are fixed and carry no runtime values (prompt cache); the list of workflows is not here: the short name comes
// from the human's announcement.
// The order is part of the prompt prefix (cache), guard: server/backend/test/mcp-catalog.test.js; the group stands last in the
// catalog so the prefix before it stays the same.

import process from "node:process";
import { api, enc, obj, str } from "../lib.js";

function chatId() {
  const id = process.env.CBASE_CHAT_ID;
  if (!id) throw new Error("Without a chat there are no graph workflows to start, see or stop.");
  return id;
}

const graphWorkflowTools = [
  {
    name: "cbase_workflow_start",
    description: "Starts a graph workflow, ONLY if the human announced it in their message of this turn with /workflow:<shortname>. Otherwise the result is an error and nothing starts. `workflow`: the short name from the announcement. `input`: the workflow's input (at most 16,000 characters): the text after the name, supplemented by what the workflow needs from the conversation; cbase attaches the message's attachments itself. For one announcement you may start several times, each run with its own input. Foreground (default): the workflow runs in THIS chat and begins as soon as your turn ends: end it with one line; this turn does not count as a step. `background: true` only if the human says so: then it runs in its own chat, and at its end a <task-notification> arrives; status with cbase_workflow_status, stop with cbase_workflow_stop; only the human answers, approves, skips. `worktree: true` if the human says so or you start several runs on the same project: own git worktree per run, without a project lock. If a run is already listed under `alreadyStarted`, do not start it again.",
    inputSchema: obj({
      workflow: str("the short name from the announcement /workflow:<shortname>"),
      input: { type: "string", maxLength: 16000, description: "the workflow's input (at most 16,000 characters): the text after the name, supplemented by what the workflow needs from the conversation" },
      background: { type: "boolean", description: "true: the workflow runs in its own chat in the background, only if the human says so. Default: false (in this chat)" },
      worktree: { type: "boolean", description: "true: own git worktree per run, without a project lock. Default: false" },
    }, ["workflow"]),
    handler: async (a, meta = {}) => api("POST", `/api/chats/${enc(chatId())}/graph-workflows/start`, {
      workflow: typeof a.workflow === "string" ? a.workflow : "",
      input: typeof a.input === "string" ? a.input : "",
      // Only an explicit true counts; a missing field is no announcement.
      background: a.background === true,
      worktree: a.worktree === true,
      // The call block (as with cbase_agent): Claude at `_meta`, Codex and the loop engine via cbase/toolUseId.
      callId: String(meta["claudecode/toolUseId"] || meta["cbase/toolUseId"] || ""),
    }),
  },
  {
    name: "cbase_workflow_status",
    description: "The status of the graph workflows this chat started: state, step, what a waiting run is waiting for, worktree. Read-only: only the human can answer a waiting run.",
    inputSchema: obj({ startId: str("optional: only this start (startId from the result of cbase_workflow_start); without it all, newest first") }),
    handler: async (a) => {
      const startId = typeof a.startId === "string" ? a.startId.trim() : "";
      return api("GET", `/api/chats/${enc(chatId())}/graph-workflows${startId ? `?startId=${enc(startId)}` : ""}`);
    },
  },
  {
    name: "cbase_workflow_stop",
    description: "Stop a graph workflow of this chat (also queued or waiting). No <task-notification> follows after your stop.",
    inputSchema: obj({ startId: str("startId from the result of cbase_workflow_start or cbase_workflow_status") }, ["startId"]),
    handler: async (a) => {
      const startId = typeof a.startId === "string" ? a.startId.trim() : "";
      if (!startId) throw new Error("startId is missing; it is in the result of cbase_workflow_start and cbase_workflow_status.");
      return api("POST", `/api/chats/${enc(chatId())}/graph-workflows/${enc(startId)}/stop`, { from: "agent" });
    },
  },
];

export { graphWorkflowTools };
