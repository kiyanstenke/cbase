// Provider registry & dispatch — the adapter core.
//
// The rest of the app (runs/do-run.js doRun, aux claude.js) stays provider-independent and ONLY talks to the primitives
// exported here (runOnce/runChat/…). They look up the matching connector in the registry instead of branching hard on
// claude|codex.
//
// The registry knows EXACTLY three providers (`PROVIDER` in the contract account/usage-contract.js: claude, codex,
// openrouter). All three are built in here; `registerConnector` accepts no other id (tests replace one of the three
// with a spy and restore it afterwards), there are no providers from the database. Guard:
// server/backend/test/only-three-provider.test.js.
//
// Connectors fulfil the contract from contract.js. "Native" ones (ownsAgentLoop:true) bring their agentic loop along
// (Claude/Codex CLI); "completion" ones (ownsAgentLoop:false) deliver only one round and are driven by the generic
// loop engine (engine.js).
import * as store from "../store.js";
import { normalizeCaps, parseModelRef, validateConnector } from "./contract.js";
import { runChatViaEngine } from "./engine.js";
// Both model catalogs live in THEIR connector — the index only imports them. A connector can only clamp against a
// catalog it can read, and the way back from the connector to here would be an import cycle.
import { buildClaudeChatArgs, claudeModels, claudeBin, claudeEfforts, cleanClaudeEnv, runChatClaude, runOnceClaude } from "./connectors/claude.js";
import { reportConsumption } from "./connectors/consumption.js";
import { cleanCodexEnv, codexModels, codexAuthStatus, codexBin, codexEfforts, codexRateLimitSnapshot, codexUsage, resolveCodexModel, runChatCodex, runOnceCodex, setCodexVisibility } from "./connectors/codex.js";
import { runningModel } from "./retired.js";
import { makeOpenRouterConnector } from "./connectors/openrouter.js";
import { catalogKnows } from "./openrouter-catalog.js";
import { PROVIDER, OPENROUTER_ID } from "../account/usage-contract.js";
// The level order, its clamp and the storage verdict: the leaf workflows.js (no imports of its own except
// autocompact.js) — the edge costs no cycle.
import { effortFallback, effortSavable } from "../workflows.js";

const DEFAULT_PROVIDER = "claude";

// ── Built-in native connectors ───────────────────────────────────────────────────
const claudeConnector = {
  id: "claude",
  label: "Claude Code",
  bin: () => claudeBin(),
  // A getter: the list follows the CLI's account catalog (providers/native-catalog.js), which changes during operation.
  get models() { return claudeModels(); },
  caps: normalizeCaps({
    ownsAgentLoop: true, nativeToolCalling: true, streaming: true, reasoning: true, vision: true,
    // The CLI passes a `document` block through to the Anthropic API (verified with a PDF whose statement is only in
    // the image).
    documents: true,
    permissionPrompt: true, fork: true, effort: true, plan: true,
    prefixCache: true, // Anthropic prompt caching: the CLI sets the cache markers itself
  }),
  cleanEnv: cleanClaudeEnv,
  resolveModel: (model) => model || "",
  // Which levels does this model support? The same question as the clamp at spawn (see effortRunning).
  efforts: (model) => claudeEfforts(model),
  runOnce: runOnceClaude,
  runChat: runChatClaude,
  authStatus: () => Promise.resolve(null), // Claude auth is queried separately in account/routes.js (account/usage.js:claudeAuth).
};

const codexConnector = {
  id: "codex",
  label: "OpenAI Codex",
  bin: () => codexBin(),
  get models() { return codexModels(); },
  // `vision`: Codex SEES images — measured at 0.162.1: `-i <file>`
  // attaches them as `input_image` to the user message (runOnceCodex), `view_image` delivers an image file, and an MCP
  // result with an image block (cbase_screenshot, browser_take_screenshot) reaches the model as soon as the exec code
  // passes the block to `image(…)` (`image(r.content.find((x) => x.type === "image"))` ⇒ `input_image` in the
  // follow-up request; merely returned it stays an object in the script). The prefix names this path
  // (codex-prefix.js codexToolList). `documents` stays off: `-i` does not take a PDF.
  caps: normalizeCaps({
    ownsAgentLoop: true, nativeToolCalling: true, streaming: true, reasoning: true, vision: true,
    permissionPrompt: false, fork: false, effort: true, plan: false,
    prefixCache: true, // OpenAI caches an identical prompt beginning by itself (cached_input_tokens)
  }),
  cleanEnv: cleanCodexEnv,
  resolveModel: resolveCodexModel,
  // The clamp at spawn asks the RESOLVED id (runChatCodex: resolveCodexModel, then mapEffort) — the same resolution
  // here, otherwise "really runs" would name a different level for a Claude alias.
  efforts: (model) => codexEfforts(resolveCodexModel(model)),
  runOnce: runOnceCodex,
  runChat: runChatCodex,
  authStatus: codexAuthStatus,
  usage: codexUsage,
};

// ── Registry ─────────────────────────────────────────────────────────────────────
const registry = new Map();

// Backward compatible: PROVIDERS as an object (id → {id,label,bin,models,caps}). account/routes.js and
// account/providers.js read from it (`/api/providers`, `/api/default-model`, `defaultModelFor`). Re-mirrored on every
// registration; the same object reference is kept (live binding). `models` is a GETTER onto the connector: OpenRouter's
// list is the catalog (providers/openrouter-catalog.js), and that refreshes during operation — a snapshot here would be
// stale after six hours.
export const PROVIDERS = {};
function syncProvidersView() {
  for (const key of Object.keys(PROVIDERS)) delete PROVIDERS[key];
  for (const c of registry.values()) {
    const view = { id: c.id, label: c.label, bin: c.bin, caps: c.caps };
    Object.defineProperty(view, "models", { get: () => c.models, enumerable: true });
    PROVIDERS[c.id] = view;
  }
}

/**
 * Registers (or replaces) one of the three providers. An id outside `PROVIDER` THROWS — there is no fourth provider,
 * not even from a test (it replaces one of the three and restores the original afterwards).
 */
export function registerConnector(connector) {
  const errs = validateConnector(connector);
  if (!errs.length && !PROVIDER.includes(connector.id)) errs.push(`only ${PROVIDER.join(", ")} — there is no further provider`);
  if (errs.length) throw new Error(`Invalid connector "${connector?.id}": ${errs.join("; ")}`);
  connector.caps = normalizeCaps(connector.caps);
  registry.set(connector.id, connector);
  syncProvidersView();
  return connector;
}

export const getConnector = (id) => registry.get(id) || null;
export const listConnectors = () => [...registry.values()];

// OpenRouter (built in, connectors/openrouter.js): the access from the row providers.openrouter per call, the default
// model via THE SAME function as every run (`defaultModelFor`, further below — long present at call time).
const openRouterConnector = makeOpenRouterConnector({
  access: () => { try { return store.openRouterAccess(); } catch { return { apiKey: "", extraBody: {} }; } },
  defaultModel: () => defaultModelFor(OPENROUTER_ID),
});

// Register the three built-in providers (also fills PROVIDERS), in contract order.
registerConnector(claudeConnector);
registerConnector(codexConnector);
registerConnector(openRouterConnector);

// The alias "haiku" in connectors/codex.js needs the same visibility question as picker, system prompt and tool
// description — it points at gpt-5.4-mini, and whether that runs depends on the account kind. The question is HANDED IN
// instead of imported there: index.js imports codex.js, the way back would be a cycle. So it stays ONE computation
// (`visibleModels`) with two callers. The assignment runs at load, the function itself only during a run —
// `accountKinds` is further below and long present at call time.
setCodexVisibility((id) => visibleModels("codex", codexModels()).some((mo) => mo.id === id));

// ── Active provider & resolution ──────────────────────────────────────────────────
export const isProviderId = (id) => registry.has(id);

export function getActiveProviderId() {
  try {
    const v = store.getSetting("provider", DEFAULT_PROVIDER);
    return registry.has(v) ? v : DEFAULT_PROVIDER;
  } catch { return DEFAULT_PROVIDER; }
}

export function setActiveProviderId(id) {
  const v = registry.has(id) ? id : DEFAULT_PROVIDER;
  store.setSetting("provider", v);
  return v;
}

// Provider of a concrete chat (falls back to the global provider).
export const providerForChat = (chat) => (isProviderId(chat?.provider) ? chat.provider : getActiveProviderId());

// Environment of the respective provider (token cleanup).
export const cleanEnvFor = (id) => (getConnector(id) || getConnector(DEFAULT_PROVIDER)).cleanEnv();

// ── Start gate at the spawn layer ────────────────────────────────────────────────
// `runOnce` has around twenty callers (verdicts, titles, goal gate, compaction, channel status, adjust), and none of
// them passes through doRun's credit gate. Instead of guarding every caller individually, runOnce asks ONE hook BEFORE
// the connector, which server.js installs at boot. It gets provider, model, the chat (if one is fixed) and the purpose
// and answers `{ ok: true }` or `{ ok: false, window, percent, text }`. No hook installed (tests, local without gate) ⇒
// always ok. What the gate decides — threshold, provider, model windows — lives in runs/limit-gate.js
// (gateVerdictHook); here it only says THAT it is asked, and what the caller passes along: `approval` (this oneshot
// follows a turn that already passed its gate — title, curator) and `overruled` (the human pressed "Start anyway", the
// verdict chain until the next turn runs under it). Both are arguments of the one call, not marks in memory.
let startGate = null;
export function setStartGate(fn) {
  startGate = typeof fn === "function" ? fn : null;
}
// The same hook for the second start path: a subagent runs via runChat, not via runOnce — its core (runs/agents.js)
// asks here, BEFORE the start, with the provider of the SUBAGENT and `purpose: "agent"`. No hook installed ⇒ ok, as
// with runOnce.
export async function startGateVerdict(o = {}) {
  if (!startGate) return { ok: true };
  return startGate(o);
}

// ── Dispatch ───────────────────────────────────────────────────────────────────
// opts.model may have the form "provider::model" (app agent settings): the embedded provider wins then — that way
// model strings carry the provider choice through all lib functions without every signature needing a provider
// parameter.
// opts.chatId (optional): the chat in whose context the call stands — only for the start gate; the connectors do not
// read it. Likewise `opts.approval` (the call follows a turn whose gate has already decided) and `opts.overruled` (the
// human explicitly released this start): both go unchanged to the hook, which knows the meaning — here it is only
// passed on, not decided.
//
// The NUMBER of running oneshots (quiet computation runs/routes.js `openWork`): title, classification, extraction,
// verdicts, curator, goal gate, compaction — all pass through here, and none is in `running`. A test that reads the DB
// after the run end would otherwise read before the title or the curator. Counted from entry (waiting at the start
// gate is open work too) to the end, thrown or not — bookkeeping only, no behavior.
// Also per chat ("running verdicts and oneshots of the chat" in a project's idle state, projectbox/idle.js) — the same
// bookkeeping, by `opts.chatId`; a oneshot without a chat only counts above.
let oneshotsRunning = 0;
const oneshotsPerChat = new Map(); // chatId → count
export const runningOneshots = () => oneshotsRunning;
export const runningOneshotsOf = (chatId) => oneshotsPerChat.get(String(chatId || "")) || 0;
export async function runOnce(prompt, opts = {}) {
  oneshotsRunning += 1;
  const chatId = opts?.chatId ? String(opts.chatId) : "";
  if (chatId) oneshotsPerChat.set(chatId, (oneshotsPerChat.get(chatId) || 0) + 1);
  try { return await runOnceCounted(prompt, opts); }
  finally {
    oneshotsRunning -= 1;
    if (chatId) {
      const n = (oneshotsPerChat.get(chatId) || 1) - 1;
      if (n > 0) oneshotsPerChat.set(chatId, n); else oneshotsPerChat.delete(chatId);
    }
  }
}
async function runOnceCounted(prompt, opts) {
  let { provider, model } = opts;
  const ref = parseModelRef(model);
  if (ref.provider && isProviderId(ref.provider)) { provider = ref.provider; model = ref.model; }
  const id = isProviderId(provider) ? provider : getActiveProviderId();
  const connector = getConnector(id);
  if (startGate) {
    // `instance` and `projectId` of a oneshot that runs in the project container (service detection) — the per-project
    // lock then judges its project, even without a chat (runs/project-lock.js).
    const u = await startGate({
      provider: id, model, chatId: opts.chatId || "", purpose: "oneshot",
      approval: opts.approval === true, overruled: opts.overruled === true,
      projectId: opts.projectId || null, instance: opts.instance || null,
    });
    if (!u || u.ok !== true) {
      // The wording comes from the hook (limits.gateLimitText): the callers' limit detection reads it like a CLI limit
      // — they need no special gate path. `err.gate` carries window and percent for whoever wants to know more.
      const err = new Error(String(u?.text || "Usage limit reached — credit gate"));
      // `model`: the model the gate judged — the wait time of the gate row computes from the same windows
      // (limits.gateWaitTime in maybeAutoContinue).
      err.gate = { window: u?.window || null, percent: u?.percent ?? null, model: model || "" };
      // The verdict of the per-project lock: kind "wait" lets the caller wait instead of fail (projects/scans.js).
      if (u?.project) err.project = u.project;
      throw err;
    }
  }
  // Two axes, two filters: "can look at images" is not "accepts a PDF". The caller asks beforehand with
  // materialCapabilities() and PHRASES accordingly — a prompt that refers to material that never arrived is worse than
  // one without material. This is the net underneath; the connector additionally filters itself because it can also be
  // called directly.
  const opt = {
    ...opts,
    ...(connector?.caps?.vision ? {} : { images: [] }),
    ...(connector?.caps?.documents ? {} : { documents: [] }),
  };
  // The LEVEL: the same resolution as every run (`effortRunning`): the level passed for the app agent, empty ⇒ default
  // level of the provider, clamped to the model that really runs (without a model the provider default). A model
  // without levels (Haiku 4.5) yields "" — no flag, no field. A clamp is only reported if someone explicitly WANTED a
  // level; the default on Haiku (title, goal, factory verdicts) is not a finding that deserves a line per call.
  let runModel = model || "";
  if (!runModel) { try { runModel = defaultModelFor(id); } catch { runModel = ""; } }
  const effort = effortRunning(id, runModel, opts.effort, { report: effortSavable(opts.effort).kind === "level" });
  // The consumption: every connector reports it via `opts.atConsumption`; here the callback is wrapped so that a
  // missing provider/model name comes from THIS resolution and a throwing callback never fails the call
  // (`reportConsumption`). Without a callback the field stays undefined — the call is byte-identical.
  // The billing kind comes from THIS provider kind, never from the connector (consumption.js header): CLI with its own
  // loop ⇒ subscription, OpenRouter ⇒ metered — the same distinction as the booking of a run (runs/do-run.js: engine
  // `res.usage` metered, tally subscription).
  const billing = connector?.caps?.ownsAgentLoop ? "subscription" : "metered";
  const atConsumption = typeof opts.atConsumption === "function"
    ? (v) => reportConsumption(opts.atConsumption, { ...v, provider: v?.provider || id, model: v?.model || runModel, billing })
    : undefined;
  return connector.runOnce(prompt, { ...opt, provider: id, model, effort, atConsumption });
}

/**
 * What the provider behind this model reference ("[provider::]model") accepts as material.
 *
 * The caller needs that BEFORE building the prompt, not after: it phrases differently depending on whether the
 * material comes along ("you see it as document 1 below") or not ("exists, cannot be shown to you"). Hence one query
 * and not two — whoever asks only one of the two axes is guaranteed to write the wrong thing for the other.
 */
export function materialCapabilities(modelRef = "") {
  const r = resolveModelRef(modelRef);
  const caps = r.connector?.caps;
  // Images per MODEL where the connector knows it (OpenRouter: the catalog, `architecture.input_modalities`) — the wire
  // can do images, but a model without image input cannot; without the question the prompt would say "see below" for
  // an image that never arrives.
  const images = Boolean(caps?.vision) && (typeof r.connector?.canImages !== "function" || r.connector.canImages(r.model) !== false);
  return { images, documents: Boolean(caps?.documents) };
}

/** Short form for "can look at images". */
export function canVision(modelRef = "") {
  return materialCapabilities(modelRef).images;
}

// ── Resolving model references ──────────────────────────────────────────────────
// "[provider::]model" → actual connector + resolved model id. An unknown prefix is NOT silently swallowed as a
// provider: then the whole string counts as a model of the fallback provider, and unknownProvider tells the caller
// that it may have mistyped.
export function resolveModelRef(ref, fallbackProviderId = "") {
  const { provider, model, raw } = parseModelRef(ref);
  const named = Boolean(provider) && isProviderId(provider);
  const id = named ? provider : (isProviderId(fallbackProviderId) ? fallbackProviderId : getActiveProviderId());
  const connector = getConnector(id);
  const wanted = named ? model : raw;
  return {
    providerId: id,
    connector,
    model: connector ? connector.resolveModel(wanted) : wanted,
    // Does the reference point at ANOTHER provider than the run's? Only then a switch is needed.
    crossProvider: named && provider !== fallbackProviderId,
    unknownProvider: Boolean(provider) && !named,
  };
}

/**
 * Does a model reference "provider::model" name a provider that does not exist? Returns its id, otherwise "" (also
 * without a prefix). For the routes that STORE a reference (agent definitions): a stored "nebius::…" would later run
 * silently at the chat's provider (resolveModelRef `unknownProvider`) — the route rather says so right away with 400
 * (guard only-three-provider.test.js).
 */
export function foreignProviderIn(ref) {
  const { provider } = parseModelRef(ref);
  return provider && !isProviderId(provider) ? provider : "";
}

// ── Visible models: ONE place for "may this account run this model?" ─────────────────────────────
//
// The Codex catalog lists two models that a ChatGPT account rejects with HTTP 400 ("The 'gpt-5.4' model is not
// supported when using Codex with a ChatGPT account."); they carry the mark `onlyApiKey` there (connectors/codex.js).
// If the decision stood only on the way to the picker, agentHosts() would keep reading the raw catalog, and
// "codex::gpt-5.4, codex::gpt-5.4-mini" would stand in EVERY system prompt that offers a subagent (runs/system-prompt.js) and
// in several error hints. Execution side and description side must give the same answer: a block cannot be bolted on,
// it belongs at the one place all paths pass.
//
// The account kind comes through a SETTER that /api/providers fills on every fetch (the clients poll this route
// constantly anyway) — and it SURVIVES the restart: `setAccountKind` writes it to the settings, `accountKind()` reads
// it from there if this process has not seen anything yet. Without that the block would only hold from the first poll
// on — a backend that the gateway wakes two minutes before a schedule would keep naming the 5.4 family in EVERY system
// prompt that offers a subagent, and the agent that follows it would start a subagent into the measured 400. A picker never
// appears in such a run.
// A setter is explicitly RIGHT here because its default is an ANSWER and not a gap: as long as nobody has set
// anything, the account kind is unknown — and unknown means show EVERYTHING. "I don't know" must not become "does not
// apply" (empty is not unknown); a setter whose default TOOK something AWAY would be wrong here. No inquiry is made:
// `codex login status` has a 15 s timeout, and this function is on the run path.
const accountKinds = new Map(); // providerId → authMethod ("chatgpt" | "apikey")
const ACCOUNT_KIND_SETTING = (id) => `account_kind_${id}`;

/**
 * Remember the account kind of a provider read by /api/providers — in the process AND beyond it.
 *
 * Beyond it, because the setter otherwise only holds while someone is watching: the gateway wakes the container two
 * minutes before a schedule, the backend starts fresh, and until the first client fetches /api/providers the blocked
 * models would be back in EVERY system prompt that offers a subagent.
 *
 * An EMPTY account kind says nothing here: `codex login status` also reports it when the CLI is missing or nobody is
 * logged in, and for claude the route always sends "" (there are no account kinds there). It must therefore not delete
 * what is remembered — empty is not unknown, and unknown is not "no longer applies". Whoever really wants to forget
 * says so (forgetAccountKind).
 *
 * Written only on CHANGE: the clients poll this route every second.
 */
export function setAccountKind(providerId, authMethod) {
  const id = String(providerId || "");
  const value = String(authMethod || "");
  if (!id || !value || accountKinds.get(id) === value) return;
  accountKinds.set(id, value);
  try { store.setSetting(ACCOUNT_KIND_SETTING(id), value); } catch { /* without a store it holds for this session */ }
}

/**
 * Forget what was last seen — after a logout. Afterwards the account kind is unknown again, and unknown means show
 * EVERYTHING: nobody here knows which account logs in next, and a leftover block would take two models away from a
 * key account for no reason.
 */
export function forgetAccountKind(providerId) {
  const id = String(providerId || "");
  if (!id) return;
  accountKinds.delete(id);
  try { store.setSetting(ACCOUNT_KIND_SETTING(id), ""); } catch { /* see above */ }
}

/**
 * The account kind of this provider: what THIS process has seen, otherwise what the last one saw. A remembered value
 * can go stale (the user logs in differently between two starts) — it heals by itself on the first /api/providers,
 * and the wrong direction is the harmless one: it hides two models a few seconds too long instead of sending a
 * subagent into the 400.
 */
function accountKind(providerId) {
  const id = String(providerId || "");
  const seen = accountKinds.get(id);
  if (seen) return seen;
  try { return String(store.getSetting(ACCOUNT_KIND_SETTING(id), "") || ""); } catch { return ""; }
}

/**
 * The models of a provider that THIS account kind can run — without the cbase-internal mark `onlyApiKey`. That never
 * goes out: it is a measurement, not a contract with the client.
 */
export function visibleModels(providerId, models) {
  const subscription = accountKind(providerId) === "chatgpt";
  return (models || [])
    .filter((mo) => !(subscription && mo?.onlyApiKey))
    .map((mo) => { const { onlyApiKey, ...rest } = mo; return rest; });
}

// Providers that can supply a SUBAGENT of the native cbase agent tool — that is ALL of them: agent-runtime.js runs
// every subagent as its own run via runChat. So a native CLI (Claude/Codex) is possible as a subagent too — and a Codex
// chat, which has no subagent tool of its own, can start a Claude subagent. Only what demonstrably cannot run is
// skipped: OpenRouter without a key.
//
// OpenRouter does NOT name its whole catalog (hundreds of models — system prompt, tool description and error hints
// would be full of it) but the SHORTLIST: the default model and the ones used within 30 days (from usage_events), as
// far as the catalog lists them with tools. Plus `catalog: true` — whoever describes the list adds that every catalog
// model with tools is selectable via `openrouter::<id>`, and whoever checks a model checks against the catalog
// (`catalogKnows`), not against the shortlist (dynworkflows/model.js).
// The ORDER is stable: the default first, the used ones by name (store usedModelsSince) — the list stands in the
// system prompt of every chat, also the Claude and Codex chats (runs/do-run.js subagentChoicePrompt), and an order by
// "last used" would change the prompt as soon as another OpenRouter model ran anywhere: the prompt cache of the whole
// history would expire in every open chat.
export const SHORTLIST_DAYS = 30;
function openRouterShortlist(models) {
  const byIdMap = new Map((models || []).filter((m) => m?.id).map((m) => [m.id, m]));
  const ids = [];
  const take = (id) => { if (id && !ids.includes(id) && (byIdMap.has(id) || !byIdMap.size)) ids.push(id); };
  take(defaultModelFor(OPENROUTER_ID));
  let used = [];
  try { used = store.usedModelsSince(OPENROUTER_ID, Date.now() - SHORTLIST_DAYS * 86_400_000); } catch { /* store not open yet */ }
  for (const id of used) take(id);
  return ids.map((id) => ({ id, label: byIdMap.get(id)?.label || id }));
}
export function agentHosts() {
  const out = [];
  for (const c of listConnectors()) {
    if (c.id === OPENROUTER_ID) {
      let access = null;
      try { access = store.openRouterAccess(); } catch { /* store not open yet */ }
      if (!access?.apiKey) continue;
      out.push({ id: c.id, label: c.label, catalog: true, models: openRouterShortlist(c.models) });
      continue;
    }
    out.push({ id: c.id, label: c.label, models: visibleModels(c.id, c.models).filter((m) => m.id).map((m) => ({ id: m.id, label: m.label })) });
  }
  return out;
}

/**
 * May a run (provider, model) go, as far as the CATALOGS know? Claude/Codex: the model is in the visible catalog;
 * OpenRouter: in the catalog with tools — and an EMPTY catalog (no state, no network) is unknown, hence yes (empty is
 * not "does not exist"). For checks that should accept more than the shortlist (agent() of a dynamic workflow).
 */
export function modelSelectable(providerId, model) {
  const id = String(model || "").trim();
  if (!id || !isProviderId(providerId)) return false;
  if (providerId === OPENROUTER_ID) return catalogKnows(id) !== false;
  return visibleModels(providerId, PROVIDERS[providerId]?.models).some((m) => m.id === id);
}

export function runChat({ providerId, spec, onEvent, onSpawn }) {
  const id = isProviderId(providerId) ? providerId : getActiveProviderId();
  const connector = getConnector(id);
  // Native connectors bring their own tool loop; completion connectors are driven by the generic loop engine (which
  // turns connector.complete into an agentic run).
  if (connector.caps.ownsAgentLoop) return connector.runChat({ spec, onEvent, onSpawn });
  // The engine stays registry-blind (it only knows its own connector). Subagents — also at ANOTHER provider — it
  // starts only via cbase_agent and the core (agent-runtime.js), which resolves the models itself.
  return runChatViaEngine(connector, { spec, onEvent, onSpawn });
}

// Model resolution (Codex maps Claude ids → Codex ids; Claude and OpenRouter pass through).
export function resolveModelFor(id, model) {
  const connector = getConnector(id);
  return connector ? connector.resolveModel(model) : (model || "");
}

// ── Which level really runs ───────────────────────────────────────────────────────────────────
//
// The ONE resolution for every run: set ⇒ default level ⇒ clamp to the model via the substitution rule
// (`effortFallback`). It lives HERE and not in workflows.js because it needs the catalog (it asks the connector for the
// model's levels: `connector.efforts(model)`), and workflows.js is imported by all connectors — a cycle would arise
// there.
//
// The clamp is the same computation as at spawn (`mapClaudeEffort`, `codexEffortFallback`, the openai-chat wire): the
// same `effortFallback` against the same list, and `effortFallback` is idempotent — the connector that clamps once more
// afterwards changes nothing. A connector without `efforts` (test fakes, future exotics) carries "unknown": the level
// passes through; an empty list means "no levels".
// This function does NOT ask `caps.effort`: a connector with the effort level switched off does not send it on the
// wire anyway, and a subagent of the loop engine on ANOTHER connector gets the same value — emptying it here would
// take the level away from it.

// Does this provider send a level on the wire at all? No only with `caps.effort` explicitly switched off (the contract
// allows a connector that; none of the three does) — an unknown provider is "yes" (empty is not unknown). Where no
// level goes out, no display claims one — no notice row of the migration, no `defaultEffort` in /api/providers.
// `effortRunning` still does NOT ask it (reason above).
export const levelOnWire = (providerId) => getConnector(providerId)?.caps?.effort !== false;

// ── Default model and default level per provider ───────────────────────────────────────────────
//
// `defaultModelFor` lives here because the default level depends on the default MODEL (preset with its catalog level)
// and the run's resolution (`effortRunning`) is HERE — the way back account/providers.js → index.js would be a cycle.
// account/providers.js re-exports it.

// The fallback only applies while the user has chosen nothing (or for old chats with model=''). ONE place: the
// defaults of the app agents (settings/agent-models.js) and of the compaction (runs/post-run.js) read this value or
// defaultModelFor, the web keeps its copy (ChatCatalog.tsx) under web/test/list-binding.test.mjs.
export const DEFAULT_MODEL_FALLBACK = { claude: "claude-sonnet-5-5", codex: "gpt-5.6-sol" };
// The fallback LEVEL next to it: without a stored default level (`default_effort_<id>`) the fallback MODEL of this
// provider runs with this level instead of its catalog level — no matter whether it is stored as the default or only
// applies through the fallback. The rule depends on the MODEL, not on the storage state: "Sonnet 5.5 stored" and
// "nothing stored" would look the same in the picker, and no way leads back to "nothing stored"
// (`PUT /api/default-model ""` is a 400) — a difference there would be hidden state. Every other default model keeps
// its catalog level, a stored default level precedes everything. Codex has no entry (fallback = catalog level of its
// fallback model). ONE place: read only in `effortStandard`; web and iOS read `defaultEffort` from /api/providers and
// do not compute themselves.
export const DEFAULT_EFFORT_FALLBACK = Object.freeze({ claude: "high" });

// Default model per provider — selectable in the settings (the picker never says "default" but always a concrete
// name). Sent explicitly as --model on every run.
export function defaultModelFor(provider) {
  const p = isProviderId(provider) ? provider : "claude";
  // VISIBLE, not just known: the Codex catalog lists two models that a ChatGPT account rejects with 400. If
  // `default_model_codex` stood on one of them, `/api/providers` would deliver a `defaultModel` that is missing from
  // its OWN `models` list, and every chat without its own model would spawn the measured 400. A default that cannot
  // run is not a default.
  const models = visibleModels(p, PROVIDERS[p]?.models);
  const runnable = (id) => !!id && models.some((mo) => mo.id === id);
  // A retired default model counts as its successor (providers/retired.js) — the same table as the migration, which
  // rewrites the value once; without this line a retired name stored again by an old client would fall to the fallback
  // below instead of the designated successor.
  const stored = runningModel(p, store.getSetting(`default_model_${p}`, ""));
  if (runnable(stored)) return stored;
  // OpenRouter has NO fallback: nobody chose the first model of the catalog, it changes with every refresh (every 6 h)
  // and can be an expensive one — and it would silently stand in every chat without a model, every one-time call and
  // the shortlist in the system prompt of all chats. A stored default HOLDS even if the catalog does not currently list
  // it (with tools) — as with an empty catalog (empty is not unknown); /api/providers reports that as
  // `defaultModelInvalid`. Without a stored one there is none: "" — the connector then
  // rejects a run without a model with a clear message (connectors/openai-chat.js `withoutModel`) instead of guessing.
  if (p === OPENROUTER_ID) return stored || "";
  // Natives: proven fallback. If the fallback does not work for this account kind either, the first visible model
  // stays — rather another one than none (both catalogs are fixed and small, their first model is a decision, not a
  // provider's whim).
  if (!models.length && stored) return stored;
  if (runnable(DEFAULT_MODEL_FALLBACK[p])) return DEFAULT_MODEL_FALLBACK[p];
  return models[0]?.id || "";
}

/**
 * Is a default model stored that the (known) catalog does not list as runnable? OpenRouter only — there it holds
 * anyway (see defaultModelFor), and the settings page should say so. An empty catalog is unknown ⇒ no.
 * @param {string} provider
 * @returns {boolean}
 */
export function defaultModelInvalid(provider) {
  if (provider !== OPENROUTER_ID) return false;
  const models = visibleModels(OPENROUTER_ID, PROVIDERS[OPENROUTER_ID]?.models);
  let stored = "";
  try { stored = String(store.getSetting(`default_model_${OPENROUTER_ID}`, "") || ""); } catch { return false; }
  return Boolean(stored && models.length && !models.some((mo) => mo.id === stored));
}

// The default level of a provider whose models carry no catalog level (OpenRouter): the API default of most providers.
export const DEFAULT_LEVEL_WITHOUT_CATALOG = "medium";
// Where the chosen default level of a provider is stored — next to `default_model_<id>`.
export const DEFAULT_LEVEL_SETTING = (providerId) => `default_effort_${providerId}`;

/**
 * The catalog level of a model: the level with which the CLI runs this model WITHOUT `--effort` — `catalogLevel` on
 * the catalog entry (Claude: the CLI's account catalog, Codex: `default_reasoning_level`, measured, see the catalogs).
 * "" means: the catalog names none (OpenRouter, a model outside the catalog, Haiku 4.5 without levels).
 * @param {string} providerId
 * @param {string} model
 * @returns {string}
 */
export function effortCatalogLevel(providerId, model) {
  const connector = getConnector(isProviderId(providerId) ? providerId : getActiveProviderId());
  const id = typeof connector?.resolveModel === "function" ? (connector.resolveModel(model || "") || model) : model;
  const level = (connector?.models || []).find((mo) => mo?.id === id)?.catalogLevel;
  return effortSavable(level).kind === "level" ? level : "";
}

/**
 * The default level of a provider — the step between "nothing set" and the clamp. The chosen one from the settings
 * (`PUT /api/default-effort`), otherwise — if the default model is the fallback model (`DEFAULT_MODEL_FALLBACK`,
 * stored or not) — the provider's fallback level (`DEFAULT_EFFORT_FALLBACK`), otherwise preset with the catalog level
 * of the default MODEL, otherwise `medium`. Always a level from EFFORT_LEVELS — clamping only happens in the run, to
 * its model (`effortRunning`), because the default applies to every model of the provider.
 * @param {string} providerId  unknown ⇒ the global one
 * @returns {string}
 */
export function effortStandard(providerId) {
  const id = isProviderId(providerId) ? providerId : getActiveProviderId();
  let selected = "";
  try { selected = store.getSetting(DEFAULT_LEVEL_SETTING(id), ""); } catch { /* store not open yet: preset */ }
  if (effortSavable(selected).kind === "level") return selected;
  let model = "";
  try { model = defaultModelFor(id); } catch { model = DEFAULT_MODEL_FALLBACK[id] || ""; }
  const fallback = DEFAULT_EFFORT_FALLBACK[id];
  if (model && model === DEFAULT_MODEL_FALLBACK[id] && effortSavable(fallback).kind === "level") return fallback;
  return effortCatalogLevel(id, model) || DEFAULT_LEVEL_WITHOUT_CATALOG;
}

/**
 * The level a chat WANTS, before the clamp: the stored one, otherwise the default level of ITS provider. A subagent
 * inherits exactly this wish from the parent chat and clamps it to ITS model — not the default of its own provider,
 * otherwise a Codex subagent of a Claude chat without a level would think with medium instead of high.
 * @param {string} providerId  provider of the chat (unknown ⇒ the global one)
 * @param {unknown} set
 * @returns {string}
 */
export function effortDesired(providerId, set) {
  const verdict = effortSavable(set);
  return verdict.kind === "level" ? verdict.level : effortStandard(providerId);
}

/**
 * The level with which (provider, model) really thinks when `set` is stored.
 * @param {string} providerId  provider of the run (unknown ⇒ the global one)
 * @param {string} model       the model of the run, AS it goes to the connector (aliases allowed)
 * @param {unknown} set        the stored level ("" or something that is not a level ⇒ default)
 * @param {{report?: boolean}} [opts]  `report`: write a clamp as a line to the log — only the run (runs/do-run.js)
 *   does that; the connector only sees the already clamped level. A display that asks reports nothing.
 * @returns {string} a level from EFFORT_LEVELS or "" (none at all — no flag, no field)
 */
export function effortRunning(providerId, model, set, { report = false } = {}) {
  const id = isProviderId(providerId) ? providerId : getActiveProviderId();
  const wish = effortDesired(id, set);
  if (!wish) return "";
  const connector = getConnector(id);
  // No list (connector without `efforts`, model outside the catalog) means "unknown" and passes through; an EMPTY one
  // means "no levels" and yields "" (see `effortFallback`).
  const supported = typeof connector?.efforts === "function" ? connector.efforts(model || "") : null;
  const level = effortFallback(wish, supported);
  if (report && level !== wish) {
    const who = (typeof connector?.resolveModel === "function" && connector.resolveModel(model || "")) || model || "(default)";
    console.warn(level
      ? `[${id}] Effort "${wish}" is not supported by ${who} (supported: ${(supported || []).join(", ")}) — the run thinks with "${level}".`
      : `[${id}] ${who} supports no effort levels — "${wish}" does not go to the CLI.`);
  }
  return level;
}

// Login status of a provider (Codex/OpenRouter: own authStatus; Claude: null → account/routes.js asks separately).
export function providerAuthStatus(id) {
  const connector = getConnector(id);
  return connector && connector.authStatus ? connector.authStatus() : Promise.resolve(null);
}

// Re-exports that account/routes.js, runs/limit-gate.js and aux claude.js expect.
export { buildClaudeChatArgs, cleanClaudeEnv, codexRateLimitSnapshot, codexUsage };
