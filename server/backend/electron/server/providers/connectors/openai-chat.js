// connectors/openai-chat.js — the wire for the OpenAI chat completions format (SSE).
//
// Exactly ONE provider runs over it: OpenRouter, built in (connectors/openrouter.js). The factory stays parameterized
// ({baseUrl, apiKey, models, extraBody, …}) — base, models and extra fields may be functions, because the catalog
// refreshes during operation (providers/openrouter-catalog.js) and the access changes via PUT /api/openrouter without
// a restart. Implements ONLY `complete` (one round) + `runOnce` + `authStatus`; the engine (engine.js) drives the
// agentic loop.
import { materialMessage, normalizeCaps } from "../contract.js";
import { T } from "../../i18n.js";
// Which levels this wire sends per model and the one clamp in front of it — the computation itself lives in
// workflows.js (`effortFallback`), preset-levels.js asks it.
import { explicitLevels, wireLevel } from "../preset-levels.js";
import { reportConsumption, withCostMissing, openRouterCost } from "./consumption.js";
// The endpoints of a model behind a router (OpenRouter `/models/<id>/endpoints`) — for the window of the provider that
// delivered a response (`providerWindow`, display only) and for the prices per provider (`modelPrices`, display only).
// A leaf; the catalog (openrouter-catalog.js) asks the same for the median.
import { windowOf, fetchEndpoints, isOpenRouterBase, priceSpan } from "../openrouter-endpoints.js";

// `documents` deliberately false: at OpenRouter the `file` part does not reach every provider behind the router, and an
// unknown part type fails the WHOLE call, not just this document — until then the PDF→images fallback applies. `vision`
// is the capability of the WIRE; whether a model takes images says `canImages` per model (the catalog,
// `architecture.input_modalities`).
export const DEFAULT_CAPS = {
  ownsAgentLoop: false, nativeToolCalling: true, streaming: true, reasoning: true, vision: true,
  documents: false,
  permissionPrompt: true, fork: true, effort: true, plan: true,
};

// cbase effort levels → `reasoning_effort`. Level and value have the same name. The table lists exactly the levels of
// the order (web/test/effort.test.mjs keeps that), its keys are also what this wire knows at all. All five are sent:
// OpenRouter itself maps onto the nearest level the model supports (measured).
const REASONING_EFFORT = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
const WIRE_LEVELS = Object.keys(REASONING_EFFORT);

// A value that may be a function (catalog, access, base — they change during operation).
const now = (v) => (typeof v === "function" ? v() : v);

const imagePart = (b) => {
  const s = b.source || {};
  return { type: "image_url", image_url: { url: `data:${s.media_type || "image/png"};base64,${s.data || ""}` } };
};

// Document block (Anthropic-style) → chat completions `file` part. Only produced if the provider reports
// `caps.documents` — the default is false because not every OpenAI-compatible endpoint can do it and an unknown part
// type fails the WHOLE call, not just this document.
const documentPart = (b) => {
  const s = b.source || {};
  return {
    type: "file",
    file: { filename: b.name || "document.pdf", file_data: `data:${s.media_type || "application/pdf"};base64,${s.data || ""}` },
  };
};

// Neutral messages (Anthropic-style) → OpenAI chat format.
function toOpenAiMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const toolUses = blocks.filter((b) => b.type === "tool_use");
      const msg = { role: "assistant", content: text || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((t) => ({
          id: t.id, type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
        }));
      }
      out.push(msg);
    } else {
      // user turn: text, images and/or tool_result blocks. tool_result → separate role:"tool" messages.
      const textBlocks = blocks.filter((b) => b.type === "text");
      const imageBlocks = blocks.filter((b) => b.type === "image");
      const docBlocks = blocks.filter((b) => b.type === "document");
      if (imageBlocks.length || docBlocks.length) {
        // Multimodal: OpenAI content parts (text + image_url as data URI, documents as file).
        const parts = [];
        for (const tb of textBlocks) if (tb.text) parts.push({ type: "text", text: tb.text });
        for (const ib of imageBlocks) parts.push(imagePart(ib));
        for (const db of docBlocks) parts.push(documentPart(db));
        if (parts.length) out.push({ role: "user", content: parts });
      } else {
        const texts = textBlocks.map((b) => b.text).join("");
        if (texts) out.push({ role: "user", content: texts });
      }
      // Images from tool results (screenshots): in the OpenAI format a role:"tool" message may only carry text. The
      // image therefore follows immediately as its own user message — otherwise a requested screenshot would never
      // reach a vision-capable model.
      const trailingImages = [];
      for (const b of blocks.filter((x) => x.type === "tool_result")) {
        const c = b.content;
        const chunks = Array.isArray(c) ? c : null;
        const text = chunks
          ? chunks.filter((x) => x?.type === "text").map((x) => x.text || "").join("\n")
          : (typeof c === "string" ? c : JSON.stringify(c));
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: text });
        if (chunks) for (const x of chunks) if (x?.type === "image") trailingImages.push(x);
      }
      if (trailingImages.length) {
        out.push({ role: "user", content: [{ type: "text", text: "[Images from the previous tool result]" }, ...trailingImages.map(imagePart)] });
      }
    }
  }
  return out;
}

// The response in the thinking channel: an OpenAI-compatible server with a reasoning parser (SGLang/vLLM) assigns
// EVERYTHING to thinking if the model does not close its thinking block — `reasoning_content` carries the answer,
// `content` is empty, finish_reason stop. The rule: if a round ends REGULARLY without response text (whitespace does
// not count) and without a tool call, the thinking text is the response. Not at the token limit (truncated thinking is
// not a response) and not next to tool calls (there it justifies the call). Guard:
// server/backend/test/connector-wire.test.js, engine-task-core.test.js.
//
// "Thought, not acted": the same shape has a SECOND meaning — the model thought "I'll attempt the stop call." and
// delivered neither text nor call, and the monologue would become the response. In a CONVERSATION (`complete`)
// therefore not the connector decides but the engine: the connector only reports `thinkingWithoutResponse` and leaves
// text and thinking as they came (no swap, no second text delta); the engine follows up once if tools are offered and
// the thinking names one of them, and otherwise — also if the follow-up round delivers nothing — falls back to this
// rule (engine.js). The oneshot (`runOnce`: classification, extraction, verdicts) has no tools and nobody to follow
// up — there the rule applies unchanged.
const REGULAR_END = new Set(["stop", "end"]);
function responseFromThinking({ text, thinking, stop, hasTools }) {
  if (hasTools || !REGULAR_END.has(stop)) return null;
  if (String(text || "").trim() || !String(thinking || "").trim()) return null;
  return String(thinking).trim();
}

// An input schema in the shape that STRICT endpoints accept too. Gemini-style function declarations require a type on
// every property — a field without one (`cbase_dynamic_workflow.args`: "any JSON value", 1:1 from the Claude CLI
// baseline, mcp-schema.test.js) fails the WHOLE request there. Such a field gets an `anyOf` over the JSON types here;
// whatever carries a type (or anyOf/oneOf/allOf/$ref/enum/const) stays as it is. Only on the wire: the MCP schema
// itself (and with it what the Claude CLI sees) does not change. Pure, exported for the guard.
const ANY_VALUE = [
  { type: "string" }, { type: "number" }, { type: "boolean" }, { type: "object" },
  { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "object" }] } },
];
const HAS_FORM = ["type", "anyOf", "oneOf", "allOf", "$ref", "enum", "const"];
export function strictSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  let out = schema;
  const set = (k, v) => { if (out === schema) out = { ...schema }; out[k] = v; };
  if (schema.properties && typeof schema.properties === "object") {
    const props = {};
    let changed = false;
    for (const [k, v] of Object.entries(schema.properties)) {
      let n = strictSchema(v);
      if (n && typeof n === "object" && !Array.isArray(n) && !HAS_FORM.some((f) => f in n)) n = { ...n, anyOf: ANY_VALUE };
      if (n !== v) changed = true;
      props[k] = n;
    }
    if (changed) set("properties", props);
  }
  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    const n = strictSchema(schema.items);
    if (n !== schema.items) set("items", n);
  }
  for (const k of ["anyOf", "oneOf", "allOf"]) {
    if (!Array.isArray(schema[k])) continue;
    const n = schema[k].map(strictSchema);
    if (n.some((x, i) => x !== schema[k][i])) set(k, n);
  }
  return out;
}

function toOpenAiTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description || "", parameters: strictSchema(t.inputSchema || { type: "object", properties: {} }) },
  }));
}

// Prompt caching with explicit markers. OpenRouter (docs "Prompt Caching"): Anthropic models cache via
// chat/completions ONLY with `cache_control` — on a content block ("explicit breakpoint", at most four) or as ONE field
// at the top of the request body ("automatic": OpenRouter sets the marker on the last cacheable block and moves it
// along with the conversation; applies to Anthropic, Vertex, Bedrock, Azure). Without a marker every turn pays the full
// system prompt and history. Both are set: a marker on the system block (tools + system prompt are the stable part,
// also after a compaction) and the automatic field for the history. Other providers cache there by themselves — they
// get nothing, the request stays byte-identical. 5-minute TTL (the default; 1 h costs double on write).
const CACHE_MARKER = Object.freeze({ type: "ephemeral" });
export function withCacheMarkers(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const i = msgs.findIndex((m) => m?.role === "system");
  if (i >= 0) {
    const sys = msgs[i];
    const parts = typeof sys.content === "string"
      ? [{ type: "text", text: sys.content }]
      : Array.isArray(sys.content) ? sys.content.map((t) => ({ ...t })) : [];
    if (parts.length) {
      parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: { ...CACHE_MARKER } };
      body.messages = msgs.map((m, k) => (k === i ? { ...sys, content: parts } : m));
    }
  }
  body.cache_control = { ...CACHE_MARKER };
  return body;
}

// Images for a model WITHOUT image input (catalog: `architecture.input_modalities` without "image"): OpenRouter rejects
// the WHOLE call ("No endpoints found that support image input"). Instead of the image a sentence stands there — the
// call goes through, and the model knows something is missing. Only neutral blocks (Anthropic-style, before
// toOpenAiMessages), also in tool results.
const IMAGE_PLACEHOLDER = "[Image not transmitted: this model does not accept images]";
function withoutImages(messages) {
  const replace = (blocks) => blocks.map((b) => (b?.type === "image" ? { type: "text", text: IMAGE_PLACEHOLDER } : b));
  return (messages || []).map((m) => {
    if (!Array.isArray(m?.content)) return m;
    return {
      ...m,
      content: replace(m.content).map((b) => (b?.type === "tool_result" && Array.isArray(b.content) ? { ...b, content: replace(b.content) } : b)),
    };
  });
}

export function makeOpenAiChatConnector(cfg) {
  const {
    id, label,
    // Base URL; a function is asked per call (the test seam CBASE_OPENROUTER_BASE works without re-registration).
    baseUrl,
    apiKey,          // static key OR
    getApiKey,       // function → key (lazily from the row providers.openrouter)
    // The model entries — an array or a function that returns the CURRENT list (the catalog refreshes).
    models = [],
    modelMap = {},
    headers = {},
    // Default model of the provider as a callback: the ONE default `defaultModelFor` — no field of its own.
    defaultModel,
    caps,
    // Name of the wire in the warning lines.
    wire = "openai-chat",
    // Does this model take images? (Callback with the resolved id; if missing, every model takes what `caps.vision` allows.)
    canImages,
    // A model is being used (complete/runOnce) — the catalog then fetches its median (openrouter-catalog.js catalogUse).
    atUse,
    // Does this model need explicit cache markers (see `withCacheMarkers`)? Callback with the resolved id; if missing, never.
    cacheMarkers,
    // Does this wire report the cost per response? If the field is missing, the HOST of the base decides (see below).
    reportsCost: reportsCostCfg,
    // Where `authStatus` checks the key (OpenRouter: `/key` — `/models` is public and says nothing about the key).
    authPath = "/models",
  } = cfg;
  const modelsValue = () => {
    const v = now(models);
    return Array.isArray(v) ? v : [];
  };
  // What this model supports on this wire — asked with the RESOLVED id: explicitly on the entry (`efforts`), otherwise all five.
  const levelsFor = (id) => explicitLevels(modelsValue(), id, WIRE_LEVELS) ?? [...WIRE_LEVELS];
  // 0 = do not send (provider default). Endpoints that cap long responses get their upper bound here — the engine
  // reports a truncation as harness/truncated.
  const maxTokens = Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : 0;
  // Provider-specific extra fields for EVERY request body (OpenRouter: `provider: {zdr, data_collection}` — the two
  // toggles of the card, PUT /api/openrouter). Core and runtime fields (model, messages, tools, stream, …) always win:
  // the extra only fills gaps and cannot misconfigure the wire protocol. Read per call.
  const extraBody = () => {
    const v = now(cfg.extraBody);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  };
  const applyExtra = (body) => {
    for (const [k, v] of Object.entries(extraBody())) if (!(k in body)) body[k] = v;
    return body;
  };

  const base = () => String(now(baseUrl) || "").replace(/\/+$/, "");
  // The real cost per response: `usage.cost` is only read where its meaning is documented (USD, see
  // consumption.js:openRouterCost) — always for the built-in OpenRouter (`reportsCost: true`, also behind the test
  // seam), otherwise measured by the HOST of the base: another gateway that happens to send `cost` has a unit cbase
  // does not know.
  const reportsCost = () => (typeof reportsCostCfg === "boolean" ? reportsCostCfg : isOpenRouterBase(base()));
  // Merge preset defaults with optional config overrides (an empty {} must NOT null the defaults).
  const mergedCaps = normalizeCaps({ ...DEFAULT_CAPS, ...(caps || {}) });
  const imagesFor = (model) => mergedCaps.vision && (typeof canImages !== "function" || canImages(model) !== false);
  const used = (model) => { try { if (typeof atUse === "function" && model) atUse(model); } catch { /* never fail the call */ } };

  // No model and no default (see resolveModel): the run ends with this sentence BEFORE a request goes out — an empty
  // `model` on the wire would give a 400 without a hint where to fix it.
  const withoutModel = () => new Error(T`${label || id}: no model chosen and no default model saved — choose a default model under Settings → Providers.`);
  const key = () => (typeof getApiKey === "function" ? getApiKey() : apiKey) || "";
  const authHeaders = () => {
    const h = { "Content-Type": "application/json", ...headers };
    const k = key();
    if (k) h.Authorization = `Bearer ${k}`;
    return h;
  };

  // An empty model means "the default". With `defaultModel` (OpenRouter) THAT is the answer, even if it is empty:
  // nobody chose the first model of the list (providers/index.js defaultModelFor) — `complete`/`runOnce` then reject a
  // run without a model with `withoutModel`. Without the callback (connector tests, a wire with a fixed small list) the
  // first one.
  function resolveModel(model) {
    const m = String(model || "").trim();
    if (!m) return typeof defaultModel === "function" ? String(defaultModel() || "") : (modelsValue()[0]?.id || "");
    if (modelsValue().some((x) => x?.id === m)) return m;
    const l = m.toLowerCase();
    for (const tier of ["opus", "sonnet", "haiku", "fable"]) if (l.includes(tier) && modelMap[tier]) return modelMap[tier];
    if (modelMap[l]) return modelMap[l];
    return m; // already a provider model id
  }

  // The entries with their levels — computed ONCE per state of the list (the catalog has hundreds, and /api/providers asks often).
  let projectionOf = null;
  let projection = [];
  const modelsWithLevels = () => {
    const list = modelsValue();
    if (list !== projectionOf) { projectionOf = list; projection = list.map((m) => ({ ...m, efforts: levelsFor(m?.id) })); }
    return projection;
  };

  // ── complete: one round (streaming SSE) ───────────────────────────────────────
  // Cost optimization: most providers behind OpenRouter cache the prompt prefix AUTOMATICALLY on the server side.
  // Anthropic models do not — they get explicit markers (`cacheMarkers`, see `withCacheMarkers`); otherwise unknown
  // fields are deliberately NOT sent. In addition autocompact keeps the history small.
  async function complete({ messages, tools, model, effort, signal, onDelta }) {
    const useModel = model || resolveModel("");
    if (!useModel) throw withoutModel();
    used(useModel);
    const reports = reportsCost();
    const body = {
      model: useModel,
      messages: toOpenAiMessages(imagesFor(useModel) ? messages : withoutImages(messages)),
      stream: true,
      stream_options: { include_usage: true },
    };
    const t = toOpenAiTools(tools);
    if (t) { body.tools = t; body.tool_choice = "auto"; }
    // The level can come out empty (no level at all, or a model without levels) — then the field stays AWAY. `= ""`
    // would be worse than none: the API would get an empty string.
    const level = effort && mergedCaps.effort
      ? wireLevel(wire, effort, levelsFor(useModel), useModel)
      : "";
    if (level) body.reasoning_effort = REASONING_EFFORT[level];
    if (maxTokens > 0) body.max_tokens = maxTokens;
    if (typeof cacheMarkers === "function" && cacheMarkers(useModel)) withCacheMarkers(body);
    applyExtra(body);

    const res = await fetch(`${base()}/chat/completions`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}${errText ? " — " + errText.slice(0, 400) : ""}`);
    }

    let text = "", thinking = "", stop = "end";
    const usage = { input: 0, output: 0, cached: 0 };
    // The reported amount of this round (USD) — null as long as none came; only read for OpenRouter (see `reportsCost`).
    let cost = null;
    const toolAcc = []; // per index: { id, name, args }
    // What the round says about itself (OpenRouter: generation id, provider behind the router, its own finish reason,
    // reasoning tokens). For diagnosing a "thought, not acted" (engine.js writes it to stderr). The provider also goes
    // out in EVERY round that names it (`provider`, see return value).
    const diagnostic = { id: "", provider: "", native_finish_reason: "", reasoning_tokens: null };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const handleChunk = (obj) => {
      if (obj.id && !diagnostic.id) diagnostic.id = String(obj.id);
      if (obj.provider) diagnostic.provider = String(obj.provider);
      if (obj.usage) {
        usage.input = obj.usage.prompt_tokens || usage.input;
        usage.output = obj.usage.completion_tokens || usage.output;
        usage.cached = obj.usage.prompt_tokens_details?.cached_tokens || usage.cached;
        // The cache write, where the provider names it (OpenRouter `prompt_tokens_details.cache_write_tokens`) — it is
        // contained in `prompt_tokens` like the read; without the figure it counts there as fresh input.
        if (obj.usage.prompt_tokens_details?.cache_write_tokens) usage.cacheWrite = obj.usage.prompt_tokens_details.cache_write_tokens;
        const rt = obj.usage.completion_tokens_details?.reasoning_tokens;
        if (rt != null) diagnostic.reasoning_tokens = rt;
        if (reports) { const k = openRouterCost(obj.usage); if (k !== null) cost = k; }
      }
      const choice = obj.choices?.[0];
      if (!choice) return;
      if (choice.native_finish_reason) diagnostic.native_finish_reason = String(choice.native_finish_reason);
      const d = choice.delta || {};
      if (typeof d.content === "string" && d.content) { text += d.content; onDelta?.({ text: d.content }); }
      const reason = d.reasoning_content ?? d.reasoning;
      if (typeof reason === "string" && reason) { thinking += reason; onDelta?.({ thinking: reason }); }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          if (!toolAcc[i]) toolAcc[i] = { id: tc.id || "", name: "", args: "", reported: false };
          if (tc.id) toolAcc[i].id = tc.id;
          if (tc.function?.name) toolAcc[i].name = tc.function.name;
          if (tc.function?.arguments) toolAcc[i].args += tc.function.arguments;
          // The call BEGINS: streaming the arguments can take tens of seconds, and the UI would show nothing. As soon
          // as id AND name are there, ONCE per call; the arguments follow silently, the finished call comes with the
          // round. Without an id in the stream no early start: the final form then assigns `call_<i>`, and a different
          // id would give a second row.
          const acc = toolAcc[i];
          if (!acc.reported && acc.id && acc.name) {
            acc.reported = true;
            onDelta?.({ toolStart: { id: acc.id, name: acc.name } });
          }
        }
      }
      if (choice.finish_reason) stop = choice.finish_reason;
    };

    // From here on the provider has accepted: at OpenRouter the round costs something even if the stream breaks off now
    // (user stop, network) — the amount would only be in the last chunk. The error therefore continues with the mark
    // `costMissing` (consumption.js), and the engine makes the run's cost unknown instead of passing the round over as
    // free.
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          let obj; try { obj = JSON.parse(payload); } catch { continue; }
          handleChunk(obj);
        }
      }
    } catch (e) {
      // The generation id of the broken-off response goes along: with it the periodic inquiry asks for the amount the
      // stream no longer brought (account/openrouter-inquiry.js).
      if (reports && diagnostic.id && e && typeof e === "object") { try { e.generationId = diagnostic.id; } catch { /* frozen */ } }
      throw reports ? withCostMissing(e) : e;
    }

    const toolCalls = toolAcc.filter(Boolean).map((tc, i) => {
      let input = {};
      try { input = tc.args ? JSON.parse(tc.args) : {}; } catch { input = { _raw: tc.args }; }
      return { id: tc.id || `call_${i}`, name: tc.name, input };
    });
    // Only thinking, ended regularly (see responseFromThinking): reported, not decided — whether that is the response
    // or an intention never carried out, the engine decides.
    const thinkingWithoutResponse = responseFromThinking({ text, thinking, stop, hasTools: toolCalls.length > 0 }) !== null;
    return {
      // `usage.cost`: what OpenRouter charged for THIS round (USD) — only if the response reported it; a missing field
      // means unknown, not 0. The engine sums it per run (engine.js `tallyUsage`, consumption.js `combinedCost`). If
      // NO amount came at OpenRouter (stream without a usage chunk), the round carries `costMissing` — even with 0
      // tokens it cost something.
      text, thinking, toolCalls, stop: toolCalls.length ? "tool_calls" : stop,
      // `usage.generationId`: the id of this response at OpenRouter — the engine collects it per run (engine.js
      // tallyUsage), booked it stands in `usage_events.generation_id`, so that a missing amount can be inquired.
      usage: { ...(cost !== null ? { ...usage, cost } : (reports ? { ...usage, costMissing: true } : usage)), ...(reports && diagnostic.id ? { generationId: diagnostic.id } : {}) },
      // The provider BEHIND the router that delivered this round (OpenRouter picks it anew per request, by price and
      // load) — only if the response names it; the engine puts it on message_start (contract.js `usageStart`).
      ...(diagnostic.provider ? { provider: diagnostic.provider } : {}),
      ...(thinkingWithoutResponse ? { thinkingWithoutResponse: true, diagnostic } : {}),
    };
  }

  // ── runOnce: non-streaming, without tools (aux features) ──────────────────────
  // Material goes through THE SAME translator as a conversation (toOpenAiMessages) — with a plain string an image has
  // no place: `caps.vision` would say "yes" and the oneshot would silently drop it.
  async function runOnce(prompt, { model, effort = "", timeoutMs = 90_000, images = [], documents = [], atConsumption } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const useModel = resolveModel(model);
      if (!useModel) throw withoutModel();
      used(useModel);
      const message = materialMessage(prompt, {
        images: imagesFor(useModel) ? images : [],
        documents: mergedCaps.documents ? documents : [],
      });
      const body = { model: useModel, messages: toOpenAiMessages([message]), stream: false };
      // The level of a oneshot — the same field and the same wire clamp as `complete`.
      const level = effort && mergedCaps.effort
        ? wireLevel(wire, effort, levelsFor(useModel), useModel)
        : "";
      if (level) body.reasoning_effort = REASONING_EFFORT[level];
      const res = await fetch(`${base()}/chat/completions`, {
        method: "POST", headers: authHeaders(), signal: ctrl.signal,
        body: JSON.stringify(applyExtra(body)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      const j = await res.json();
      // The consumption: `prompt_tokens` already contains the cache — the same contract as `complete`. Plus, at
      // OpenRouter, the reported amount and the provider behind the router (both only if the response names them), the
      // cache write and the generation id (see complete).
      if (j?.usage) reportConsumption(atConsumption, { provider: id, model: j.model || useModel, input: j.usage.prompt_tokens,
        output: j.usage.completion_tokens, cached: j.usage.prompt_tokens_details?.cached_tokens,
        cacheWrite: j.usage.prompt_tokens_details?.cache_write_tokens,
        cost: reportsCost() ? openRouterCost(j.usage) : null, upstream: j.provider || "",
        generationId: reportsCost() && j.id ? String(j.id) : "" });
      const c = j.choices?.[0] || {};
      const text = c.message?.content || "";
      // A regularly ended oneshot without response text answers with its thinking — here the connector decides itself:
      // a oneshot has no tools, so nothing that could be "thought, not acted".
      return responseFromThinking({ text, thinking: c.message?.reasoning_content ?? c.message?.reasoning, stop: c.finish_reason || "end",
        hasTools: Array.isArray(c.message?.tool_calls) && c.message.tool_calls.length > 0 }) ?? text;
    } finally { clearTimeout(timer); }
  }

  // ── providerWindow: the context window of the provider that delivered a response ──────────────────────────────
  // `name` as in the field `provider` of `complete` (OpenRouter `provider`, spelled the same as `provider_name` of the
  // endpoint list). Asked via `GET <base>/models/<id>/endpoints` with this provider's key (cached 1 h, an alias asks
  // its target — see openrouter-endpoints.js). 0 = unknown (no endpoint with that name); a failed fetch THROWS — the
  // caller (runs/do-run.js) catches it and names the provider without a window.
  // DISPLAY ONLY: computation uses `models[].context`.
  async function providerWindow(model, name, { signal } = {}) {
    if (!String(name || "").trim()) return 0;
    const endpoints = await fetchEndpoints(base(), key(), resolveModel(model), { signal });
    return windowOf(endpoints, name);
  }

  // ── modelPrices: the prices per provider of a model, per 1M tokens in USD ───────────────────────────────────────────────
  // From the same endpoint list as `providerWindow` (cached 1 h, an alias asks its target): `span` over the active
  // endpoints, `last` = the provider `name` (of the last response), both `{ inMin, inMax, outMin, outMax, endpoints }`
  // or null (unknown). A failed fetch THROWS — the caller (account/routes.js) turns it into "unknown". DISPLAY ONLY:
  // billing follows the report per response (`usage.cost`).
  async function modelPrices(model, name = "", { signal } = {}) {
    const endpoints = await fetchEndpoints(base(), key(), resolveModel(model), { signal });
    return { span: priceSpan(endpoints), last: String(name || "").trim() ? priceSpan(endpoints, name) : null };
  }

  // Without a key the provider is "not connected" — without a fetch.
  async function authStatus() {
    if (!key()) return { connected: false, raw: "", authMethod: "apikey" };
    try {
      const res = await fetch(`${base()}${authPath}`, { headers: authHeaders(), signal: AbortSignal.timeout(15_000) });
      return { connected: res.ok, raw: res.ok ? "" : `HTTP ${res.status}`, authMethod: "apikey" };
    } catch (e) { return { connected: false, raw: String(e?.message || e), authMethod: "apikey" }; }
  }

  return {
    id, label,
    // Every entry carries its levels: /api/providers passes `models` to web and iOS, and the picker shows only what
    // this wire really sends for the model — and the UI names the same substitute the clamp computes
    // (web/test/effort.test.mjs). A GETTER: the list is the current one (the catalog refreshes), and the registry
    // mirrors it live (providers/index.js syncProvidersView).
    get models() { return modelsWithLevels(); },
    caps: mergedCaps,
    cleanEnv: () => ({ ...process.env }),
    resolveModel,
    // The levels of this model on this wire — the same list `effortRunning` (providers/index.js) clamps against, asked
    // with the RESOLVED id (an alias clamps like its target).
    efforts: (model) => levelsFor(resolveModel(model)),
    complete,
    runOnce,
    providerWindow,
    // Does this wire report the cost per response (OpenRouter)? The usage tab asks (account/routes.js).
    get reportsCost() { return reportsCost(); },
    // Does this model take images? (providers/index.js materialCapabilities asks per model.)
    canImages: (model) => imagesFor(resolveModel(model)),
    modelPrices,
    authStatus,
  };
}

// For tests: the pure translation without network.
export { toOpenAiMessages, toOpenAiTools };
