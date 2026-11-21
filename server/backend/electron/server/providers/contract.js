// contract.js — the adapter contract (port).
//
// Defines the provider-neutral interface that EVERY connector fulfils:
//  - the normalized run "spec" (input of runChat, built in doRun),
//  - the Claude-shaped stream-json event schema (output via onEvent) + event BUILDERS,
//  - the connector shape + capabilities (caps),
//  - canonical tool names (so that AssistantBlocks renders every provider identically),
//  - light validators.
//
// PURE: no state, no I/O, no imports. The event builders deliberately produce shapes BYTE-IDENTICAL to what
// connectors/codex.js emits by hand (runChatCodex) and what connectors/claude.js passes through from the Claude CLI —
// so runs/do-run.js (doRun/token accounting) and the frontend (ChatPane/AssistantBlocks) stay untouched.

// ── Types (JSDoc) ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Caps
 * @property {boolean} ownsAgentLoop   Connector brings its own agentic tool loop (native CLI).
 *                                     false → the generic loop engine (engine.js) drives it.
 * @property {boolean} nativeToolCalling  Endpoint supports native function/tool calling (otherwise text protocol).
 * @property {boolean} streaming       Delivers chunk/SSE streaming (otherwise the response in one go).
 * @property {boolean} reasoning       Delivers a thinking/reasoning channel.
 * @property {boolean} vision          Can process images as input.
 * @property {boolean} permissionPrompt  Interactive tool approval possible.
 * @property {boolean} fork            Session fork possible.
 * @property {boolean} effort          Reasoning effort selection.
 * @property {boolean} plan            Plan mode.
 */

/**
 * Provider-neutral run input. Native connectors read the CLI fields (mcpConfigPath, settingSources, disallowedTools,
 * sessionId); the engine additionally reads transcript/chatId/engine. (There is no `agents` field: every provider
 * starts subagents via cbase_agent and the core, providers/agent-runtime.js.)
 * @typedef {Object} Spec
 * @property {string}   systemPrompt
 * @property {string}   input
 * @property {string}   cwd
 * @property {string[]} [addDirs]
 * @property {string}   permissionMode           default|acceptEdits|plan|bypassPermissions
 * @property {string}   [mcpConfigPath]          native Claude (--mcp-config)
 * @property {Object}   [mcpServers]             native Codex + engine (server definitions)
 * @property {string[]} [allowedTools]
 * @property {boolean}  [permissionPromptTool]
 * @property {boolean}  [codexWithoutFileAccess]  Codex only: without shell and view_image (connectors/codex.js CODEX_WITHOUT_FILE_ACCESS) — a run without chosen built-ins
 * @property {string}   [settingSources]         native Claude
 * @property {string}   [model]                  tier/provider model id (before resolveModel)
 * @property {string}   [effort]
 * @property {string}   [sessionId]              resume handle (Claude session_id / Codex thread_id)
 * @property {boolean}  [forkPending]
 * @property {Array<{role:string,content:*}>} [transcript]  engine resume (stateless providers)
 * @property {string}   [chatId]
 * @property {Object}   [engine]                 engine context (skills, permission callback, …)
 */

/**
 * @typedef {Object} RunResult
 * @property {number}      code        exit code (-1 on spawn/fatal error)
 * @property {string|null} sessionId
 * @property {string|null} resultText
 * @property {string}      stderr
 */

/**
 * @typedef {Object} Connector
 * @property {string}   id
 * @property {string}   label
 * @property {() => string} [bin]
 * @property {Array<{id:string,label:string,context:number}>} models
 * @property {Caps}     caps
 * @property {() => Object} cleanEnv
 * @property {(model:string) => string} resolveModel
 * @property {(prompt:string, opts?:Object) => Promise<string>} runOnce
 * @property {(a:{spec:Spec,onEvent:Function,onSpawn?:Function}) => Promise<RunResult>} [runChat]
 * @property {(a:{messages:Array,tools:Array,model:string,effort:string,signal?:AbortSignal,onDelta?:Function}) => Promise<CompletionTurn>} [complete]
 *   `onDelta` gets ONE of the fields per event: `{text}` (response text), `{thinking}` (thinking) or
 *   `{toolStart: {id, name}}`: ONCE per tool call, as soon as id AND name are in the stream, with the id under which
 *   `toolCalls` returns the call at the end. If the stream names no id (the final form then assigns one), no start comes.
 * @property {() => Promise<Object|null>} [authStatus]
 * @property {() => Object} [usage]
 */

/**
 * Result of ONE round of a completion connector (the engine drives the loop).
 * @typedef {Object} CompletionTurn
 * @property {string}  text                 visible assistant text of this round
 * @property {string}  [thinking]           reasoning/thinking of this round (display)
 * @property {Array<Object>} [thinkingBlocks]  signed thinking blocks that belong in the HISTORY (Anthropic extended
 *                                             thinking requires them with their signature in every follow-up request
 *                                             with tool_use). Other formats simply leave them out.
 * @property {Array<{id:string,name:string,input:Object}>} toolCalls  requested tool calls
 * @property {{input:number,output:number,cached:number}} usage       tokens of this round
 * @property {string}  stop                 stop reason: "end" | "tool_calls" | "length" | …
 */

// ── Event builders: the Claude stream-json schema (the downstream contract) ─────────
// Every builder returns exactly ONE event object as it is handed to onEvent.

export const ev = {
  /** Init/session. */
  systemInit: (sessionId) => ({ type: "system", subtype: "init", session_id: sessionId }),

  /** Live delta for visible text. */
  textDelta: (text) => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  }),
  /** Persisted assistant text block. */
  assistantText: (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } }),

  /** Live delta for thinking. */
  thinkingDelta: (text) => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: text } },
  }),
  /** Persisted thinking block. */
  assistantThinking: (thinking) => ({ type: "assistant", message: { content: [{ type: "thinking", thinking }] } }),

  /**
   * START of a tool call while the round is still streaming: the shape of Claude's `content_block_start` with
   * `content_block: {type:"tool_use", id, name, input:{}}` — web and iOS create the tool row from it and show the
   * working indicator again; the input comes with the `toolUse` event afterwards (same id). Without `index`, like the
   * engine's `textDelta`/`thinkingDelta`: no client reads it, and the engine does not know the block number of the
   * round. Display only — runs/do-run.js and the agent core persist nothing from it (tool rows arise at the
   * `assistant` event, results at `user`/tool_result).
   */
  toolUseStart: (id, name) => ({
    type: "stream_event",
    event: { type: "content_block_start", content_block: { type: "tool_use", id, name, input: {} } },
  }),
  /** Tool call (tool_use). input is always an object. */
  toolUse: (id, name, input) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input: input || {} }] },
  }),
  /** Tool result (tool_result). */
  toolResult: (id, content, isError) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: !!isError }] },
  }),

  /**
   * Usage baseline of an API call (input side + output start). Fields like Claude's message_start.
   *
   * `provider`: the provider BEHIND a router that delivered this round (OpenRouter field `provider` of the response,
   * `connectors/openai-chat.js`) — at `message.provider`, the way Claude's real message_start carries `message.model`
   * there. runs/do-run.js shows it together with its window in the context bar (display only). Without a name the
   * field is missing: the event stays byte-identical.
   */
  usageStart: ({ input = 0, cacheRead = 0, cacheCreate = 0, output = 0, provider = "" } = {}) => ({
    type: "stream_event",
    event: {
      type: "message_start",
      message: {
        usage: {
          input_tokens: input,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreate,
          output_tokens: output,
        },
        ...(provider ? { provider: String(provider) } : {}),
      },
    },
  }),
  /** Cumulative output count of a call. */
  usageDelta: (output = 0) => ({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: output } } }),

  /**
   * Terminal event. `error` marks the turn as FAILED.
   *
   * The Claude CLI sets `is_error` on its result event, runs/do-run.js reads it and keeps the text as limit evidence
   * (limitEvidence). The engine needs to say the same: otherwise a turn aborted at the usage limit looks like a
   * finished response in the stream. Without `error` the event stays byte-identical — the normal case does not change
   * its wire format.
   */
  result: (text, sessionId, error = "") => ({
    type: "result",
    result: text ?? "",
    session_id: sessionId,
    ...(error ? { is_error: true, error: { message: String(error) } } : {}),
  }),
};

/** Marks an event as a subagent event (runs/do-run.js renders it nested + does NOT count it toward the context). */
export const withParent = (evt, parentId) => (parentId ? { ...evt, parent_tool_use_id: parentId } : evt);

// ── Canonical tool names ───────────────────────────────────────────────────────
// So that AssistantBlocks renders every provider identically (Write→diff, Bash→<pre>, TodoWrite→list …), built-in
// tools MUST carry the same names/shapes as with Claude. Central source:
// EXCEPTION TodoWrite: the Claude CLI replaced it (no longer in the toolset since 2.1.x) and keeps its task list via
// TaskCreate/TaskUpdate/TaskList/TaskGet. The engine keeps TodoWrite because a call there carries the whole list; the
// clients render both forms as the same list.

export const BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "Bash", "BashOutput", "KillShell",
  // No `Skill`: cbase disables the native tool via --disallowedTools, guides come for every provider via `cbase_skill`.
  "WebFetch", "WebSearch", "TodoWrite", "Monitor", "TaskStop", "Task", "ExitPlanMode",
  "ScheduleWakeup", "ToolSearch", "ListMcpResources", "ReadMcpResource", "SlashCommand", "LSP", "Debugger",
];

/** Tools for which the clients show a DIFF (canonical names — incl. Codex's apply_patch). */
export const DIFF_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"];

/** Codex item type → Claude tool name (mcp_tool_call becomes mcp__<server>__<tool>, see mcpToolName). */
export const CODEX_TOOL_NAME = { command_execution: "Bash", file_change: "apply_patch" };

// ── Model references "[provider::]model" ───────────────────────────────────────
// ONE string carries provider AND model. That way every field that already takes a model (agent definition, model
// argument of the Task tool, app agent setting) also selects the provider — without every signature needing a second
// parameter. Without a prefix the reference means the provider of the respective run, so "opus" stays "the Opus of
// THIS provider".
//
// Deliberately only the SYNTAX lives here. Whether the prefix is a known provider only the registry knows — the
// resolution therefore lives in providers/index.js (resolveModelRef).
export const MODEL_REF_SEP = "::";

/** "openai::gpt-5" → {provider:"openai", model:"gpt-5"}; "opus" → {provider:"", model:"opus"}. raw = trimmed input. */
export function parseModelRef(ref) {
  const raw = String(ref ?? "").trim();
  const i = raw.indexOf(MODEL_REF_SEP);
  if (i < 0) return { provider: "", model: raw, raw };
  return { provider: raw.slice(0, i).trim(), model: raw.slice(i + MODEL_REF_SEP.length).trim(), raw };
}

/** Inverse — without provider it stays the bare model id (then applies to the provider of the run). */
export const formatModelRef = (provider, model) =>
  (provider ? `${String(provider)}${MODEL_REF_SEP}${String(model ?? "")}` : String(model ?? ""));

export const isMcpToolName = (n) => typeof n === "string" && n.startsWith("mcp__");
export const mcpToolName = (server, tool) => `mcp__${server}__${tool}`;
/** Splits mcp__<server>__<tool> → { server, tool }; null if not an MCP name. */
export function parseMcpToolName(name) {
  if (!isMcpToolName(name)) return null;
  const rest = name.slice(5);
  const i = rest.indexOf("__");
  if (i < 0) return { server: rest, tool: "" };
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

// ── Material of a one-time call ───────────────────────────────────────────────
//
// A oneshot (`runOnce`) is not a conversation but carries the same material: images and documents. If every connector
// built its oneshot message ITSELF, the two paths would drift apart: `caps.vision` says "yes", `runOnce` silently drops.
//
// Hence here: ONE place that turns prompt and material into neutral blocks. Every connector sends the result through
// its EXISTING translator — so the oneshot path can no longer do less than the conversation path without it showing.
//
// Without material the plain string comes back on purpose: the normal case must not change its wire format just
// because there is a second case now.
export function materialMessage(prompt, { images = [], documents = [] } = {}) {
  const text = String(prompt ?? "");
  const gut = (b) => b?.mime && b?.dataB64;
  const list = (v) => (Array.isArray(v) ? v.filter(gut) : []);
  const imageList = list(images);
  const documentsValue = list(documents);
  if (!imageList.length && !documentsValue.length) return { role: "user", content: text };
  return {
    role: "user",
    // The text FIRST: it explains what the material is and that it is data — the other way round the model would see
    // foreign material before it knows how to handle it.
    content: [
      { type: "text", text },
      ...imageList.map((b) => ({ type: "image", source: { type: "base64", media_type: b.mime, data: b.dataB64 } })),
      ...documentsValue.map((b) => ({ type: "document", name: b.name || "", source: { type: "base64", media_type: b.mime, data: b.dataB64 } })),
    ],
  };
}

// ── caps normalization + validators ────────────────────────────────────────────

/**
 * Fills missing caps with false (a connector does not have to set all fields).
 *
 * `vision` and `documents` are two axes and explicitly not one: "can look at images" is not "accepts a PDF". A prompt
 * that refers to material that never arrived is worse than one without material.
 *
 * There is no `subagents`: EVERY provider starts subagents via the core (cbase_agent, providers/agent-runtime.js). A
 * stored override (`providers.caps`) or an older client that sends the field stays valid: this allowlist drops it.
 */
export function normalizeCaps(caps = {}) {
  return {
    ownsAgentLoop: !!caps.ownsAgentLoop,
    nativeToolCalling: !!caps.nativeToolCalling,
    streaming: !!caps.streaming,
    reasoning: !!caps.reasoning,
    vision: !!caps.vision,
    documents: !!caps.documents,
    permissionPrompt: !!caps.permissionPrompt,
    fork: !!caps.fork,
    effort: !!caps.effort,
    plan: !!caps.plan,
    // Prefix cache: does the provider read an identical prompt beginning from the cache? Only then does a dynamic
    // workflow stagger similar agents (dynworkflows/cap.js).
    prefixCache: !!caps.prefixCache,
  };
}

/** Checks the required fields of a spec. → array of error messages (empty = valid). */
export function validateSpec(spec) {
  if (!spec || typeof spec !== "object") return ["spec is not an object"];
  const errs = [];
  if (typeof spec.systemPrompt !== "string") errs.push("systemPrompt must be a string");
  if (typeof spec.input !== "string") errs.push("input must be a string");
  if (typeof spec.cwd !== "string" || !spec.cwd) errs.push("cwd must be a non-empty string");
  if (typeof spec.permissionMode !== "string" || !spec.permissionMode) errs.push("permissionMode must be a non-empty string");
  return errs;
}

/** Minimal check of an emitted event. → array of error messages (empty = valid). */
export function validateEvent(evt) {
  if (!evt || typeof evt !== "object" || typeof evt.type !== "string") return ["event needs a string 'type'"];
  return [];
}

/** Checks whether an object fulfils the basic connector shape (for registering). */
export function validateConnector(c) {
  const errs = [];
  if (!c || typeof c !== "object") return ["connector is not an object"];
  if (typeof c.id !== "string" || !c.id) errs.push("connector.id required");
  if (typeof c.resolveModel !== "function") errs.push("connector.resolveModel required");
  if (typeof c.cleanEnv !== "function") errs.push("connector.cleanEnv required");
  if (typeof c.runOnce !== "function") errs.push("connector.runOnce required");
  const caps = normalizeCaps(c.caps);
  if (caps.ownsAgentLoop && typeof c.runChat !== "function") errs.push("native connector needs runChat");
  if (!caps.ownsAgentLoop && typeof c.complete !== "function") errs.push("completion connector needs complete");
  return errs;
}

/**
 * The coding MCP servers of an agent definition (field `mcp`, toolchain/agent-mcp.js): `{ serverId: null | [tool] }`
 * cleaned, `null` without a choice. The core (agent-runtime.js) carries them on the agent (also in the stored image,
 * only with a choice — otherwise it stays byte-identical), the spec factory computes from them with the client's set.
 * Not an argument of the call: what a type brings along, the human sets at the definition.
 */
export function mcpOfTheType(def) {
  const m = def?.mcp;
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const out = {};
  for (const [id, w] of Object.entries(m)) {
    if (w === null) out[id] = null;
    else if (Array.isArray(w) && w.length) out[id] = w.map(String);
  }
  return Object.keys(out).length ? out : null;
}
