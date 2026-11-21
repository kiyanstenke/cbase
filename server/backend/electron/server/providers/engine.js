// engine.js — the generic agentic loop engine.
//
// Drives completion providers (caps.ownsAgentLoop:false), which can only do ONE round (connector.complete), to a full
// agentic run — so they fulfil the same Claude stream-json event contract as Claude/Codex. Contains: tool loop,
// built-in tools (tool-runtime), MCP client, permission gate, token bookkeeping in Claude shape, resume via
// transcript. It does not start subagents itself: as with Claude and Codex only via cbase_agent (MCP) and the agent
// core (ENGINE_NOT_PROVIDED).
//
// Everything provider-specific lives in the connector (wire format ↔ neutral messages). The engine is neutral.
import crypto from "node:crypto";
import { ev } from "./contract.js";
import { detectLimitHit } from "../limits.js";
import { pdfImages } from "../doctext.js";
import { connectMcpServers, mcpResourceBlocks, mcpResultBlocks } from "./mcp-client.js";
import { builtinToolDefs, isBuiltinTool, newRegexDeadline, runBuiltinTool, killBackgroundShells } from "./tool-runtime.js";
import { enforce } from "./permission-gate.js";
// The run's hooks (process, deadline, stdin, instance, LFS environment) — ONE path with the core's "SubagentStop".
import { fireAgentHook, executeHook, matchingHooks } from "./hook-run.js";
// The reported costs of a round (OpenRouter `usage.cost`, see connectors/consumption.js) — all or nothing per run.
import { generationsPlus, combinedCost, withCostMissing } from "./connectors/consumption.js";
import { readInRuntimeFolder } from "../runs/runtime-limit.js";
// The structured-output tool name — the same as in the MCP server.
import { STRUCTURE_TOOL } from "../../mcp/visibility.js";
import { catalogRow } from "../../mcp/first-set.js";
import { cpuWaitEvent } from "../../mcp/cpu-saver.js"; // "save computing power"

const MAX_STEPS = 60;        // safety net against endless tool loops (per conversation)
// The wording of the cap: on stderr and, for a subagent, in the result event (is_error). Deliberately without
// "limit"/"rate" — it is not a usage limit, and limits.detectLimitHit reads a turn's error texts as possible limit evidence.
const STEP_CAP_TEXT = `Step cap of the loop engine reached: ${MAX_STEPS} tool rounds in one turn without completion — the last text is an interim state, not a finished answer.`;
// In the MAIN RUN the cap is not an error but a hint in the history (see runConversation).
const STEP_CAP_HINT = `[Harness hint: ${STEP_CAP_TEXT} A new turn (say "continue") resumes the work.]`;
const MAX_NUDGES = 2;         // corrections per turn: "tool call as text instead of function call" and "thought, not acted"
const COMPACT_AT = 0.78;      // from this share of the context window on, compaction is automatic
const DEFAULT_CONTEXT_WINDOW = 128_000;
const MAX_RETRIES = 3;        // repetitions on transient API errors (429/5xx/network)
const MAX_TOOL_TEXT = 60_000; // text share of ONE tool result (like MAX_OUTPUT of the tool runtime)

// Display version of a tool result: image data out. The clients render an image from a tool result as "[Image]"
// (web, iOS) and the DB stores exactly that — the base64 body would only bloat the SSE stream and the database.
function displayContent(content) {
  if (!Array.isArray(content)) return content;
  return content.map((b) => {
    if (b?.type === "image") return { type: "text", text: "[Image]" };
    if (b?.type === "document") return { type: "text", text: `[PDF${b.name ? `: ${b.name}` : ""}]` };
    return b;
  });
}

/**
 * A document block (PDF) for a provider that takes NO documents.
 *
 * Three cases, and all three occur:
 *   1. The provider takes documents → the block stays as it is (not here).
 *   2. It takes only images → the raster images embedded in the PDF. That rescues scans and exported charts, but NO
 *      drawn diagrams; that must be said, otherwise the model takes the few images for the whole content.
 *   3. It takes nothing → the text extract in the neighbouring block is all there is, and that is said.
 */
function documentPlaceholder(block, conn) {
  const data = block?.source?.data;
  if (!data) return [];
  if (!conn?.caps?.vision) {
    return [{ type: "text", text: "[This provider cannot look at the pages of the PDF — you do NOT see figures and diagrams in it.]" }];
  }
  let images = [];
  try { images = pdfImages(Buffer.from(data, "base64")); } catch { /* then none */ }
  if (!images.length) {
    return [{ type: "text", text: "[This provider takes no PDF document, and the PDF contains no embedded image — you do NOT see diagrams in it.]" }];
  }
  return [
    { type: "text", text: `[This provider takes no PDF document. The ${images.length} figures embedded in the PDF follow; DRAWN diagrams are NOT among them.]` },
    ...images.map((b) => ({ type: "image", source: { type: "base64", media_type: b.mime, data: b.buffer.toString("base64") } })),
  ];
}

// Prepare a tool result for THIS provider. A result can carry blocks (image from an MCP tool, image from Read). If the
// provider cannot take images, everything is folded to text — otherwise we would send base64 to a pure text model and
// pay for it too.
export function resultContentFor(content, conn) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  // A document block the provider does not take is REPLACED instead of thrown away: either by the embedded images or
  // by the statement that the pages are missing. Thrown away, the history would look like a completely read PDF.
  const raw = conn?.caps?.documents
    ? content
    : content.flatMap((b) => (b?.type === "document" ? documentPlaceholder(b, conn) : [b]));
  const asText = (b) => (b?.type === "text" ? String(b.text || "") : b?.type === "image" ? "[Image]" : b?.type === "document" ? "[PDF]" : JSON.stringify(b));
  const fold = () => {
    const s = raw.map(asText).filter(Boolean).join("\n");
    return s.length > MAX_TOOL_TEXT ? s.slice(0, MAX_TOOL_TEXT) + "\n… [truncated]" : s;
  };
  if (!conn?.caps?.vision || !raw.some((b) => b?.type === "image" || b?.type === "document")) return fold();
  const out = [];
  let budget = MAX_TOOL_TEXT;
  for (const b of raw) {
    if (b?.type === "image" || b?.type === "document") { out.push(b); continue; }
    const t = asText(b);
    if (!t || budget <= 0) continue;
    out.push({ type: "text", text: t.length > budget ? t.slice(0, budget) + "\n… [truncated]" : t });
    budget -= t.length;
  }
  return out.length ? out : "";
}

// Quota 429 ≠ overload 429. Providers send the same status for two opposite facts; repeating a 429 on an exhausted
// quota means certain failed attempts with backoff before the finding gets up at all.
//
// The distinction is made by the error body, because that is what arrives here: the connectors throw
// `HTTP <status> <text> — <body, 400 characters>`. The response HEADERS are already discarded at this point — hence
// no retry-after here.
//
// From the error documents of both providers:
//   Anthropic 429 tier spend cap → type `rate_limit_error`, but `details.error_code: "enforced_spend_limit_reached"`,
//     NO retry-after; self-set cap → 400 "You have reached your specified API usage limits"; 402 `billing_error`.
//   OpenAI 429 not repeatable → `insufficient_quota` ("You exceeded your current quota"), `credit_balance_exhausted`,
//     `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded`.
//   Still repeatable: bare rate_limit/"sending requests too quickly"/`slow_down` (with retry-after), 5xx and 529
//     `overloaded_error`.
const QUOTA_PATTERN = [
  /enforced_spend_limit_reached/i,
  /insufficient_quota/i,
  /credit_balance_exhausted/i,
  /(?:organization|project)_spend_limit_exceeded/i,
  /organization_usage_limit_exceeded/i,
  /billing_hard_limit_reached/i,
  /billing_error/i,
  /you have reached your (?:specified )?(?:workspace )?api usage limits/i,
  /exceeded your current quota/i,
  /credit balance (?:is )?too low/i,
  /quota[ _]?exceeded/i,
  /usage limit reached/i,
  /you'?ve hit your usage limit/i,
];

/** Quota exhausted? Then repeating changes nothing — the finding belongs up at once. */
export function isQuotaError(err) {
  const m = String(err?.message || err);
  return QUOTA_PATTERN.some((re) => re.test(m));
}

// Does the error prove a usage limit? Deliberately THE SAME table runs/auto-continue.js uses for parking
// (limits.detectLimitHit) — otherwise the engine would take for an answer what the server takes for a limit, and the
// run would end with exit 0 while the waiting never happened. Plus the quota wordings above: an exhausted quota is a
// limit abort even if limits.js does not (yet) know its wording.
const isLimitError = (err) => isQuotaError(err) || detectLimitHit({ stderr: String(err?.message || err) }).hit;

// Transient, repeatable error? (classified by the error message — connectors throw Error with HTTP status/network cause)
function isTransientError(err) {
  if (isQuotaError(err)) return false; // exhausted quota: repeating only costs time
  const m = String(err?.message || err).toLowerCase();
  return /\b(429|500|502|503|504|529)\b/.test(m)
    || /overload|rate.?limit|econnreset|etimedout|timed? ?out|fetch failed|socket hang up|network|temporarily|unavailable/.test(m);
}

// Tool discipline for completion models: some output calls as JSON in the answer text instead of executing them via
// function calling — then nothing happens. Stands in EVERY engine run.
const TOOL_DISCIPLINE = [
  "",
  "# Tool calls",
  "You call tools EXCLUSIVELY through the native function-calling mechanism.",
  "Never output tool calls as JSON, pseudocode or an announcement in the answer text — a call output as text is NOT executed. Do not announce calls, execute them directly.",
  "Answer with plain text only when no more tool calls are needed.",
].join("\n");

// The run's environment: the Claude CLI and Codex tell the model working directory, platform and date by themselves —
// the engine lacked that, and a third-party model guessed paths. The system prompt carries only what STANDS across the
// chat (working directory, additional directories, platform): the system prompt is the foremost part of the prompt
// cache, and what changes there costs the whole history.
// The DATE is therefore NOT here but a line before the turn's input (`dateLine`) — and only if the history does not
// carry that date yet: the turn is stored with this line and replayed byte-equal (runs/do-run.js, role `input`), so
// no prefix breaks, not even across midnight.
export function environmentBlock({ cwd = "", addDirs = [], instance = null } = {}) {
  const extra = (Array.isArray(addDirs) ? addDirs : []).filter(Boolean);
  return [
    "",
    "# Environment",
    `- Working directory: ${cwd || "(none)"} — relative paths in Read, Write, Edit, Glob, Grep and Bash apply from here.`,
    `- Additional directories: ${extra.length ? extra.join(", ") : "none"}`,
    `- Platform: ${instance ? "linux (project container)" : process.platform}`,
    "- Today's date stands as a line “[Today is YYYY-MM-DD.]” before a message as soon as it changes.",
  ].join("\n");
}
// Today's date (server local time) as YYYY-MM-DD.
export function todayIso(now = new Date()) {
  const z = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${z(now.getMonth() + 1)}-${z(now.getDate())}`;
}
export const dateLine = (iso) => `[Today is ${iso}.]`;
// Reads both forms: chats stored before the rename carry the German line "[Heute ist der YYYY-MM-DD.]" in their history.
const DATE_ROW = /\[(?:Today is|Heute ist der) (\d{4}-\d{2}-\d{2})\.\]/g;

// Detection of a tool call output only as text: a JSON object (or a list of them) with "name"/"function"/"tool" on a
// KNOWN tool name that OPENS or CLOSES the answer — that is what the slip looks like (the call alone, in a ```json
// fence or as <tool_call>, behind an announcement "I read the file: {…}", with a short sentence remainder "I call {…}
// now."). A mere mention of a tool in running text does not trigger — and neither does a QUOTE: an answer that quotes
// a stream-json row from a log must not get the hint. So not a call is: an object in the middle of a sentence (more
// than a short sentence remainder behind it), one in a Markdown quote line, a content block of a history
// (`"type":"tool_use"`/`"tool_result"` — that is how a call stands in a log, not in the slip), one without valid JSON,
// and with a sentence remainder one without arguments (a tool definition "{"name":"Read","description":…}.").
// Guard: server/backend/test/engine-harness.test.js.
const TEXTUAL_FENCE_FRONT = /^(?:```[\w-]*[ \t]*\n|<(?:tool_call|function_call)>\s*)/i;
const TEXTUAL_FENCE_REAR = /(?:```|<\/(?:tool_call|function_call)>)$/i;
// The end of the JSON value that begins at `start` (`{` or `[`), with strings and escapes — or -1.
function jsonEnd(s, start) {
  const stack = [];
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") inString = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}
// The beginning of the JSON value that ends at `end` (`}` or `]`) — backwards, a string recognised by the unescaped `"`.
function jsonBeginning(s, end) {
  const stack = [];
  let inString = false;
  const masked = (i) => { let n = 0; for (let k = i - 1; k >= 0 && s[k] === "\\"; k--) n++; return n % 2 === 1; };
  for (let i = end; i >= 0; i--) {
    const c = s[i];
    if (c === "\"" && !masked(i)) { inString = !inString; continue; }
    if (inString) continue;
    if (c === "}" || c === "]") stack.push(c === "}" ? "{" : "[");
    else if (c === "{" || c === "[") {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}
const TEXTUAL_SENTENCE_REMAINDER = /[}\]]([^{}[\]"\n]{1,12})$/;
const WITH_ARGS = (o) => ["arguments", "input", "parameters", "args"].some((k) => k in o)
  || Boolean(o.function && typeof o.function === "object" && "arguments" in o.function);
function callName(value, toolNames, { withArgs = false } = {}) {
  const candidates = Array.isArray(value) ? value : [value];
  for (const o of candidates) {
    if (!o || typeof o !== "object" || Array.isArray(o)) continue;
    if (o.type === "tool_use" || o.type === "tool_result") continue; // a block from a history/log, not a call
    if (withArgs && !WITH_ARGS(o)) continue;
    const f = o.function;
    for (const n of [o.name, o.tool, o.tool_name, typeof f === "string" ? f : f?.name]) {
      if (typeof n === "string" && toolNames.has(n)) return n;
    }
  }
  return null;
}
function detectTextualToolCall(text, toolNames) {
  const raw = String(text || "").trim();
  if (!raw || !/"(?:name|function|tool|tool_name)"\s*:/.test(raw)) return null;
  const s = raw.replace(TEXTUAL_FENCE_FRONT, "").trim().replace(TEXTUAL_FENCE_REAR, "").trim();
  const attempts = (a, e, opts) => {
    if (a < 0 || e < 0) return null;
    // A Markdown quote line ("> …") is a quote, not a call.
    const lineStart = s.lastIndexOf("\n", a - 1) + 1;
    if (/^\s*>/.test(s.slice(lineStart, a + 1))) return null;
    try { return callName(JSON.parse(s.slice(a, e + 1)), toolNames, opts); } catch { return null; }
  };
  // The answer OPENS with the call …
  if (s[0] === "{" || s[0] === "[") {
    const name = attempts(0, jsonEnd(s, 0));
    if (name) return name;
  }
  // … or CLOSES with it (also behind an announcement, never mid-sentence) …
  const last = s.length - 1;
  if (s[last] === "}" || s[last] === "]") return attempts(jsonBeginning(s, last), last);
  // … or with it and a short sentence remainder on the same line ("I call {…} now.") — then only in call form (with arguments).
  const rest = TEXTUAL_SENTENCE_REMAINDER.exec(s);
  if (rest) {
    const end = s.length - 1 - rest[1].length;
    return attempts(jsonBeginning(s, end), end, { withArgs: true });
  }
  return null;
}

// "Thought, not acted": a round that ended regularly, with thinking only — without answer text, without a call
// (`turn.thinkingWithoutResponse`, set by connectors/openai-chat.js). Two facts have this shape, and the connector
// cannot tell them apart:
//   - the answer is in the thinking channel (a model that did not close its thinking block);
//   - the model wanted to act and did not ("I'll attempt the stop call." — the tool was not on offer, and the
//     monologue became the answer).
// So the engine follows up ONCE — but only if the thinking names a tool this run knows (`namesTool`: offered, deferred
// or ToolSearch itself), and tools are offered. Otherwise — and without tools (sampling, compaction) — the old rule
// applies at once: the thinking text is the answer, ONE request. This here is that rule.
export function thinkingAsResponse(turn) {
  if (!turn?.thinkingWithoutResponse) return turn || {};
  return { ...turn, text: String(turn.thinking || "").trim(), thinking: "" };
}

// Does a thinking text name one of these tools — as a WHOLE word, with or without the `mcp__<server>__` prefix? Word
// characters are letters, digits and "_" (snake_case: "tool_3" is not in "tool_30", "cbase_dynamic_workflow" not in
// "cbase_dynamic_workflow_stop"), case counts ("Bash" yes, "bashful" and "bash" no — otherwise every English "read",
// "write" or "task" would be an intention). Returns the full name of the first hit, otherwise null.
// Guard: server/backend/test/engine-harness.test.js.
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
function asWord(text, name) {
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) {
    const before = i > 0 ? text[i - 1] : "";
    const to = text[i + name.length] ?? "";
    if (!(before && WORD_CHARACTER.test(before)) && !(to && WORD_CHARACTER.test(to))) return true;
  }
  return false;
}
export function namesTool(text, names) {
  const s = String(text || "");
  if (!s) return null;
  for (const full of names) {
    if (!full) continue;
    const short = String(full).replace(/^mcp__.+?__/, "");
    if (asWord(s, full) || (short && short !== full && asWord(s, short))) return full;
  }
  return null;
}

// Do NOT put a follow-up hint as a second user message behind a user message: chat templates with a strict role
// order (Mistral/Magistral, Gemma under vLLM: "Conversation roles must alternate user/assistant") reject that with
// 400. If the last message is a user message of pure text (string or text/image blocks without a tool result), the
// hint goes to it as a paragraph; otherwise (behind tool results — a user entry is allowed there) as a message of its
// own. The message is REPLACED, not mutated (the object can come from the transcript).
function attachUserTextTo(messages, text) {
  const last = messages[messages.length - 1];
  if (last?.role === "user" && typeof last.content === "string") {
    messages[messages.length - 1] = { ...last, content: `${last.content}\n\n${text}` };
  } else if (last?.role === "user" && Array.isArray(last.content) && last.content.length
    && last.content.every((b) => b?.type === "text" || b?.type === "image")) {
    messages[messages.length - 1] = { ...last, content: [...last.content, { type: "text", text }] };
  } else {
    messages.push({ role: "user", content: text });
  }
}

// Assistant text in `messages` in the shape `transcript.js:buildTranscript` later builds it from the DB (`pushText`):
// trimmed, and pure whitespace is dropped entirely (`runs/do-run.js` does not store it at all). Only then does the
// first request of the next run begin with the bytes of the last one of this run: if a text ended in "\n", the prefix
// broke at exactly this message; a text of pure whitespace stood as a block of its own in the history, which the
// transcript does not know. Applies ONLY to the history: the events to the user (text deltas, answer rows, `result`)
// stay raw.
const asHistoryText = (text) => String(text ?? "").trim();

const THINKING_FOLLOW_UP_HINT = (withToolSearch) => [
  "[Harness hint: Your last round ended with deliberations only — without an answer to the user and without a tool call; NOTHING was executed.",
  "If you want to use a tool, call it now through the native function-calling mechanism.",
  withToolSearch ? "If it is not in your tool list, load it first with ToolSearch (\"select:<name>\")." : "",
  "Otherwise answer the user now.]",
].filter(Boolean).join(" ");
const TEXT_FOLLOW_UP_HINT = (name) => `[Harness hint: You output the tool call "${name}" only as text — it was NOT executed. Call the tool now through the native function-calling mechanism, without JSON in the answer text.]`;

// Neutral message format (Anthropic-like): { role, content: string | Block[] }.
// Blocks: {type:"text",text} | {type:"tool_use",id,name,input} | {type:"tool_result",tool_use_id,content,is_error}.

/**
 * Main build: completion connector → RunResult, while onEvent gets Claude-shaped events.
 * @param {import('./contract.js').Connector} connector
 * @param {{spec:import('./contract.js').Spec, onEvent:Function, onSpawn?:Function}} a
 */
export async function runChatViaEngine(connector, { spec, onEvent, onSpawn }) {
  const sessionId = spec.sessionId || crypto.randomUUID();
  const controller = new AbortController();
  let aborted = false;
  const narrow = spec.engine || {};
  // Depth of this run below the chat: 0 = the chat itself, n = a subagent on level n (runs/agents.js sets
  // `agentDepth`). Delegation only goes via cbase_agent — the MCP server draws the depth limit there
  // (mcp/visibility.js); here the mark only carries ExitPlanMode and the step cap.
  const depthOfTheRun = Math.max(0, Number(spec.agentDepth) || 0);
  // A completion provider has no permanently open CLI process. This handle still models the same interactive run
  // semantics as Claude: after an answer the engine stays idle while monitors are open and can take over a
  // monitor/user message.
  let inputOpen = true;
  let idle = false;
  let wakeInput = null;
  const pendingInputs = [];
  // Readjusting MID-turn (cbase_agent_send to a running subagent): the message arrives in the next tool round — behind
  // the tool results, before the next model request, as with the Claude CLI via stdin; if the model calls no more
  // tool, it still goes into THIS turn (one more model request, one result).
  const controlInputs = [];
  const takeControl = (messages) => {
    if (!controlInputs.length) return false;
    const text = controlInputs.splice(0).join("\n\n");
    messages.push({ role: "user", content: text });
    // Like every user message of the chat run: stored, so that the next run replays it (see runConversation).
    if (depthOfTheRun === 0) onEvent({ type: "cbase_input", text });
    return true;
  };
  const wake = () => { const fn = wakeInput; wakeInput = null; fn?.(); };
  // Internal continuation: a finished background agent or an ended background command begins a new turn BY ITSELF —
  // exactly like the Claude CLI. Unlike cbaseInject (the server's user/monitor injection) this may also happen
  // mid-turn: the message then waits in pendingInputs until the running turn is finished.
  let runFinished = false; // from here nobody listens any more (no event into a dead run)
  const injectInternal = (text) => {
    const value = String(text || "").trim();
    if (!value || aborted || !inputOpen || runFinished) return false;
    pendingInputs.push(value);
    if (idle) { idle = false; wake(); }
    return true;
  };
  const runHandle = {
    kill: () => {
      aborted = true;
      inputOpen = false;
      try { controller.abort(); } catch {}
      wake();
    },
    cbaseInject: (text) => {
      if (!inputOpen || aborted || !idle) return false;
      const value = String(text || "").trim();
      if (!value) return false;
      idle = false; // the engine takes over exactly one injection; further ones stay queued on the server side
      pendingInputs.push(value);
      wake();
      return true;
    },
    // Readjusting mid-turn (see controlInputs). `false` ⇒ the run accepts nothing any more (finished, aborted, closed).
    controlCbase: (text) => {
      const value = String(text || "").trim();
      if (!value || aborted || !inputOpen || runFinished) return false;
      controlInputs.push(value);
      return true;
    },
    cbaseEndInput: () => {
      if (!inputOpen) return;
      inputOpen = false;
      wake();
    },
  };
  onSpawn?.(runHandle);

  const cwd = spec.cwd;
  const environment = environmentBlock({ cwd, addDirs: spec.addDirs || [], instance: spec.instance || null });
  let seenDate = ""; // the date this run's history names last (see `dateLine`)
  // signal: an abort also aborts running foreground tools (Bash/WebFetch); runId: only the background shells of THIS
  // run are ended at the end (bgShells is shared process-wide).
  // onBackgroundShell: sign of life of a `Bash(run_in_background)`. The notices are byte-equal with those of the
  // Claude CLI (system/task_started|task_updated) — runs/do-run.js keeps the run open through them and shows
  // "N tasks running", without a special path for the engine.
  const toolCtx = {
    cwd, addDirs: spec.addDirs || [], env: process.env, signal: controller.signal, runId: sessionId,
    // The run's instance: fixed at the turn start; Bash starts in its container, the environment then goes along as an
    // allowlist (runtime/inProject.js). `null` = no instance.
    instance: spec.instance || null,
    webSearch: narrow.webSearch || null, // real search API instead of DuckDuckGo scraping, if configured
    // "Save computing power": only with `spec.saver` (background agent, switch on) — Bash waits under full load and
    // runs under nice; the waiting goes into the stream as the same event as the Claude CLI's hook
    // (`system/hook_progress` with the mark on stderr, at the end `system/hook_response`) — ONE reader in agent-runtime.js.
    ...(spec.saver === true ? {
      saver: true,
      onCpuWait: ({ enabled, text }) => {
        if (runFinished) return;
        onEvent(cpuWaitEvent(enabled, text));
      },
    } : {}),
    onBackgroundShell: (e) => {
      // The teardown at the run end kills remaining shells — their "ended" no longer belongs in the stream, otherwise
      // runs/do-run.js books background work on a run that no longer exists.
      if (runFinished) return;
      if (e.event === "started") {
        onEvent({ type: "system", subtype: "task_started", task_id: e.id, tool_use_id: e.toolUseId || null, description: String(e.command || "").slice(0, 160) });
        return;
      }
      onEvent({ type: "system", subtype: "task_updated", task_id: e.id, patch: { status: e.exitCode === 0 ? "completed" : "failed" } });
      injectInternal([
        `[Background command ended: ${String(e.command || "").slice(0, 200)} (bash_id ${e.id}, exit code ${e.exitCode})]`,
        String(e.tail || "").trim() || "(no Output)",
        "",
        "Evaluate the result and keep working. This is a system message, not a user answer.",
      ].join("\n"));
    },
  };
  let mode = spec.permissionMode || "bypassPermissions"; // ExitPlanMode can change it at runtime
  const requestPermission = narrow.requestPermission; // from runs/do-run.js (runs/permissions.js:requestPermission): → /permission-request long poll
  const hooks = Array.isArray(narrow.hooks) ? narrow.hooks : []; // [{event, matcher, command}] — Claude-Code-like hooks
  // Permanent approvals ("Bash(git status:*)"). A rule remembered in the run applies at once, so that the same command
  // does not ask again even before the setting is saved.
  const allowRules = Array.isArray(narrow.allowRules) ? [...narrow.allowRules] : [];
  const model = connector.resolveModel(spec.model);
  // Context window of a model (for auto-compaction) — from the model list of ITS provider. A function, because a
  // subagent can run at another provider with another window.
  const contextWindowOf = (conn, id) => (conn.models || []).find((m) => m.id === id)?.context || DEFAULT_CONTEXT_WINDOW;
  const ctxWindow = contextWindowOf(connector, model);
  // Share of the window from which compaction happens within the run: the harness's level (spec.compactAt, see
  // autocompact.js), otherwise the own safety valve COMPACT_AT.
  const compactAt = Number(spec.compactAt) > 0 ? Number(spec.compactAt) : COMPACT_AT;
  // Exact token sums of the WHOLE run (all API rounds) — the basis of third-party cost accounting. input includes
  // cached (as computed by the provider).
  // `cost`: the costs (USD) REPORTED by OpenRouter — only if EVERY round with consumption carried an amount, otherwise
  // null (consumption.js `combinedCost`: half reported counts as not reported, then the price table computes, whole).
  // `upstream`: the provider behind the router that delivered the LAST round ('' = none named).
  // `cacheWrite` (where the provider reports it) and `generations` (the generation ids of the OpenRouter responses —
  // the booking carries them so that a missing amount can be asked for later; consumption.js generationsPlus).
  const runUsage = { input: 0, output: 0, cached: 0, cacheWrite: 0, calls: 0, model, cost: null, upstream: "", generations: [] };
  // …and the same numbers BROKEN DOWN by (provider, model, main/subagent). A single sum would be wrong as soon as a
  // subagent runs at another provider: runs/do-run.js would assign the whole run to a price list in which half of the
  // tokens were never consumed.
  const usageParts = new Map();
  // Parts whose costs are unknown before they have tokens (a round that broke off after the response head) — the mark
  // waits here until the part is created: a part without tokens would be booked by do-run.js as an empty row.
  const missingParts = new Set();
  // The generation ids of a round (also an aborted one — then the only trace of its amount), per part, until the part
  // is created. If it never is (the ONLY round of this part broke off), it goes out at the end as a part without
  // tokens (see `partsWithWaiting`).
  const waitingGenerations = new Map(); // key → { provider, model, kind, generations }
  function tallyUsage(providerId, modelId, u, kind, provider = "") {
    const inTok = Number(u?.input) || 0, outTok = Number(u?.output) || 0, cachedTok = Number(u?.cached) || 0, writeTok = Number(u?.cacheWrite) || 0;
    const key = `${providerId}|${modelId}|${kind}`;
    const genList = [...(Array.isArray(u?.generationsPrior) ? u.generationsPrior : []), ...(typeof u?.generationId === "string" && u.generationId ? [u.generationId] : [])];
    const gen = genList.length ? genList : undefined;
    // The costs BEFORE the tokens: `combinedCost` asks whether the state so far carries tokens WITHOUT an amount.
    runUsage.cost = combinedCost(runUsage, u);
    if (gen) runUsage.generations = generationsPlus(runUsage.generations, gen);
    if (u?.costMissing === true) { runUsage.costMissing = true; missingParts.add(key); }
    // A round that carries ONLY the mark (aborted, tokens unknown): not a round in the sense of the count, no new part.
    if (!inTok && !outTok && !cachedTok && u?.costMissing === true) {
      const p0 = usageParts.get(key);
      if (p0) { p0.cost = null; p0.costMissing = true; if (gen) p0.generations = generationsPlus(p0.generations, gen); }
      else if (gen) {
        waitingGenerations.set(key, { provider: providerId, model: modelId, kind, generations: generationsPlus(waitingGenerations.get(key)?.generations, gen) });
      }
      return;
    }
    runUsage.input += inTok; runUsage.output += outTok; runUsage.cached += cachedTok; runUsage.cacheWrite += writeTok; runUsage.calls += 1;
    if (provider) runUsage.upstream = String(provider);
    let part = usageParts.get(key);
    if (!part) {
      part = { provider: providerId, model: modelId, kind, input: 0, output: 0, cached: 0, cacheWrite: 0, calls: 0, cost: null, upstream: "",
        generations: waitingGenerations.get(key)?.generations ?? [] };
      waitingGenerations.delete(key);
      if (missingParts.has(key)) part.costMissing = true;
      usageParts.set(key, part);
    }
    part.cost = combinedCost(part, u);
    if (u?.costMissing === true) part.costMissing = true;
    if (gen) part.generations = generationsPlus(part.generations, gen);
    part.input += inTok; part.output += outTok; part.cached += cachedTok; part.cacheWrite += writeTok; part.calls += 1;
    if (provider) part.upstream = String(provider);
  }
  // The parts for the booking: the counted ones and, per part whose ONLY round broke off after the response head (user
  // stop, network drop), one without tokens with its generation ids and `costMissing` — otherwise the booking would
  // get no part and the amount OpenRouter charged could never be asked for. An overflowed part (ids `null`) has no
  // trace left — without tokens and without an id there would be nothing that ever puts a figure on it.
  const partsWithWaiting = () => [...usageParts.values(), ...[...waitingGenerations.values()]
    .filter((w) => Array.isArray(w.generations) && w.generations.length)
    .map((w) => ({ provider: w.provider, model: w.model, kind: w.kind, input: 0, output: 0, cached: 0, cacheWrite: 0, calls: 0, cost: null,
      upstream: "", generations: w.generations, costMissing: true }))];
  // A round whose `complete` threw AFTER the provider had accepted (mark on the error, consumption.js
  // `withCostMissing`): it cost something, the amount is unknown ⇒ the run's costs become unknown.
  const tallyAbort = (providerId, modelId, e, kind) => {
    if (e?.costMissing === true) {
      tallyUsage(providerId, modelId, { input: 0, output: 0, cached: 0, costMissing: true, ...(e.generationId ? { generationId: String(e.generationId) } : {}),
        ...(Array.isArray(e.generationsPrior) ? { generationsPrior: e.generationsPrior } : {}) }, kind);
    }
  };
  // Vision: image attachments as image blocks — only if the connector can do vision (otherwise dormant).
  const visionBlocks = [];
  if (connector.caps?.vision && Array.isArray(spec.attachments)) {
    for (const att of spec.attachments) {
      if (!att || !/^image\//.test(att.mime || "")) continue;
      // If the image lies in the runtime folder of a relocated project, the backend reads it through the checked
      // descriptor: an attachment the project container has replaced by a link to the outside is none.
      try { visionBlocks.push({ type: "image", source: { type: "base64", media_type: att.mime, data: readInRuntimeFolder(att.path, { instance: spec.instance || undefined }).toString("base64") } }); } catch { /* not readable → skip */ }
    }
  }

  let stderr = "";
  // Diagnostics that must survive even a CLEANLY ending run: `stderr` reaches runs/do-run.js only on an error
  // (exit ≠ 0 → run_error), on exit 0 it is dropped. So these rows go ADDITIONALLY into the server's log. Only for
  // rare things — an MCP server that did not connect, a follow-up "thought, not acted" —, never per round.
  const diagnosticRow = (row) => {
    stderr += `${row}\n`;
    try { console.error(`[engine ${String(sessionId).slice(0, 8)}] ${row}`); } catch { /* log closed */ }
  };
  onEvent(ev.systemInit(sessionId));
  // SessionStart may give the run context (e.g. ticket number, environment) — as in Claude Code.
  let sessionContext = "";

  // Sampling counter of the run: how many server requests have been answered already, and the chain that queues them.
  let samplingCounted = 0;
  let samplingChain = Promise.resolve();
  const samplingCap = () => Number(process.env.CBASE_MCP_SAMPLING_MAX) || 20;

  // Coding MCP servers run through the airlock's wrapper (toolchain/mcp-config.js): the backend decides choice and
  // card at every call — the engine does NOT ask for them itself (otherwise two cards, the first with "remember").
  // Recognised by the run token in the entry's env; the plan mode stays what it is.
  const airlockPrefixes = Object.entries(spec.mcpServers || {}).filter(([, e]) => e?.env?.CBASE_AIRLOCK !== undefined).map(([n]) => `mcp__${n}__`);
  const overAirlock = (n) => typeof n === "string" && airlockPrefixes.some((p) => n.startsWith(p));
  // Connect MCP servers (cbase + playwright + own ones) — exactly spec.mcpServers.
  // onServerRequest answers server→client requests: sampling/createMessage lets a server query the model of THIS run,
  // roots/list names the allowed working roots to it.
  const pool = await connectMcpServers(spec.mcpServers || {}, {
    cwd,
    instance: spec.instance || null,
    onServerRequest: async (method, params) => {
      if (method === "roots/list") {
        return { roots: [cwd, ...(spec.addDirs || [])].filter(Boolean).map((r) => ({ uri: `file://${r}`, name: r })) };
      }
      if (method !== "sampling/createMessage") return null;
      // Sampling costs a model call on the user's bill, and an MCP SERVER triggers it, not the model and not the
      // human — without a counter and a cap a foreign server could ask any number of times per tool call. So only
      // while the run lives, one request at a time, and at most `samplingCap()` per run; above that a refusal that
      // says it is a cap (the server gets it as a JSON-RPC error).
      if (aborted || runFinished) throw new Error("Sampling refused: the run has ended.");
      if (samplingCounted >= samplingCap()) {
        diagnosticRow(`[mcp] sampling cap reached (${samplingCap()} per run) — further requests refused`);
        throw new Error(`Sampling cap reached: at most ${samplingCap()} model requests per run.`);
      }
      samplingCounted++;
      const prior = samplingChain;
      let free;
      samplingChain = new Promise((r) => { free = r; });
      try { await prior; return await samplingResponse(params); } finally { free(); }
    },
  });
  // Answer a sampling request of an MCP server — the server gets an answer of the chat model, without tools and without
  // access to the history: it is ITS request, not the user's.
  async function samplingResponse(params) {
    const msgs = (params.messages || []).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content?.text === "string" ? m.content.text : (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")),
    }));
    if (params.systemPrompt) msgs.unshift({ role: "system", content: String(params.systemPrompt) });
    let t;
    try { t = await connector.complete({ messages: msgs, tools: [], model, effort: "", signal: controller.signal, onDelta: () => {} }); }
    catch (e) { tallyAbort(connector.id, model, e, "main"); throw e; }
    tallyUsage(connector.id, model, t && t.usage, "main", t && t.provider);
    return { role: "assistant", content: { type: "text", text: thinkingAsResponse(t).text || "" }, model, stopReason: "endTurn" };
  }
  for (const err of pool.errors) diagnosticRow(`[mcp:${err.server}] ${err.error}`);

  // ── Which tools this run has ─────────────────────────────────────────────────────────────────────────────────
  // ONE answer for offer, catalog of deferred tools, ToolSearch, follow-up detection AND execution. If the cuts only
  // applied to the OFFER per round, the catalog in the system prompt and ToolSearch would name and deliver excluded
  // tools too, and a call under a name not offered would go unchecked to the MCP server. The Claude CLI cuts the same
  // via allowedTools, Codex via `enabled_tools` (mcp-client.js cuts the server likewise) — here the list also applies
  // at the execution (`execTool`). The cuts:
  //   • spec.builtinTools (list; [] = none) — the counterpart of Claude's --tools; applies to EVERYTHING the harness
  //     provides itself (built-in tools, plan, MCP resources and prompts), MCP tools stay untouched;
  //   • spec.agentTools (tool list of a subagent; `mcp__<server>__*` = whole server) — also applies EMPTY;
  //   • the depth: `ExitPlanMode` only in the run of the chat itself;
  //   • ENGINE_NOT_PROVIDED: Task, Monitor, TaskStop, ScheduleWakeup are not provided by the engine — not at the
  //     execution either (a resumed history may still name them).
  // ToolSearch is exempt from all of them: the engine offers it itself as soon as it defers — it only loads schemas,
  // and only from the already cut catalog.
  const agentToolsAllowed = (name) => !Array.isArray(spec.agentTools)
    || spec.agentTools.some((e) => e === name || (typeof e === "string" && e.endsWith("*") && name.startsWith(e.slice(0, -1))));
  function toolAllowed(name) {
    const n = String(name || "");
    if (n === "ToolSearch") return true;
    if (!n.startsWith("mcp__") && Array.isArray(spec.builtinTools) && !spec.builtinTools.includes(n)) return false;
    if (ENGINE_NOT_PROVIDED.has(n)) return false;
    if (n === "ExitPlanMode" && depthOfTheRun > 0) return false;
    return agentToolsAllowed(n);
  }

  // Tool catalog: built-in + plan + MCP resources/prompts + MCP.
  // CORE are the tools sent along in every round; MCP tools are candidates for loading later via ToolSearch (see
  // below). Both only as far as the run has them (`toolAllowed`).
  // Monitor, TaskStop, ScheduleWakeup and Task are NOT provided by the engine: they were doubles of
  // cbase_monitor/_monitor_stop, cbase_wakeup and cbase_agent — the same runtime or the same core —, and the base rule
  // (runs/system-prompt.js) names exactly these cbase tools, as for Claude (where the native ones are blocked) and
  // Codex (which has none). One tool per purpose, the same for every provider.
  let coreDefs = [...builtinToolDefs()];
  if (mode === "plan") coreDefs.push(EXITPLAN_DEF); // plan mode: implementation only after the ExitPlanMode approval
  if (pool.resources.length) coreDefs.push(...mcpResourceDef(pool.resources));
  if (pool.prompts.length) coreDefs.push(mcpPromptDef(pool.prompts));
  coreDefs = coreDefs.filter((t) => toolAllowed(t.name));
  const mcpTools = pool.tools.filter((t) => toolAllowed(t.name));

  // ── Deferred tool schemas ──────────────────────────────────────────────────────
  // Up to this threshold the model gets ALL schemas. Above it the MCP tools move into a catalog of names and short
  // descriptions; the model fetches their full schema on demand via ToolSearch. With more than 80 tools the schema
  // package was otherwise a context item paid again in EVERY round — and a selection task weaker models fail at.
  // Read at EVERY call, not frozen at import — otherwise a measurement would silently measure the production value.
  const DEFER_ABOVE = Number(process.env.CBASE_DEFER_ABOVE || 45) || 45;
  // The messenger StructuredOutput never behind ToolSearch: an agent with a schema should see it without searching —
  // it only exists if the run carries a schema.
  // The STOP tools likewise: stopping often happens turns later, for another cause, by a model that no longer has the
  // catalog in view — and the start note of a workflow names exactly this way.
  // And the START tools of the same families likewise: a model that saw only the stop called it to start a workflow.
  // Rule: a family whose stop is always visible shows its start too. Deliberately not included (they are not
  // start-stop pairs): _send/_output/cbase_agents_list for cbase_agent, _list/_save for cbase_dynamic_workflow — they
  // stay behind ToolSearch. All only take effect where the server offers them (mcp/visibility.js: subagents and
  // workflow agents never get monitor and workflow tools, workflow agents not the agent family either, and
  // `cbase_agent`/`_stop` stand only up to the depth limit) — the engine offers what the server delivers.
  const ALWAYS_ON = new Set([
    "mcp__cbase__cbase_ask", "mcp__cbase__cbase_monitor", "mcp__cbase__cbase_wakeup", `mcp__cbase__${STRUCTURE_TOOL}`,
    "mcp__cbase__cbase_dynamic_workflow", "mcp__cbase__cbase_dynamic_workflow_stop",
    "mcp__cbase__cbase_monitor_stop", "mcp__cbase__cbase_agent", "mcp__cbase__cbase_agent_stop",
    // The graph workflows by the same pair rule — start and stop always, the state (cbase_workflow_status) behind
    // ToolSearch.
    "mcp__cbase__cbase_workflow_start", "mcp__cbase__cbase_workflow_stop",
  ]);
  const total = coreDefs.length + mcpTools.length;
  const defer = total > DEFER_ABOVE;
  const deferredDefs = defer ? mcpTools.filter((t) => !ALWAYS_ON.has(t.name)) : [];
  const eagerMcp = defer ? mcpTools.filter((t) => ALWAYS_ON.has(t.name)) : mcpTools;
  if (defer) coreDefs.push(TOOLSEARCH_DEF);
  const baseDefs = [...coreDefs, ...eagerMcp];
  const deferredIndex = new Map(deferredDefs.map((t) => [t.name, t]));
  const toolDefs = [...baseDefs, ...deferredDefs]; // whole catalog (dispatch + nudge detection)
  const toolNameSet = new Set(toolDefs.map((t) => t.name));
  // Short name → full name. Prompt, agenda block and tool descriptions name MCP tools by their short name
  // ("cbase_agenda", "browser_take_screenshot") — as the Claude CLI shows them to the model, the same text for all
  // providers. But the engine knows them only as `mcp__<server>__<name>`. So: a name the run does not know and that is
  // not an `mcp__` name is mapped to the ONE tool whose full name ends in `__<name>`. Several candidates (the same
  // short name at two servers) ⇒ no guessing, but a refusal with the full names. A built-in tool (Read, Bash, …) and
  // ToolSearch stay as they are named. Guard: server/backend/test/engine-prompt-audit.test.js.
  function fullName(name) {
    const n = String(name || "");
    if (!n || n.startsWith("mcp__") || toolNameSet.has(n) || n === "ToolSearch" || isBuiltinTool(n)) return { name: n };
    const candidates = toolDefs.map((t) => t.name).filter((v) => v.startsWith("mcp__") && v.endsWith(`__${n}`));
    if (candidates.length === 1) return { name: candidates[0] };
    if (candidates.length > 1) return { name: n, ambiguous: candidates };
    return { name: n };
  }
  const ambiguousText = (n, candidates) => `The tool name "${n}" is ambiguous — it can mean: ${candidates.join(", ")}. Give the full name.`;
  // Tools loaded via ToolSearch stay loaded — for the WHOLE run, not just the turn: otherwise, after a user message, a
  // completion notice, a monitor event or an alarm, what the model had just loaded would be missing — while the
  // history shows it "These tools are callable from now on." and a successful call (execution side and description
  // side would give different answers). A NEW run (fresh doRun, server restart) rebuilds them from the transcript
  // (`activateFromHistory`). The prompt cache gets more stable through this: the tool list of the next turn is the
  // end state of the last one instead of falling back to the core set.
  const activated = new Set();
  const activateSelect = (query) => {
    const q = String(query || "").trim();
    if (!/^select:/i.test(q)) return;
    for (const raw of q.slice(7).split(",").map((s) => s.trim())) {
      const n = fullName(raw).name; // the same mapping as live (toolSearch), otherwise the rebuild would load less
      if (deferredIndex.has(n)) activated.add(n);
    }
  };
  // From a transcript message: the same rule as live (`toolSearch`) — loaded is only what a SUCCESSFUL ToolSearch
  // loaded (its tool_result is not an error): every name of its "select:" and every hit the result delivered as
  // `<function>` (also of a keyword search). A failed ToolSearch loads nothing: the model saw the failure in the
  // history, and the request must not show it anything else. A DIRECT call of a deferred tool loads nothing either:
  // live it does not activate it (the dispatch by name executes it anyway), and if it counted at the rebuild, the
  // first request of the next run would carry one tool more than the last of the previous one — a cache break before
  // all messages. Names this run does not know (another set, server gone) silently drop out — `deferredIndex` is the
  // truth.
  const toolSearchRequests = new Map(); // tool_use id → query
  const activateFromHistory = (content) => {
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type === "tool_use") {
        if (b.name === "ToolSearch" && b.id) toolSearchRequests.set(b.id, b.input?.query);
      } else if (b?.type === "tool_result" && !b.is_error && toolSearchRequests.has(b.tool_use_id)) {
        activateSelect(toolSearchRequests.get(b.tool_use_id));
        const text = typeof b.content === "string" ? b.content
          : Array.isArray(b.content) ? b.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("") : "";
        for (const m of text.matchAll(/<function>([\s\S]*?)<\/function>/g)) {
          try { const n = JSON.parse(m[1])?.name; if (deferredIndex.has(n)) activated.add(n); } catch { /* not a schema */ }
        }
      }
    }
  };
  // Hint for the system prompt: WHICH tools there still are — name and the FIRST SENTENCE of the description. The
  // sentence comes from mcp/first-set.js — the same function with which the length guard keeps every cbase sentence at
  // 160 characters at most; `catalogRow` caps foreign MCP tools at 200 characters + "…".
  const deferredNote = deferredDefs.length
    ? [
      "",
      "# Deferred tools",
      `In addition to the tools passed above, ${deferredDefs.length} more are available. Their schemas are NOT sent along — so you do not know their parameters. Therefore fetch the schema before the first call with ToolSearch (one request, several names possible: "select:name1,name2"); after that the tool is in your list like any other.`,
      ...deferredDefs.map((t) => `- ${t.name}: ${catalogRow(t.description)}`),
    ].join("\n")
    : "";

  // ── Hooks (Claude-Code-like) ─────────────────────────────────────────────────
  // Configured shell commands at agent events. The command gets the event as JSON on stdin; PreToolUse can BLOCK a
  // tool (exit code 2 or stdout {"decision":"block"}), PostToolUse/UserPromptSubmit can deliver ADDITIONAL CONTEXT
  // (stdout {"additionalContext":"…"} or raw text). Executing and matching live in hook-run.js — ONE path for the
  // hooks of this run and the "SubagentStop" of the subagent core (runs/agents.js). It reads the deadline per hook.
  const matchHooks = (event, toolName) => matchingHooks(hooks, event, toolName);
  const runHook = (command, payload) => executeHook(command, payload, { instance: spec.instance || null, cwd });
  const parseHookOut = (s) => { try { return JSON.parse(String(s).trim()); } catch { return null; } };
  // Events without an effect back (SessionEnd, Notification, PreCompact, Stop): only report. The core fires "SubagentStop".
  async function fireNotifyHook(event, payload = {}) {
    if (!hooks.length) return;
    await fireAgentHook(event, payload, { hooks, instance: spec.instance || null, cwd, sessionId });
  }
  async function firePreTool(toolName, toolInput) {
    for (const h of matchHooks("PreToolUse", toolName)) {
      const r = await runHook(h.command, { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd });
      const p = parseHookOut(r.out);
      const decision = p?.decision || p?.hookSpecificOutput?.permissionDecision;
      if (r.code === 2 || decision === "block" || decision === "deny") {
        return { block: true, reason: p?.reason || p?.hookSpecificOutput?.permissionDecisionReason || r.err.trim() || `The PreToolUse hook blocked ${toolName}.` };
      }
    }
    return { block: false };
  }
  async function fireContextHook(event, payload) {
    let extra = "";
    for (const h of matchHooks(event, payload.tool_name)) {
      const r = await runHook(h.command, { hook_event_name: event, ...payload, cwd });
      const p = parseHookOut(r.out);
      const ctx = p?.hookSpecificOutput?.additionalContext ?? p?.additionalContext ?? (p ? "" : r.out.trim());
      if (ctx) extra += (extra ? "\n" : "") + String(ctx);
    }
    return extra;
  }

  // ToolSearch: load schemas of deferred tools later. "select:a,b" picks specifically, otherwise the search goes over
  // name and description. The hits are activated for the rest of THIS RUN (conv.active = `activated`, across all
  // turns) — from the next round on they are in the tool package.
  function toolSearch(args, conv) {
    const query = String(args?.query || "").trim();
    const max = Math.max(1, Math.min(25, Number(args?.max_results) || 5));
    if (!query) return { content: "query is missing.", isError: true };
    let hits = [];
    if (/^select:/i.test(query)) {
      const raw = query.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
      const resolved = raw.map((n) => ({ raw: n, ...fullName(n) }));
      const ambiguous = resolved.filter((x) => x.ambiguous);
      if (ambiguous.length) return { content: ambiguous.map((x) => ambiguousText(x.raw, x.ambiguous)).join("\n"), isError: true };
      const wanted = resolved.map((x) => x.name);
      const missing = wanted.filter((n) => !deferredIndex.has(n));
      hits = [...new Set(wanted)].map((n) => deferredIndex.get(n)).filter(Boolean);
      // Nothing deferred (small set) and still a ToolSearch — models know it from Claude Code: not an error but the
      // information that everything is already loaded.
      if (!hits.length && !deferredIndex.size) return { content: "All tools of this chat are already loaded — call them directly.", isError: false };
      if (!hits.length) return { content: `None of these tools is deferred: ${missing.join(", ")}. Maybe it is already available or has a different name.`, isError: true };
    } else {
      const required = query.split(/\s+/).filter((w) => w.startsWith("+")).map((w) => w.slice(1).toLowerCase());
      const terms = query.split(/\s+/).map((w) => w.replace(/^\+/, "").toLowerCase()).filter(Boolean);
      hits = [...deferredIndex.values()]
        .filter((t) => required.every((r) => t.name.toLowerCase().includes(r)))
        .map((t) => {
          const hay = `${t.name} ${t.description || ""}`.toLowerCase();
          return { t, score: terms.reduce((s, w) => s + (t.name.toLowerCase().includes(w) ? 2 : 0) + (hay.includes(w) ? 1 : 0), 0) };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, max)
        .map((x) => x.t);
      if (!hits.length) return { content: `No deferred tools found for "${query}".`, isError: false };
    }
    for (const t of hits) conv.active.add(t.name);
    const body = hits.map((t) => `<function>${JSON.stringify({ description: t.description || "", name: t.name, parameters: t.inputSchema || { type: "object", properties: {} } })}</function>`).join("\n");
    return { content: `<functions>\n${body}\n</functions>\nThese tools are callable from now on.`, isError: false };
  }

  // Pure tool dispatch (after tool cut, gate and pre-hook — see execTool). → {content, isError}.
  async function dispatch(name, args, id, depth, conv) {
    if (name === "ToolSearch") return toolSearch(args, conv);
    if (name === "ListMcpResources") {
      const list = pool.resources.filter((r) => !args?.server || r.server === args.server);
      if (!list.length) return { content: "No MCP resources available.", isError: false };
      return { content: list.map((r) => `- ${r.server} · ${r.uri}${r.name && r.name !== r.uri ? ` (${r.name})` : ""}${r.description ? ` — ${r.description}` : ""}`).join("\n"), isError: false };
    }
    if (name === "ReadMcpResource") {
      const uri = String(args?.uri || "");
      const entry = pool.resources.find((r) => r.uri === uri && (!args?.server || r.server === args.server));
      if (!entry) return { content: `Unknown resource: ${uri}`, isError: true };
      try { return { content: mcpResourceBlocks(await pool.readResource(entry.server, uri)), isError: false }; }
      catch (e) { return { content: `Resource not readable: ${e?.message || e}`, isError: true }; }
    }
    if (name === "McpPrompt") {
      const entry = pool.prompts.find((pr) => pr.name === args?.name && (!args?.server || pr.server === args.server));
      if (!entry) return { content: `Unknown MCP prompt: ${args?.name}`, isError: true };
      try {
        const r = await pool.getPrompt(entry.server, entry.name, args?.arguments || {});
        const text = (r?.messages || [])
          .map((mm) => `${mm.role || "user"}: ${typeof mm.content?.text === "string" ? mm.content.text : JSON.stringify(mm.content ?? "")}`)
          .join("\n\n");
        return { content: text || "(empty prompt)", isError: false };
      } catch (e) { return { content: `Prompt not retrievable: ${e?.message || e}`, isError: true }; }
    }
    // `toolCtx.regexDeadline` carries the tool round's budget for the model's regular expressions (Grep), set per
    // round in runConversation.
    if (isBuiltinTool(name)) return runBuiltinTool(name, args, { ...toolCtx, toolUseId: id });
    if (name.startsWith("mcp__")) {
      // The call id in `_meta`, as Claude Code passes it: a cbase_agent start finds its block that way. Only to the
      // OWN server — a foreign MCP server gets no cbase identifiers.
      const r = await pool.call(name, args, name.startsWith("mcp__cbase__") ? { "cbase/toolUseId": id } : undefined);
      // Blocks instead of text: a screenshot stays an image until resultContentFor decides whether the provider of
      // this conversation can see it at all.
      return { content: mcpResultBlocks(r), isError: !!r.isError };
    }
    return { content: `Unknown tool: ${name}`, isError: true };
  }

  // ── Tool execution (pre-hook → permission gate → execution → post-hook) ──────
  async function execTool(call, emit, depth, conv) {
    const { id, input } = call;
    // The short name of an MCP tool counts like its full name (see `fullName`) — for cut, gate, hooks and execution.
    const resolved = fullName(call.name);
    if (resolved.ambiguous) return { content: ambiguousText(call.name, resolved.ambiguous), isError: true };
    const name = resolved.name;
    // The run's tool cut (see `toolAllowed`) applies at the EXECUTION, not only at the offer: the dispatch goes by
    // NAME, and a model (or a resumed history of an earlier, wider set) can name any name. Before hook, gate and
    // card — a tool the run does not have is not an approval question.
    if (!toolAllowed(name)) return { content: `The tool ${name} is not available in this chat.`, isError: true };
    // ExitPlanMode IS the plan approval (not an ordinarily gated tool): trigger the same card as in Claude Code. On
    // "implement" the harness leaves plan mode and keeps working.
    if (name === "ExitPlanMode") {
      if (mode !== "plan") return { content: "Not in plan mode — ExitPlanMode is moot here.", isError: false };
      if (typeof requestPermission !== "function") { mode = "acceptEdits"; return { content: "Plan mode left (no question possible).", isError: false }; }
      let dec;
      try { dec = await requestPermission({ toolName: "ExitPlanMode", input: { plan: input?.plan || "" }, toolUseId: id }); }
      catch (e) { return { content: `Plan approval failed: ${e?.message || e}`, isError: true }; }
      if (dec && dec.behavior === "allow") { mode = "acceptEdits"; return { content: "Plan approved — begin the implementation.", isError: false }; }
      return { content: (dec && dec.message) || "The user wants to keep planning. Stay in plan mode and refine the plan.", isError: false };
    }
    // PreToolUse hook: can block the tool BEFORE gate/execution.
    if (hooks.length) {
      const pre = await firePreTool(name, input);
      if (pre.block) return { content: pre.reason, isError: true };
    }
    // Permission gate (including the permanent "do not ask again" rules). The Notification hook fires exactly when
    // the run waits for the user — that is what it is for in Claude Code.
    const askWithNotice = typeof requestPermission === "function"
      ? async (a) => { await fireNotifyHook("Notification", { tool_name: a.toolName, message: "Approval required" }); return requestPermission(a); }
      : undefined;
    const gate = overAirlock(name) && mode !== "plan" ? { allow: true, input } : await enforce({
      toolName: name, input, mode, toolUseId: id, requestPermission: askWithNotice,
      allowRules, rememberRule: (rule) => { allowRules.push(rule); narrow.rememberRule?.(rule); },
    });
    if (!gate.allow) return { content: gate.message || "Rejected", isError: true };
    const args = gate.input || input;

    const res = await dispatch(name, args, id, depth, conv);

    // PostToolUse hook: may append additional context to the result.
    if (hooks.length) {
      const flat = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
      const extra = await fireContextHook("PostToolUse", { tool_name: name, tool_input: args, tool_response: flat.slice(0, 8000) });
      // If the result carries blocks (image!), the context is added as a text block of its own — otherwise the image
      // would be lost when gluing everything into a string.
      if (extra) {
        res.content = Array.isArray(res.content)
          ? [...res.content, { type: "text", text: `[Hook context]\n${extra}` }]
          : `${flat}\n\n[Hook context]\n${extra}`;
      }
    }
    return res;
  }

  // ── Robust completion (retry/backoff) ──────────────────────────────────────────
  // Repeats transient API errors with exponential backoff + jitter — like the Claude Code harness.
  // Important: repeat ONLY while NO delta has been emitted yet (otherwise text would be streamed twice).
  // A reported tool start (`toolStart`) counts too: its row already stands in web and iOS, and the repeated round
  // would give the call a NEW id — the old row would never get input and result and would show as running until the
  // run end. Without a repetition the run ends with the error. The price: a round that streams ONLY a call (without
  // text, without thinking before it) and then breaks off is not repeated.
  async function completeWithRetry(conn, args, emit) {
    let attempt = 0;
    // A repeated attempt that failed AFTER the response head (`costMissing` on the error) cost something — the mark
    // passes on to the result or the last error, otherwise it would vanish with the repetition.
    let missingPrior = false;
    // The generation ids of the failed attempts: their amount can be fetched by asking later — they pass on with the
    // result or the last error (tallyUsage `generationsPrior`).
    const genPrior = [];
    for (;;) {
      let sawDelta = false;
      try {
        const t = await conn.complete({ ...args, onDelta: (d) => { sawDelta = true; args.onDelta?.(d); } });
        return missingPrior ? { ...t, usage: { ...(t?.usage || {}), costMissing: true, ...(genPrior.length ? { generationsPrior: genPrior } : {}) } } : t;
      } catch (e) {
        if (e?.costMissing === true) missingPrior = true;
        if (missingPrior) withCostMissing(e);
        if (e?.generationId) genPrior.push(String(e.generationId));
        if (genPrior.length > 1 && e && typeof e === "object") { try { e.generationsPrior = genPrior.slice(0, -1); } catch { /* frozen */ } }
        if (aborted) throw e;
        attempt++;
        if (sawDelta || attempt > MAX_RETRIES || !isTransientError(e)) throw e;
        const backoff = Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 300);
        emit?.({ type: "harness", subtype: "retry", attempt, max: MAX_RETRIES, error: String(e?.message || e).slice(0, 200) });
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  // ── Auto-compaction ────────────────────────────────────────────────────────────
  // Summarises the whole history (except the system prompt) and replaces it with the summary — so no unpaired
  // tool_use/tool_result is left behind (which some APIs reject).
  async function compact(messages, emit, useModel = model, conn = connector, kind = "main") {
    await fireNotifyHook("PreCompact", { trigger: "auto", messages: messages.length });
    const system = messages[0];
    const body = messages.slice(1);
    const sumMessages = [
      { role: "system", content: "Summarise this agent's work history so far briefly but completely: the goal, decisions made, important tool results (files, findings, numbers), steps done and still open. Output ONLY the summary." },
      ...body.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: typeof m.content === "string" ? m.content : JSON.stringify(m.content).slice(0, 4000) })),
      { role: "user", content: "Produce the summary now." },
    ];
    let summary = "";
    try {
      const t = await conn.complete({ messages: sumMessages, tools: [], model: useModel, effort: "", signal: controller.signal, onDelta: () => {} });
      // The (possibly large) summary request costs tokens too → add it to the run sum.
      tallyUsage(conn.id, useModel, t && t.usage, kind, t && t.provider);
      summary = thinkingAsResponse(t).text || "";
    } catch (e) {
      tallyAbort(conn.id, useModel, e, kind);
      // Best effort: could not compact → continue unchanged. The reason still belongs on stderr: if compaction fails
      // at the usage limit, the next call often fails on the oversized context — and its wording conceals the limit.
      // Without this row the run would arrive as a context error and would not be parked.
      stderr += `[compact] ${e?.message || e}\n`;
    }
    if (!summary) return;
    messages.length = 0;
    messages.push(system, { role: "user", content: `[Auto-compaction by the cbase harness — summary of the history so far]\n${summary}` });
    emit({ type: "harness", subtype: "compacted", chars: summary.length });
  }

  // ── One conversation ───────────────────────────────────────────────────────────
  async function runConversation({ systemPrompt, input, transcript = [], messages: priorMessages = null, emit, depth, modelOverride = null, conn = connector }) {
    // On a monitor/user injection the complete message history of this engine is kept. Only at the first turn are the
    // system prompt and the persisted transcript built up.
    const messages = priorMessages || [{ role: "system", content: systemPrompt + environment + TOOL_DISCIPLINE + deferredNote }];
    if (!priorMessages) {
      // content is either text OR a block array (tool_use/tool_result) — runs/system-prompt.js (buildEngineTranscript)
      // builds a complete transcript including tool history from the persisted history.
      for (const t of transcript) {
        messages.push({
          role: t.role === "assistant" ? "assistant" : "user",
          content: Array.isArray(t.content) ? t.content : String(t.content ?? ""),
        });
        // What the history shows as loaded IS loaded (see `activated`) — also after a restart.
        activateFromHistory(t.content);
        // Which date the history already names (see `dateLine`).
        if (t.role !== "assistant" && typeof t.content === "string") for (const m of t.content.matchAll(DATE_ROW)) seenDate = m[1];
      }
    }
    // UserPromptSubmit hook (top level only): may put additional context in front of the prompt.
    let userInput = input;
    if (depth === 0 && hooks.length) {
      const extra = await fireContextHook("UserPromptSubmit", { prompt: input });
      if (extra) userInput = `${input}\n\n[Hook context]\n${extra}`;
    }
    // The date, if the history does not carry it yet (see `environmentBlock`).
    if (depth === 0) {
      const today = todayIso();
      if (today !== seenDate) { seenDate = today; userInput = `${dateLine(today)}\n\n${userInput}`; }
    }
    // Vision: attach the image blocks to the first (top-level) prompt.
    const userContent = (!priorMessages && depth === 0 && visionBlocks.length) ? [{ type: "text", text: userInput }, ...visionBlocks] : userInput;
    messages.push({ role: "user", content: userContent });
    // What EXACTLY goes out as the user message — including prefixes (agenda, hints, ultracode, summary), hook context
    // and date line. runs/do-run.js stores it as a row of the role `input`, and buildTranscript replays EXACTLY this
    // text in the next run instead of what was typed: otherwise every new run would begin with the bare user text, the
    // prefix cache would break at the first user message, and the model would no longer know the agenda (only
    // prefixed in the first turn of a session) from turn 2 on. Only the run of the chat itself (depth 0) — a subagent
    // has no history anyone replays. Not a stream event to the clients (do-run.js does not pass it on).
    if (depth === 0 && depthOfTheRun === 0) emit({ type: "cbase_input", text: userInput });

    let finalText = "";
    let errored = false; // did the loop break off because of a complete() error?
    let limitAbort = false; // … and was the reason a usage limit?
    let errorText = "";      // wording of this error (evidence for the server's limit check)
    let nudges = 0; // text-instead-of-call turns already followed up (and "thought, not acted" — one cap for both)
    // The round whose "thought, not acted" was followed up last — its thinking is the answer if the followed-up round
    // delivers nothing usable (empty, thinking only, at the limit, request failed). Set only for the ONE round after;
    // at most one follow-up in a row.
    let followUpRound1 = null;
    // The harness hint of this follow-up (thought, not acted — or call as text instead of function call) — it rides
    // ONLY in the ONE followed-up request (a shallow copy of `messages`, see below), never in the history itself: the
    // transcript does not know it (no event, no DB row), and if it stood in `messages`, the first request of the next
    // run would deviate from the last of this run at this user message. The rounds after therefore no longer see it —
    // intended: it was for the one round. Only exception: call as text with a connector with signed thinking blocks —
    // there the hint stands in the history (see at the slip below).
    let followUpHint = "";
    let lastInput = 0; // input tokens of the last turn (for auto-compaction)
    // Model of this conversation. A foreign connector always comes with an explicit model; the fallback to its default
    // is only a safety net.
    const convModel = modelOverride || (conn === connector ? model : conn.resolveModel(""));
    const convCtxWindow = conn === connector ? ctxWindow : contextWindowOf(conn, convModel);
    const kind = depth > 0 ? "sub" : "main";
    // Which deferred tools are activated via ToolSearch: the set of the RUN (see `activated`), not of the turn. A
    // subagent is a run of its own (cbase_agent goes to the core) and therefore begins with the core set plus what
    // ITS transcript shows as loaded.
    const conv = { active: activated };
    // The offer of THIS round: core + loaded deferred tools. Both are already cut (`toolAllowed` at the catalog);
    // subagent allowlist and depth thus apply equally to offer and execution. The condition `depth > 0` is a legacy —
    // today runConversation is only called with depth 0.
    const toolsForTurn = () => [...baseDefs, ...deferredDefs.filter((t) => conv.active.has(t.name))]
      .filter((t) => !(depth > 0 && t.name === "ExitPlanMode"));

    // `step` lives beyond the loop: if it stands at MAX_STEPS afterwards, the turn ended at the step cap (every other
    // exit is a `break` and leaves it below — a follow-up or readjustment in the last step counts too).
    let step = 0;
    for (; step < MAX_STEPS; step++) {
      if (aborted) break;
      // Auto-compaction: if the history approaches the context window, summarise the history and continue with the
      // summary (instead of failing at the window) — as in the Claude Code harness.
      if (lastInput > compactAt * convCtxWindow && messages.length >= 4) {
        await compact(messages, emit, convModel, conn, kind);
        lastInput = 0;
      }
      let turn;
      const offered = toolsForTurn(); // the tools of THIS round — also the question whether a follow-up can change anything
      const fromRound1 = followUpRound1; // is THIS round the followed-up one? (see `followUpRound1`)
      followUpRound1 = null;
      // The messages of THIS request: the history, in the followed-up round including the hint (see `followUpHint`) —
      // appended via attachUserTextTo (never two user roles in a row), but to a copy.
      let requestMessages = messages;
      if (followUpHint) {
        requestMessages = messages.slice();
        attachUserTextTo(requestMessages, followUpHint);
        followUpHint = "";
      }
      // The answer from round 1: its thinking, now as text (live as a text delta, in the history as the answer).
      const responseFromRound1 = (reason) => {
        diagnosticRow(`[engine] followed up, ${reason} — the thinking of the first round is the answer`);
        const text = thinkingAsResponse(fromRound1).text || "";
        if (!aborted && text) emit(ev.textDelta(text));
        return text;
      };
      // The BEGINNING of a tool call while the round still streams: the connector reports it as soon as id and name
      // are there (`toolStart`), the engine passes it on as `content_block_start`/tool_use — like the Claude CLI.
      // Otherwise a call would only arrive as a finished `assistant` event AFTER the round, and while a model streams
      // the arguments the web would show nothing. Display only: request, history and DB rows stay as they were (the
      // tool row is still created at the `toolUse` below, with the same id). ONCE per id and round. After a start
      // `completeWithRetry` no longer repeats the round — the same rule as for text (see there).
      const started = new Set();
      try {
        turn = await completeWithRetry(conn, {
          messages: requestMessages, tools: offered, model: convModel, effort: spec.effort || "",
          signal: controller.signal,
          onDelta: (d) => {
            if (aborted) return;
            if (d.text) emit(ev.textDelta(d.text));
            if (d.thinking) emit(ev.thinkingDelta(d.thinking));
            const w = d.toolStart;
            if (w && typeof w.id === "string" && w.id && typeof w.name === "string" && w.name && !started.has(w.id)) {
              started.add(w.id);
              emit(ev.toolUseStart(w.id, w.name));
            }
          },
        }, emit);
      } catch (e) {
        tallyAbort(conn.id, convModel, e, kind);
        if (aborted) break;
        // The followed-up request failed (after the retries): do not abort the run — the first round HAD an answer
        // (its thinking), and before the follow-up exactly that would have arrived. The error is on stderr/in the log.
        if (fromRound1) {
          const text = responseFromRound1(`but the request failed (${String(e?.message || e).slice(0, 300)})`);
          if (text) {
            emit(ev.assistantText(text));
            messages.push({ role: "assistant", content: asHistoryText(text) });
            finalText = text;
            break;
          }
        }
        stderr += `[complete] ${e?.message || e}\n`;
        errored = true;
        errorText = String(e?.message || e);
        limitAbort = isLimitError(e);
        break;
      }

      // Token bookkeeping in Claude shape (cached ⊆ input, as with Codex).
      const u = turn.usage || {};
      tallyUsage(conn.id, convModel, u, kind, turn.provider);
      lastInput = u.input || 0; // full input side (incl. cached) = actual context size
      const input_ = Math.max(0, (u.input || 0) - (u.cached || 0));
      emit(ev.usageStart({ input: input_, cacheRead: u.cached || 0, cacheCreate: 0, output: 0, provider: turn.provider })); // provider: display only (contract.js)
      emit(ev.usageDelta(u.output || 0));

      // Short names of MCP tools become the full name right here (see `fullName`): event, DB row, history and execution
      // thus carry the same name — and runs/do-run.js recognises a cbase_agent call by its full name.
      const calls = (Array.isArray(turn.toolCalls) ? turn.toolCalls : []).map((c) => {
        const v = fullName(c?.name);
        return v.name !== c?.name && !v.ambiguous ? { ...c, name: v.name } : c;
      });
      // Thought, not acted (see thinkingAsResponse): follow up ONCE if tools are offered, the cap allows it and the
      // thinking NAMES a tool of this run (`namesTool`) — the thinking stays thinking (thinking row in the history),
      // the round continues with a hint. Otherwise the fallback: the thinking text is the answer, and it goes out as a
      // text delta now. If the followed-up round delivers neither text nor call (empty, thinking only, at the limit),
      // the thinking of the FIRST round is the answer — a follow-up must never yield less than the state before. All
      // paths write a row to stderr.
      let thinkingFollowUp = false;
      if (fromRound1 && !calls.length && !String(turn.text || "").trim()) {
        const text = responseFromRound1(`but without an answer and without a call (stop=${turn.stop}${turn.thinking ? ", thinking only" : ""})`);
        // The thinking of THIS round stays thinking; the text from round 1 becomes the answer.
        turn = { ...turn, text, thinkingWithoutResponse: false };
      } else if (turn.thinkingWithoutResponse && !calls.length) {
        const d = turn.diagnostic || {};
        const info = `gen=${d.id || "?"} provider=${d.provider || "?"} native_finish_reason=${d.native_finish_reason || "?"} reasoning_tokens=${d.reasoning_tokens ?? "?"} stop=${turn.stop}`;
        // The names a follow-up makes reachable: offered, deferred (loadable via ToolSearch), ToolSearch itself.
        const named = offered.length && nudges < MAX_NUDGES
          ? namesTool(turn.thinking, [...offered.map((t) => t.name), ...deferredIndex.keys(), "ToolSearch"])
          : null;
        if (named) {
          nudges++;
          thinkingFollowUp = true;
          followUpRound1 = turn;
          diagnosticRow(`[engine] thought, not acted — followed up (${info} names=${named})`);
        } else {
          diagnosticRow(`[engine] thought, not acted — the thinking text is the answer (${info})`);
          turn = thinkingAsResponse(turn);
          if (!aborted && turn.text) emit(ev.textDelta(turn.text));
        }
      }

      if (turn.thinking) emit(ev.assistantThinking(turn.thinking));
      if (turn.text) emit(ev.assistantText(turn.text));

      // Make truncation at the token limit visible (otherwise truncated tool_use args run silently into a parse
      // error).
      if (turn.stop === "length" || turn.stop === "max_tokens") {
        stderr += "[engine] answer truncated at max_tokens — raise the model's maxTokens if needed.\n";
        emit({ type: "harness", subtype: "truncated", stop: turn.stop });
      }

      if (!calls.length) {
        if (thinkingFollowUp) {
          // No assistant entry: the round had no answer, and playing its thinking as the answer would be exactly the
          // error this follow-up fixes. What was readjusted in the meantime is real input and goes into the history —
          // appended to the last user message if it is pure text (never two user roles in a row, see
          // attachUserTextTo). The hint, by contrast, only rides in the next request (`followUpHint`), as a paragraph
          // behind it.
          if (depth === 0 && controlInputs.length) attachUserTextTo(messages, controlInputs.splice(0).join("\n\n"));
          followUpHint = THINKING_FOLLOW_UP_HINT(offered.some((t) => t.name === "ToolSearch"));
          continue;
        }
        // The model output a call only as text (nothing was executed) → follow up and continue the loop instead of
        // ending the run with a mere announcement.
        const textual = nudges < MAX_NUDGES ? detectTextualToolCall(turn.text, toolNameSet) : null;
        // The slip stays in the history — as the assistant message buildTranscript builds from its text row (it went
        // out as a text event, the user keeps seeing it); the hint behind it rides, as with the thinking follow-up,
        // only in the ONE followed-up request (`followUpHint`, there as a user message of its own behind the slip). If
        // the followed-up round calls without text, the tool round below puts its calls onto this very message — as
        // buildTranscript puts the tool rows onto the text row before.
        // EXCEPTION: a connector with signed thinking blocks (`thinkingBlocks`; none of the three providers carries
        // it today — the branch stays for a connector that does). The signature of a thinking block binds the prefix
        // before it: the block of the followed-up round is created BEHIND the hint, and if the hint is missing in the
        // next request or the block moves in front of the slip's text, Anthropic answers with 400 and the turn breaks
        // off. So there the hint stands permanently as a user message in the history of THIS run, nothing is merged.
        // Decided HERE, at the slip, because the shape of the followed-up request must be fixed before its answer.
        if (textual) {
          nudges++;
          messages.push({ role: "assistant", content: asHistoryText(turn.text) });
          if (Array.isArray(turn.thinkingBlocks)) messages.push({ role: "user", content: TEXT_FOLLOW_UP_HINT(textual) });
          else followUpHint = TEXT_FOLLOW_UP_HINT(textual);
          continue;
        }
        finalText = turn.text || finalText;
        // The turn can later be continued by a monitor or a user injection. So the final text answer also belongs in
        // the in-memory history — in the transcript's shape (`asHistoryText`), otherwise the next run deviates at it
        // as soon as this one has carried it on.
        const response = asHistoryText(turn.text);
        if (response) messages.push({ role: "assistant", content: response });
        // If a message came during the last model request (readjusting), it still goes into this turn.
        if (depth === 0 && takeControl(messages)) continue;
        break;
      }

      // Assistant turn (thinking blocks + text + tool_use blocks) into the history.
      // The signed thinking blocks stand IN FRONT and must be kept: with extended thinking enabled Anthropic requires
      // them in every follow-up request that contains a tool_use.
      // The text in the transcript's shape (`asHistoryText`): "I'll have a look.\n" stands there as "I'll have a
      // look.", and a text of pure whitespace not at all — the calls alone then form the message.
      const thinkingBlocks = Array.isArray(turn.thinkingBlocks) ? [...turn.thinkingBlocks] : [];
      const ownText = asHistoryText(turn.text);
      const toolUseBlocks = calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input || {} }));
      // Without own text, right behind an assistant message (only after a call-as-text slip, see above): append the
      // calls to it instead of opening a second assistant message — exactly the shape buildTranscript builds from the
      // rows (tool rows go to the assistant entry before). Never with thinking blocks: a signed block belongs at the
      // front of ITS message, behind the prefix under which it was created — merged it would stand before the slip's
      // text (Anthropic: 400). Such connectors do not arrive here at all (the hint stands between the two messages,
      // see above); the condition holds the rule at the place where it would break.
      const previous = messages[messages.length - 1];
      if (!ownText && !thinkingBlocks.length && previous?.role === "assistant") {
        const old = typeof previous.content === "string" ? (previous.content ? [{ type: "text", text: previous.content }] : []) : previous.content;
        messages[messages.length - 1] = { role: "assistant", content: [...old, ...toolUseBlocks] };
      } else {
        messages.push({ role: "assistant", content: [...thinkingBlocks, ...(ownText ? [{ type: "text", text: ownText }] : []), ...toolUseBlocks] });
      }

      // Execute tools, collect results. Independent calls of a turn run in parallel — but ONLY if no interactive
      // question is possible (bypassPermissions) and no ExitPlanMode is in the batch (it changes the mode and must
      // stay sequential).
      const fmt = async (c) => {
        const res = await execTool(c, emit, depth, conv);
        return { c, res, content: resultContentFor(res.content, conn) };
      };
      // ONE budget for the model's regular expressions in this round (tool-runtime.js newRegexDeadline): one per call
      // would hold the backend for N × deadline in a row with N Grep calls. On the run's context, which every built-in
      // call gets as a copy (dispatch) — the rounds of a run follow one another, never two at once.
      toolCtx.regexDeadline = newRegexDeadline();
      const canParallel = calls.length > 1 && mode === "bypassPermissions"
        && !calls.some((c) => c.name === "ExitPlanMode");
      const resultBlocks = [];
      let settled;
      if (canParallel) {
        for (const c of calls) emit(ev.toolUse(c.id, c.name, c.input || {})); // announce calls in order
        settled = await Promise.all(calls.map(fmt));
      } else {
        settled = [];
        for (const c of calls) {
          if (aborted) break;
          emit(ev.toolUse(c.id, c.name, c.input || {}));
          settled.push(await fmt(c));
        }
      }
      for (const s of settled) { // results in original order (deterministic transcript)
        // A displayable version goes into the EVENT STREAM: clients and DB show "[Image]" anyway, and pushing a base64
        // screenshot through SSE and SQLite costs megabytes. The model gets the real blocks — they are in resultBlocks.
        emit(ev.toolResult(s.c.id, displayContent(s.content), s.res.isError));
        resultBlocks.push({ type: "tool_result", tool_use_id: s.c.id, content: s.content, is_error: !!s.res.isError });
      }
      messages.push({ role: "user", content: resultBlocks });
      // The next tool round: what was readjusted in the meantime stands behind the results.
      if (depth === 0) takeControl(messages);
      if (step === MAX_STEPS - 1) finalText = turn.text || finalText;
    }
    // The step cap says that it is one — otherwise the last interim sentence would become the answer, a subagent would
    // report "completed", and nothing would tell the truncated turn from a finished one.
    const stepCap = step >= MAX_STEPS && !aborted;
    // "step cap reached" stays as wording on stderr (for the human in the log) — no limit pattern may match it
    // ("… limit reached" would: limits.js would take the turn for a usage limit and park the subagent).
    if (stepCap) diagnosticRow(`[engine] step cap reached — ${STEP_CAP_TEXT}`);
    // How it says so depends on the run. A SUBAGENT (depth ≥ 1, also a workflow agent) ends as failed (run loop below:
    // exit 1, result with is_error). The MAIN RUN ends regularly (exit 0) and carries the cap as a hint in the history
    // and in its answer: with exit 1 it would go into run_error, a graph workflow would end as "failed" and the goal
    // gate would never judge. Both read the answer (`resultText`): with the hint in it they judge an interim state
    // that says it is one. In the history it stands as an answer of its own (live, in the DB, in the transcript of
    // the next run — the same shape as here in `messages`), so that the model also knows where it was cut off.
    if (stepCap && depthOfTheRun === 0) {
      emit(ev.textDelta(STEP_CAP_HINT));
      emit(ev.assistantText(STEP_CAP_HINT));
      messages.push({ role: "assistant", content: asHistoryText(STEP_CAP_HINT) });
      finalText = finalText ? `${finalText}\n\n${STEP_CAP_HINT}` : STEP_CAP_HINT;
    }
    // Hard error without any text output → null (the run reports as an error, not as an empty success). Partial text
    // is kept — it is already streamed. Whether the turn failed DESPITE text is said by `limitAbort`; without the
    // field a turn cut off at the limit could not be told from a finished answer.
    return { text: errored && !finalText ? null : finalText, messages, errored, limitAbort, errorText, stepCap };
  }

  // ── Run ──────────────────────────────────────────────────────────────────────
  let resultText = null;
  let conversationMessages = null;
  let nextInput = spec.input || "";
  let firstTurn = true;
  let hadFatalError = false;
  let turnErrorText = ""; // wording of the limit (or of the step cap) that aborted this turn — for the result event
  try {
    // SessionStart: may put context in front of the run once (ticket, environment, warnings).
    if (hooks.length) {
      const extra = await fireContextHook("SessionStart", { source: spec.sessionId ? "resume" : "startup" });
      if (extra) sessionContext = `\n\n[Hook context (SessionStart)]\n${extra}`;
    }
    while (!aborted) {
      const turn = await runConversation({
        systemPrompt: (spec.systemPrompt || "") + sessionContext,
        input: nextInput,
        transcript: firstTurn && Array.isArray(spec.transcript) ? spec.transcript : [],
        messages: conversationMessages,
        emit: onEvent,
        depth: 0,
      });
      firstTurn = false;
      conversationMessages = turn.messages;
      resultText = turn.text;
      // A turn aborted at the usage limit is an error EVEN if it produced text before. If only `text === null`
      // counted, a run whose model had said a word before the limit would end with exit 0 and count as answered —
      // and runs/do-run.js would not park.
      hadFatalError ||= turn.errored && (turn.text === null || turn.limitAbort);
      turnErrorText = turn.limitAbort ? turn.errorText : "";
      // At the step cap of a SUBAGENT: the turn is not finished — failed as with the Claude CLI at `--max-turns`
      // (error_max_turns): exit 1, result as an error with the wording. It thus ends "failed" instead of "completed"
      // (agent-runtime.js resultError). Not the main run: it carries the hint in its answer (see runConversation).
      if (turn.stepCap && depthOfTheRun > 0) {
        hadFatalError = true;
        turnErrorText = turnErrorText || STEP_CAP_TEXT;
      }

      // A result only ends the current agent turn. runs/do-run.js decides synchronously whether open monitors put the
      // run into the waiting phase or call cbaseEndInput.
      idle = true;
      // Stop: the goal gate covers this purpose functionally; the hook exists anyway, so that a Stop hook written for
      // Claude Code runs here unchanged.
      await fireNotifyHook("Stop", { result: String(resultText ?? "").slice(0, 4000) });
      // Aborted at the limit: the turn goes into the stream as FAILED (as with the Claude CLI), so that
      // runs/do-run.js can keep the wording as limit evidence.
      onEvent(ev.result(resultText ?? "", sessionId, turnErrorText));
      if (hadFatalError || aborted) break;
      if (!inputOpen || pendingInputs.length) {
        if (!inputOpen) break;
      } else {
        await new Promise((resolve) => { wakeInput = resolve; });
      }
      if (aborted || !inputOpen) break;
      nextInput = pendingInputs.shift() || "";
      if (!nextInput) continue;
      idle = false;
    }
  } catch (e) {
    stderr += `[engine] ${e?.message || e}\n`;
    hadFatalError = true;
  } finally {
    idle = false;
    runFinished = true;
    try { await fireNotifyHook("SessionEnd", { aborted, error: hadFatalError }); } catch { /* never block the teardown */ }
    pool.closeAll();
    try { killBackgroundShells(sessionId); } catch {} // end orphaned background shells of this run
  }

  const code = aborted ? 130 : (hadFatalError || (stderr && resultText === null) ? 1 : 0);
  // parts carries the breakdown per (provider, model, main/subagent); the sums above it stay unchanged so that old
  // evaluators (and the case "only one model") keep working.
  // `errorText`: the text the server's limit detection may read besides stderr. `resultText` is always MODEL TEXT
  // here — its errors (provider, limit, step cap) are on stderr. Empty means: nothing besides stderr.
  return { code, sessionId, resultText, errorText: "", stderr, usage: { ...runUsage, parts: partsWithWaiting() } };
}

// What the engine does NOT provide: doubles of the cbase tools cbase_agent (Task), cbase_monitor/_monitor_stop
// (Monitor, TaskStop) and cbase_wakeup (ScheduleWakeup). Applies at the offer AND at the execution (`toolAllowed`) —
// an older history may still name them. Also `BashOutput` and `KillShell`: they read or end a command from `Bash`
// with run_in_background — and the engine rejects that at the call (mcp/detach-rule.js). Two tools without any object.
export const ENGINE_NOT_PROVIDED = new Set(["Task", "Monitor", "TaskStop", "ScheduleWakeup", "BashOutput", "KillShell"]);

// ── Static tool defs ─────────────────────────────────────────────────────────────
const TOOLSEARCH_DEF = {
  name: "ToolSearch",
  description: "Loads the schemas of deferred tools — only then do you know their parameters, after that they are in your list like any other tool. Forms: 'select:name1,name2' fetches exactly these tools; free keywords search over name and description; a '+word' must occur in the NAME. Load all tools you need for the task in ONE call.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "'select:<name>,<name>' or keywords" },
      max_results: { type: "integer", description: "Maximum number of hits for a keyword search (default 5)" },
    },
    required: ["query"],
  },
};

// MCP resources/prompts: with tools/list alone, servers that offer files, documentation or ready-made prompts would
// be half invisible to the model.
function mcpResourceDef(resources) {
  const servers = [...new Set(resources.map((r) => r.server))];
  return [{
    name: "ListMcpResources",
    description: `Lists the resources of the connected MCP servers (${servers.join(", ")}) — documents, files and records the servers provide.`,
    inputSchema: { type: "object", properties: { server: { type: "string", description: "restrict to one server (optional)" } } },
  }, {
    name: "ReadMcpResource",
    description: "Reads an MCP resource by its uri (from ListMcpResources).",
    inputSchema: {
      type: "object",
      properties: { uri: { type: "string", description: "uri of the resource" }, server: { type: "string", description: "server (optional)" } },
      required: ["uri"],
    },
  }];
}
function mcpPromptDef(prompts) {
  return {
    name: "McpPrompt",
    description: "Fetches a ready-made prompt of an MCP server (template with placeholders). Available:\n"
      + prompts.map((p) => `- ${p.name} (${p.server})${p.description ? `: ${p.description}` : ""}`).join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", enum: prompts.map((p) => p.name), description: "name of the prompt" },
        server: { type: "string", description: "server (optional, needed for prompts of the same name)" },
        arguments: { type: "object", description: "arguments of the prompt" },
      },
      required: ["name"],
    },
  };
}

const EXITPLAN_DEF = {
  name: "ExitPlanMode",
  description: "Only in plan mode: when your plan is ready, call this with the complete plan (Markdown) to present it to the user for approval. Only after the approval may you make changes. Use only for planning implementation steps — not for pure research tasks.",
  inputSchema: {
    type: "object",
    properties: { plan: { type: "string", description: "The plan to implement as Markdown (brief, concrete)" } },
    required: ["plan"],
  },
};

// Skills come for EVERY provider via the MCP tool `cbase_skill`, and their catalog is in the system prompt instead of
// in the description of a built-in tool.
