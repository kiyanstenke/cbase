// MCP tools: the library of dynamic workflows: cbase_dynamic_workflow_list (those effective in the chat) and
// cbase_dynamic_workflow_save (store a script in the Claude Code format); the run itself: cbase_dynamic_workflow and
// cbase_dynamic_workflow_stop; and the messenger StructuredOutput of a workflow agent with a schema (visible only if CBASE_SCHEMA is
// set, see ../cbase-mcp.js). Routes: server/dynworkflows/routes.js.
//
// The library tools are in the set of EVERY coding chat and every graph step, ALWAYS, also with an empty library (a changing set
// costs the prompt cache). Never for a subagent (../visibility.js, alwaysLocked). No catalog in the system prompt: whoever wants
// to know what exists asks the list.
// The order is part of the prompt prefix (cache), guard: server/backend/test/mcp-catalog.test.js.

import process from "node:process";
import { STRUCTURE_REFERENCE, STRUCTURE_SCHEMA, api, enc, obj, str } from "../lib.js";
import { STRUCTURE_TOOL } from "../visibility.js";

function chatId() {
  const id = process.env.CBASE_CHAT_ID;
  if (!id) throw new Error("Without a chat there is no library of dynamic workflows.");
  return id;
}

// The user's size guideline (server/dynworkflows/size.js) as a hint at the end of the description, (unrestricted: no hint). The level arrives as environment, ONLY if it differs from the
// default; without (or with an unknown) value the default sentence applies. The description therefore changes only when the user
// changes the setting, never from turn to turn (prompt cache).
export const SIZES_AGENTS = Object.freeze({ small: 5, medium: 10, large: 50 });
const GUIDELINE = "Treat it as a recommendation, not a limit: go bigger or smaller when the user's request clearly calls for it.";
export function sizesSet(value) {
  if (value === "unrestricted") return " No guideline applies to the size of dynamic workflows (unrestricted) — plan as large as the task requires.";
  if (value === "small" || value === "large") {
    return ` The user has set a size guideline for dynamic workflows: ${value} — keep workflows under ${SIZES_AGENTS[value]} agents. ${GUIDELINE}`;
  }
  return ` The default size guideline for dynamic workflows applies: medium — keep workflows under ${SIZES_AGENTS.medium} agents. ${GUIDELINE} The user can raise or lift it in the settings (Usage → Dynamic workflows).`;
}

const dynWorkflowTools = [
  {
    name: "cbase_dynamic_workflow_list",
    description: "The stored dynamic workflows that apply in this chat: in a workspace chat all of the workspace, in a project chat those adopted in this project. Per entry name, description, whenToUse and phases from its meta, but not the script itself.",
    inputSchema: obj({}),
    handler: async () => api("GET", `/api/chats/${enc(chatId())}/dyn-workflows`),
  },
  {
    name: "cbase_dynamic_workflow_save",
    description: "Save a dynamic workflow in the workspace library, only if the user wants that. `script` is the complete script in the format of Claude Code's Workflow tool: it begins with `export const meta = { name, description, whenToUse?, phases? }` as a PURE literal (no variables, calls or computed values), followed by the body with agent()/parallel()/pipeline()/phase(). It is stored byte-equal. Saved from a project chat, the workflow is at the same time adopted in this project. The name from meta must hit neither a stored workflow nor a skill of the workspace nor a built-in command (goal, compact, clear, model, effort, mode, browser, cost, help, workflows); then the result is an error and nothing is overwritten.",
    inputSchema: obj({ script: str("the complete workflow script, beginning with `export const meta = {…}`") }, ["script"]),
    handler: async (a) => api("POST", `/api/chats/${enc(chatId())}/dyn-workflows`, { script: typeof a.script === "string" ? a.script : "" }),
  },
  // The run. Inputs 1:1 like Claude Code's Workflow tool, plus `name` (a stored
  // workflow of the library). Guard: mcp-schema.test.js.
  {
    name: "cbase_dynamic_workflow",
    // Kept short (length guard server/backend/test/mcp-description-length.test.js): the script language (meta as a pure literal, no
    // TypeScript, workflow() as a sub-step) is on the field `script`, refining on the field `scriptPath`; what to do after the call
    // (end the turn, do not call again, stopping) is said by the answer (dynworkflows/run.js `note`). The three opt-in sentences
    // are word-for-word what mcp-schema.test.js OPT_IN_SETS reads; sizesSet is unchanged. No reference to "the script language of
    // Claude Code's Workflow tool": a third-party model does not know that tool; the first sentence names the building blocks, the
    // field `script` the structure.
    description: "Starts a dynamic workflow: a JavaScript script that deterministically orchestrates several subagents with agent()/parallel()/pipeline()/phase(). The structure of the script is described by the field `script`. Single subagents go with cbase_agent. The workflow runs in the background: the call returns immediately, the result arrives as <task-notification>. It runs freely only if the user has explicitly chosen multi-agent orchestration: the chat is in Ultracode mode (in a graph workflow also via its run settings), the user wrote “ultracode” in their message of this turn, or the task of the graph workflow step the chat is at contains “ultracode”. Otherwise nothing starts until the user agrees on a card with name, description and phases from meta. A step of a graph workflow may call it too: it proceeds only when the workflow has ended (or the card has been decided). A stored workflow (cbase_dynamic_workflow_list) starts with `name` instead of `script`; resuming goes with `resumeFromRunId`, stopping with cbase_dynamic_workflow_stop." + sizesSet(process.env.CBASE_DYNWF_SIZE),
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", maxLength: 524288, description: "The complete workflow script, plain JavaScript (no TypeScript): first `export const meta = { name, description, phases }` as a PURE literal (no variables, calls or computed values), then the body with agent()/parallel()/pipeline()/phase()/log(). `await workflow('name', args)` calls a stored workflow as a sub-step: it shares cap, abort and budget of the run, and a workflow() inside it throws (one level). At the end the <task-notification> names an output file with the journal per agent() and the log() lines." },
        name: { type: "string", description: "Name of a stored workflow of the library (cbase_dynamic_workflow_list: in a project chat only the adopted ones), instead of `script`, with `args` as input. An unknown name is an error immediately, nothing runs." },
        description: { type: "string", description: "Ignored: the description is in the script's `meta`." },
        title: { type: "string", description: "Ignored: the title is in the script's `meta`." },
        args: { description: "Optional input value, available in the script verbatim as global `args`. Pass lists and objects as real JSON values, NOT as a JSON string, or `args.map` breaks in the script." },
        scriptPath: { type: "string", description: "Absolute path of a script file; takes precedence over `script`. Every call stores its script and names the path in the result: to refine, change the file and call again with the same scriptPath instead of sending the whole script again." },
        resumeFromRunId: { type: "string", pattern: "^wf_[a-z0-9-]{6,}$", description: "Run id of an earlier run of this chat to resume from (with scriptPath or script; with neither, the old run's script): the longest unchanged prefix of the agent() calls delivers its results immediately from the journal, the first changed or new call and everything after it runs anew. Same script + same args ⇒ everything from the cache. A changed model (even merely resolved, e.g. because the chat switched the model) counts as a changed call." },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (a, meta = {}) => api("POST", `/api/chats/${enc(chatId())}/dyn-workflows/run`, {
      script: a.script, name: a.name, scriptPath: a.scriptPath, args: a.args, resumeFromRunId: a.resumeFromRunId,
      // The call block (as with cbase_agent): the completion notice names it as <tool-use-id>.
      callId: String(meta["claudecode/toolUseId"] || meta["cbase/toolUseId"] || ""),
    }),
  },
  {
    name: "cbase_dynamic_workflow_stop",
    description: "Stop a running dynamic workflow of this chat, together with its agents. `taskId` from the result of cbase_dynamic_workflow (the runId works too). No <task-notification> follows afterwards.",
    inputSchema: obj({ taskId: str("taskId (or runId) of the workflow") }, ["taskId"]),
    handler: async (a) => api("POST", `/api/chats/${enc(chatId())}/dyn-workflows/stop`, { taskId: typeof a.taskId === "string" ? a.taskId : "" }),
  },
  // The messenger of an `agent(prompt, {schema})`. Its input schema IS the schema of the call (like Claude Code's
  // StructuredOutput); it is checked not here but in the backend with ajv: an invalid object comes back as an error tool result
  // with the ajv wording, and the model corrects itself in the same turn. Last in its group: without a schema it is absent, and
  // the prefix before it stays the same (the graph-workflow group follows in the catalog, which a workflow agent never sees).
  {
    name: STRUCTURE_TOOL,
    description: "Deliver your result as a structured object. Call this tool EXACTLY ONCE with the complete result, as your last action: the object is the return value of your task. If it is invalid, you get the reason as an error: correct the object and call the tool again.",
    inputSchema: STRUCTURE_SCHEMA || obj({}),
    handler: async (a) => {
      const r = await api("POST", `/api/chats/${enc(chatId())}/dyn-workflows/structured-output`, { reference: STRUCTURE_REFERENCE, object: a });
      return { __content: [{ type: "text", text: String(r?.text || "") }], ...(r?.valid ? {} : { __isError: true }) };
    },
  },
];

export { dynWorkflowTools };
