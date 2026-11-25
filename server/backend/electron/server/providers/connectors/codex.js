// Provider "codex" — the OpenAI Codex CLI (`codex exec --json`), non-interactive on the host.
// Auth via the ChatGPT subscription (`codex login`, stored in ~/.codex/auth.json).
// The core is the translation of the Codex event stream into the CLAUDE-shaped stream-json events that backend
// (runs/do-run.js doRun) and frontend (ChatPane) already understand — so the rest of the app stays provider-independent.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// The mapping Codex item → canonical tool name belongs in the contract, not here: the renderer decides by exactly
// these names whether it shows a diff. Kept separately in two places, `apply_patch` could drop out of the renderer
// unnoticed.
import { CODEX_TOOL_NAME, mcpToolName } from "../contract.js";
// The order of the effort levels and the one clamp computation live with EFFORT_LEVELS — workflows.js is a leaf
// without imports of its own, so the edge costs nothing.
import { EFFORT_LEVELS, effortFallback } from "../../workflows.js";
// `end()` can throw EPIPE too if the CLI is already gone — so the Codex path also closes the child's stdin through
// the helper (see providers/kind-stdin.js).
import { closeStdin } from "../kind-stdin.js";
import { reportConsumption } from "./consumption.js";
// The prefix of a run (defaults + tool names), only if the thread does not carry it (see the header there).
import { codexInput } from "./codex-prefix.js";
import { successorOf } from "../retired.js";
import { codexCatalogModels } from "../native-catalog.js";
// The ONE start function: without an instance exactly `spawn`, with an instance in the project container (runtime/inProject.js).
import { bOwnInOps, inProject, withGitWrapperFront } from "../../runtime/inProject.js";
import { openFromRuntimeFolder } from "../../runs/runtime-write.js";
import { withLfsEnvironment } from "../../runs/lfs-environment.js";
import { T } from "../../i18n.js";
// CPU saver: only the priority — the Codex CLI runs its shell itself, there is no waiting before the command here.
import { withNice } from "../../../mcp/cpu-saver.js";

export const codexBin = () => process.env.CODEX_BIN || "codex";

// Codex's OWN delegation is off in every cbase Codex run: its starts (`spawn_agent`/`wait_agent`) do not arrive in the
// `exec --json` stream, `turn.completed` only counts the main agent, and on Codex's highest thinking level it
// delegates proactively (cbase does not offer that level). There is exactly ONE orchestrator: cbase's (`cbase_agent`).
//
// Three switches, not one — measured at 0.153.1 (on the wire and with real oneshots), re-measured on the wire at
// 0.162.1 (the same — there also ALL_TOOLS from a real exec call: a v1 model
// like gpt-5.6-luna carries `multi_agent_v1__spawn_agent` … ONLY in exec, never in the request; with the three
// switches they are missing). The CLI's computation (`Config::multi_agent_version_override`, tag rust-v0.153.1):
// feature `multi_agent_v2` on ⇒ V2; otherwise `agents.enabled = false` ⇒ off; otherwise the version from the MODEL
// CATALOG (Sol, Astra …: "v2") precedes the feature `multi_agent`. Hence:
//   • `--disable multi_agent` alone has NO EFFECT for the catalog models (measured: all nine tools and the proactive
//     instruction stay) — it only covers ids without a catalog version (V1 fallback).
//   • `-c agents.enabled=false` switches off: `multi_agent_version: "disabled"`, no collaboration tools, no
//     `<multi_agent_mode>` instruction — also when resuming an old v2 thread.
//   • `--disable multi_agent_v2`, because a switched-on v2 feature (e.g. from a config.toml in the container) beats
//     `agents.enabled=false` — measured.
// All three stand BEFORE a `resume`, like every exec flag here — measured in exactly this form: the resumption of a v2
// thread with the switches before the subcommand runs with `multi_agent_version: "disabled"`.
export const CODEX_WITHOUT_DELEGATION = Object.freeze(["--disable", "multi_agent", "--disable", "multi_agent_v2", "-c", "agents.enabled=false"]);

// Codex WITHOUT tools with file access (Codex stays selectable as an outer-loop provider): with only `-s read-only` a
// sandboxed outer-loop run without chosen built-ins would keep the shell (`exec_command`), which reads the WHOLE file
// system of the process in the read-only sandbox, while its frame says "no file access, no commands". Measured at the
// pin 0.153.1, re-measured at 0.162.1 (on the wire with REAL calls from
// code mode, a random mark in a file OUTSIDE the cwd):
//   • without switches: `exec_command` (+ `write_stdin`) is in ALL_TOOLS and reads the mark; `view_image` reads every
//     IMAGE outside the cwd (it rejects text); the read-only sandbox rejects `apply_patch` (nothing written inside or
//     outside).
//   • `--disable shell_tool` removes `exec_command` and `write_stdin` (the mark no longer arrives); `--disable
//     unified_exec` alone has no effect; `--disable view_image` removes `view_image`.
// What remains: `apply_patch` (rejected by the sandbox) and since 0.162.1 `list_mcp_resources`/
// `list_mcp_resource_templates`/`read_mcp_resource` — they read resources of the CONFIGURED MCP servers, no files
// (what an external server offers as a resource is not measured). `unified_exec` is included so that a future switch
// rework of the CLI does not silently bring the shell back — a CLI jump re-measures it (script above).
// For `apply_patch` and the resource tools there is NO switch at the pin (measured without effect:
// `-c include_apply_patch_tool=false`, `-c tools.apply_patch=false`,
// `--disable apps|image_generation|tool_suggest|skill_search|sleep_tool`, `-c web_search="disabled"`;
// `--disable code_mode_host` breaks code mode itself) — the frame therefore names them (outerloop/input.js builtinRow).
// The goal tools and `request_user_input` are removed by CODEX_WITHOUT_OWN_TOOLS (below) — included in this cut.
//
// Codex's OWN goal and question tools are off in EVERY cbase Codex run. cbase needs none of them: cbase manages goals
// itself (`/goal` runs locally, the goal is in the system prompt, the verdict is its own oneshot — runs/post-run.js),
// questions go via `cbase_ask`, and no event of the Codex stream maps either. Offered, they cost ≈ 3,000 characters
// per request.
//   • `--disable goals` (measured at 0.162.1, request AND ALL_TOOLS): removes
//     `create_goal`/`get_goal`/`update_goal`.
//   • `-c tools.experimental_request_user_input.enabled=false` (measured at
//     0.162.1 AND 0.153.1): `request_user_input` stood at the front of the request (next to `exec` and `wait`); when
//     called, the CLI only answers in `exec` "request_user_input is unavailable in Default mode". With the switch the
//     name is missing from the WHOLE request, also on `exec resume` of a thread that carried it; a call ends as
//     "unsupported call". Measured without effect: `--disable default_mode_request_user_input`,
//     `--disable collaboration_modes`, `-c tools.request_user_input=false`, `-c features.request_user_input=false`,
//     `-c tools.experimental_request_user_input={}`/`.default_mode=false`;
//     `-c tools.experimental_request_user_input=false` breaks config loading (a structure, not a boolean).
// Both stand BEFORE a `resume` like every exec flag. In the form of a CODING CHAT
// (measured at 0.162.1 AND 0.153.1 — argv as here: shell on, each mode
// bypass/workspace-write/read-only, `-m`, window, level, MCP servers) they hold as well: `request_user_input` is
// missing at the top of the request (`exec`, `wait` remain), `create_goal`/`get_goal`/`update_goal` are missing from
// the exec description AND from `ALL_TOOLS`, a call of `request_user_input` ends as "unsupported call" — fresh, on
// `exec resume` and on `exec resume` of a thread in which `create_goal` had set an active goal before (without
// switches). Without switches the CLI inserts a goal context there on every resumption
// (`<codex_internal_context source="goal">` as a user message before the task, "Continue working toward the active
// thread goal"); with switches never. What such a thread already carries in its history stays history.
// A CLI jump re-measures them (the three scripts).
//
// Codex's OWN skill, plugin and app catalog belongs to it too. Otherwise every Codex run carries a developer message
// `<skills_instructions>` (~9.1k characters in real rollouts): the system skills that the CLI itself puts into
// `$CODEX_HOME/skills/.system` on every start (imagegen, openai-docs, skill-creator, skill-installer, plugin-creator),
// and the skills of the plugins the ChatGPT ACCOUNT has installed (`plugins/cache/openai-curated-remote/…`), plus
// `<recommended_plugins>`. That competes with the ONE loading path `cbase_skill` and the coding MCP airlock (external
// MCP only through it). Measured at 0.162.1 (without an account AND with a
// faked ChatGPT login, form of a coding chat):
//   • `-c skills.include_instructions=false` removes `<skills_instructions>` entirely (fresh and on `exec resume`);
//     `skills.bundled.enabled=false` would only remove the system skills.
//   • `--disable plugins`: the CLI no longer asks the ChatGPT backend for plugins (no requests to `/plugins/featured`,
//     `/ps/plugins/installed|list|suggested`) — without them there are neither plugin skills nor
//     `<recommended_plugins>`.
//   • `--disable apps`: no connector server `codex_apps` anymore (no requests to `/ps/mcp`) — the apps of the ChatGPT
//     account (Gmail, Drive …) would otherwise arrive as MCP tools past the airlock.
//   • without effect: `--disable remote_plugin`, `--enable skip_host_skill_discovery`.
// What remains: the section "# Using skills" in the model's base instructions (OpenAI's model catalog, per account) —
// not removable without replacing the whole base instructions; without a catalog it points nowhere. What a thread
// already carries before this cut stays history.
export const CODEX_WITHOUT_OWN_TOOLS = Object.freeze(["--disable", "goals", "-c", "tools.experimental_request_user_input.enabled=false",
  "--disable", "plugins", "--disable", "apps", "-c", "skills.include_instructions=false"]);
// The cut of a run without file access: the three file switches PLUS CODEX_WITHOUT_OWN_TOOLS — a run gets EXACTLY ONE
// of the two lists (`codexToolCut`), never both, otherwise the switches would stand twice in the argv.
export const CODEX_WITHOUT_FILE_ACCESS = Object.freeze(["--disable", "shell_tool", "--disable", "unified_exec", "--disable", "view_image",
  ...CODEX_WITHOUT_OWN_TOOLS]);
// The tool switches of a Codex exec: without file access the full cut, otherwise only Codex's own goal/question tools off.
export const codexToolCut = (withoutFileAccess) => (withoutFileAccess ? CODEX_WITHOUT_FILE_ACCESS : CODEX_WITHOUT_OWN_TOOLS);

// Codex does NOT read project memory itself: cbase puts CLAUDE.md/AGENTS.md into the prompt for every provider itself
// (runs/system-prompt.js projectMemoryPrompt — the same computation for Claude, Codex and the engine, also in the
// project container and in the copy). Codex would read AGENTS.md IN ADDITION: measured at 0.162.1
// (on the wire) every AGENTS.md from the git root to the cwd — the cwd
// is the workspace, in the project container the project —, without a repo the one in the cwd; never CLAUDE.md. The
// same file would be in the run twice. `-c project_doc_max_bytes=0` removes every project AGENTS.md (the global one in
// CODEX_HOME stays — it is the user's file, like Claude's ~/.claude/CLAUDE.md under `--setting-sources user`). On
// resume, what the old thread already carries stays in the history; a resumption WITHOUT the switch adds the files
// anew (measured) — it is therefore in EVERY exec, like all exec flags before `resume`. A CLI jump re-measures it
// (script above).
export const CODEX_WITHOUT_SELF_READ = Object.freeze(["-c", "project_doc_max_bytes=0"]);

// In `turn.completed.usage` Codex reports the CUMULATIVE tokens of the WHOLE thread (= total_token_usage), not the
// current model context. An agent turn can also contain many model calls; so even the difference of two totals can lie
// far above the context window. The real current context is only delivered by `last_token_usage` in the last
// token_count entry of the session rollout file. Only if this snapshot is not readable do we use the cumulative
// difference as a fallback.
// In addition `cached_input_tokens` is a SUBSET of `input_tokens` with Codex (total_tokens = input+output), while
// Claude adds the fields — otherwise we would count the cache share twice. We therefore pass input MINUS cached on as
// "fresh".
const codexCum = new Map(); // threadId → { input, output, cached }

// Codex uses the ChatGPT subscription (auth.json). An OPENAI_API_KEY that may be set would force API billing instead —
// hence removed, so that the subscription applies.
export function cleanCodexEnv() {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  return env;
}

// Available Codex models (for the model picker). gpt-5.6-sol is the default. No empty "default" entry — the default
// model is chosen explicitly in the settings. The picker knows no free text, so a model missing here is selectable
// nowhere.
//
// The values come from the account catalog (`~/.codex/models_cache.json`, read only): `max_context_window`,
// `default_reasoning_level`, `supported_reasoning_levels`. gpt-5.5 is retired (providers/retired.js): whatever pointed
// at it points at gpt-6-sol — the aliases below and stored values (one-time migration `account/model-migration.js`).
// No Codex catalog model currently has a gap in its levels; the clamp at spawn (`codexEffortFallback`) stays for the next
// model that has one (the tests run it on a test model, `server/backend/test/gaps-model.mjs`).
//
// `context` is TWO things: the window the context bar shows, AND the value buildCodexChatArgs passes to the CLI via
// `-c model_context_window` as soon as it lies above the CLI default. OpenAI's catalog (comes from the server per
// account) carries two numbers per model: `context_window` (default, 272k everywhere) and `max_context_window` (what
// the model accepts). The CLI clamps every configured value to this maximum
// (`context_window.min(max_context_window)` in models-manager/src/model_info.rs — measured: 872000 AND 1050000 both
// yield 828400 = 95 % in the session file). The 1.05M of the API docs apply to the API, not to Codex via the ChatGPT
// account. A larger window means: later compaction, more tokens per request against the subscription limit.
//
// `efforts` is cbase's OWN list, measured with real `codex exec` oneshots (CLI 0.153.1, ChatGPT account) — explicitly
// NOT OpenAI's catalog:
//   • a level the model does not support is an HTTP 400 ("Unsupported value: 'max' is not supported with the
//     'gpt-5.5' model. Supported values are: …") and costs the whole turn.
//   • Codex's level ABOVE max runs on some models although models_cache.json does not list it for them — the catalog
//     is a LOWER BOUND, not the truth. cbase does not offer it anyway: it switches on Codex's own proactive
//     delegation, and cbase does not see its starts. The lists therefore end at max.
// The levels `none`/`minimal`, which OpenAI also names, cbase does not offer — `EFFORT_LEVELS` does not list them, and
// every list here ⊆ EFFORT_LEVELS.
// `onlyApiKey`: `-m gpt-5.4` and `-m gpt-5.4-mini` ⇒ HTTP 400 "The 'gpt-5.4' model is not supported when using Codex
// with a ChatGPT account." The wording names the ACCOUNT, not the model — with an API key they presumably still run.
// So they stay in the catalog and only drop out of /api/providers while the login reports "chatgpt"
// (account/routes.js).
// `catalogLevel`: the level Codex runs without `model_reasoning_effort` — `default_reasoning_level` from OpenAI's
// model list (`~/.codex/models_cache.json`). It presets the provider's default level (`effortStandard` in
// providers/index.js).
// The order is that of the account catalog (`priority`) — the picker shows it that way. This static list is the FLOOR:
// with the CLI's account catalog (../native-catalog.js) `codexModels()` below takes the models from there.
export const CODEX_MODELS = [
  // GPT-6.2 Sol/Astra and GPT-6.1 Terra need Codex ≥ 0.166 (catalog `minimal_client_version`); measured at the pin 0.172.0
  // with real oneshots on the ChatGPT account at `low` and `max` (with the 872k window) — all ran.
  { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", context: 872000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "medium" },
  { id: "gpt-6.2-astra", label: "GPT-6.2 Astra", context: 872000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "low" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", context: 872000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "medium" },
  { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", context: 872000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "low" },
  { id: "gpt-6-astra", label: "GPT-6 Astra", context: 872000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "low" },
  { id: "gpt-6-sol", label: "GPT-6 Sol", context: 872000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "medium" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", context: 872000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "medium" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", context: 872000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "medium" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", context: 872000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "medium" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", context: 872000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "medium" },
  { id: "gpt-5.4", label: "GPT-5.4", context: 272000, efforts: ["low", "medium", "high", "xhigh", "max"], onlyApiKey: true },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini", context: 272000, efforts: ["low", "medium", "high", "xhigh", "max"], onlyApiKey: true },
];
/**
 * The Codex models cbase offers NOW: the CLI's account catalog (providers/native-catalog.js — order, levels, default level and
 * window from there; hidden models and ones above the CLI's version drop out), plus the static `onlyApiKey` entries the
 * catalog of a ChatGPT login never lists; without a catalog the static list above. Every reader asks here.
 */
export function codexModels() {
  const dynamic = codexCatalogModels();
  if (!dynamic) return CODEX_MODELS;
  const extra = CODEX_MODELS.filter((m) => m.onlyApiKey && !dynamic.some((d) => d.id === m.id));
  return [...dynamic, ...extra];
}
// The CLI's default for every model (`context_window` in the OpenAI catalog). Only above it a
// `-c model_context_window` pays off; below it or for models outside the catalog the call stays unchanged — the CLI
// then knows best itself what applies.
const CODEX_CONTEXT_DEFAULT = 272000;
export function codexContextWindow(modelId) {
  const ctx = codexModels().find((m) => m.id === modelId)?.context;
  return Number(ctx) > CODEX_CONTEXT_DEFAULT ? Number(ctx) : 0;
}

// May the logged-in account run this model? The answer is in the registry (providers/index.js: `visibleModels`, fed
// by /api/providers and restored from the settings). IMPORTING from there would be a cycle — index.js imports this
// file. So index.js hands the question in, and it stays ONE computation for all callers. `providers/index.js` is the
// ONLY importer of this file in the production tree, so the wiring always runs.
//
// The default here is explicitly an ANSWER and not a gap: as long as nobody has wired anything, every catalog model is
// visible. A setter whose default TOOK something AWAY would not belong here.
let modelVisible = () => true;
export function setCodexVisibility(fn) { modelVisible = typeof fn === "function" ? fn : () => true; }

// Translates a (possibly Claude) model name into a Codex model id. Empty/unknown → default.
export function resolveCodexModel(model) {
  const m = String(model || "").trim();
  if (!m) return "";
  // A retired model runs as its successor (providers/retired.js): a client with stale state can store the old name
  // again after the migration — without this line it would go to the CLI as `-m <old name>`. Before passing `gpt-…`
  // through below.
  const successor = successorOf("codex", m);
  if (successor) return successor;
  if (codexModels().some((mo) => mo.id === m)) return m;
  if (/^(gpt-|codex-|o[0-9])/i.test(m)) return m; // already an OpenAI model
  const l = m.toLowerCase();
  // "haiku" is the CHEAPEST of the three tiers and points at gpt-5.4-mini. Whether that model runs is a RUNTIME
  // question and not a table question: a ChatGPT account rejects the 5.4 family with 400, a key account runs it.
  // Hard-wiring the alias to the next model would take the cheapest tier away where it runs, and "haiku" and "sonnet"
  // would point at THE SAME model. So the alias asks the same visibility as every other path (see modelVisible). With
  // a ChatGPT account "haiku" and "sonnet" do mean THE SAME model.
  if (l.includes("haiku")) return modelVisible("gpt-5.4-mini") ? "gpt-5.4-mini" : "gpt-6-sol";
  if (l.includes("sonnet")) return "gpt-6-sol";
  if (l.includes("opus")) return "gpt-5.6-sol";
  if (l.includes("fable")) return "gpt-5.6-luna";
  return "";
}

// Reasoning effort → Codex model_reasoning_effort. The CLI passes the value raw to OpenAI; which levels apply the
// server decides — and it rejects unknown ones with 400. The whole turn is then lost before it begins. The block
// therefore belongs on the spawn side, where the error would arise.
// Exported because there are THREE lists of the same truth — this one, the `efforts` per model above and
// `EFFORT_LEVELS` in workflows.js (what a chat/run may store at all). If a level drops from one, it disappears
// silently: the picker would offer it, the route would write "" — or vice versa.
// `server/backend/test/codex-usage.test.js` binds the three together; without the export that would not be measurable.
//
// This list is a MEASUREMENT and not a gate: whether something is a level at all `EFFORT_LEVELS` answers — the same
// answer for all clamps. A gate next to it would reintroduce the difference: a level that EFFORT_LEVELS lists and this
// set does not would drop at Codex and be clamped at the others.
export const CODEX_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

// The measured effort list of a model; `null` for ids outside the catalog (unknown).
//
// It is NOT the source of /api/providers — the route passes `CODEX_MODELS` itself through (`visibleModels` in
// providers/index.js keeps the field `efforts` and only strips the mark `onlyApiKey`). This function has TWO
// production callers, and both clamp: `codexEffortFallback` below (at spawn) and `efforts` of the Codex connector in
// providers/index.js (`effortRunning`). A change here reaches no picker.
export function codexEfforts(modelId) {
  const list = codexModels().find((m) => m.id === modelId)?.efforts;
  // Outside the catalog: `null` = unknown (pass through), NOT `[]` — an empty list means "no levels" and would take
  // the level away from an unknown model.
  return Array.isArray(list) ? [...list] : null;
}

/**
 * The level that runs INSTEAD of the chosen one — here only the Codex side of the question (which levels does this
 * model support?); the computation itself lives ONCE in `workflows.js:effortFallback` and applies to all clamps. Web and
 * iOS replicate it so that the UI names the same level that then really thinks.
 *
 * The rule there: the highest supported level that is NOT ABOVE the requested one — so clamping goes DOWN, never up,
 * because one level more costs thinking tokens against the subscription limit.
 *
 * Two cases return the level unchanged, both for a reason:
 *   • A model WITHOUT a catalog entry (foreign id): the maximum is not known there, and guessing would be worse than
 *     passing through — cbase knows nothing about foreign ids.
 *   • What the list contains is supported: nothing to clamp.
 * What is not a level at all (not in EFFORT_LEVELS) stays "" and drops — no flag.
 */
export function codexEffortFallback(effort, modelId = "") {
  return effortFallback(effort, codexEfforts(modelId));
}

// The clamp at spawn — the same computation, only AUDIBLE. The line names the SUBSTITUTE and not just the loss: a
// message that only says what drops leaves open what the run thinks with now. Two cases, two sentences: a REAL level
// this model does not support is replaced; something that is not a level at all drops — that can only come from a
// leak in the resolution (`effortRunning` in providers/index.js, which every run asks), and a leak that stays silent
// nobody looks for.
function mapEffort(effort, modelId = "") {
  const e = String(effort || "").toLowerCase();
  const fallback = codexEffortFallback(e, modelId);
  if (!fallback) {
    if (e) console.warn(`[codex] "${e}" is not an effort level at all (valid: ${EFFORT_LEVELS.join(", ")}) — the run thinks with the CLI default.`);
    return "";
  }
  if (fallback !== e) {
    console.warn(`[codex] Effort "${e}" is not supported by ${modelId} (measured: ${(codexEfforts(modelId) || []).join(", ")}) — the run thinks with "${fallback}".`);
  }
  return fallback;
}

// Login status of the Codex CLI. → { connected, raw, authMethod }.
export function codexAuthStatus() {
  return new Promise((resolve) => {
    execFile(codexBin(), ["login", "status"], { env: cleanCodexEnv(), timeout: 15_000 }, (err, stdout, stderr) => {
      const raw = String((stdout || "") + (stderr || "")).trim();
      // "Logged in using ChatGPT" / "Logged in using an API key" → connected.
      const connected = /logged in/i.test(raw) && !err;
      let authMethod = "";
      if (/chatgpt/i.test(raw)) authMethod = "chatgpt";
      else if (/api key/i.test(raw)) authMethod = "apikey";
      resolve({ connected, raw: raw.slice(0, 400), authMethod });
    });
  });
}

// Codex rate limits: read the last rate_limits snapshot from the newest session rollout file
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) — purely LOCAL (no network, no token). Codex writes the snapshot there
// after every turn. → { connected, primary, secondary, planType }.
function findRateLimits(o) {
  if (!o || typeof o !== "object") return null;
  if (o.rate_limits && typeof o.rate_limits === "object") return o.rate_limits;
  for (const v of Object.values(o)) { const r = findRateLimits(v); if (r) return r; }
  return null;
}

function findTotalUsage(o) {
  if (!o || typeof o !== "object") return null;
  if (o.total_token_usage && typeof o.total_token_usage === "object") return o.total_token_usage;
  for (const v of Object.values(o)) { const r = findTotalUsage(v); if (r) return r; }
  return null;
}

function findLastUsage(o) {
  if (!o || typeof o !== "object") return null;
  if (o.last_token_usage && typeof o.last_token_usage === "object") return o.last_token_usage;
  for (const v of Object.values(o)) { const r = findLastUsage(v); if (r) return r; }
  return null;
}

function findContextWindow(o) {
  if (!o || typeof o !== "object") return null;
  if (typeof o.model_context_window === "number") return o.model_context_window;
  for (const v of Object.values(o)) { const r = findContextWindow(v); if (r != null) return r; }
  return null;
}

function normalizedUsage(u) {
  if (!u || typeof u !== "object") return null;
  return {
    input: Number(u.input_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    cached: Number(u.cached_input_tokens) || 0,
  };
}

// The Codex homes of the converted projects: there Codex writes its rollouts in the project container
// (`CODEX_HOME=<runtime>/home/.codex`, visible at the same path in the backend). server.js sets the source
// (runs/session-location.js) — a setter, because a connector does not ask the store. Unset or without an instance row
// the list is empty and the roots are the plain ones; the login is shared, so the usage snapshots apply to the whole
// account, no matter from which home.
let codexHomeSource = null;
// Plus the home of ONE project (runs/session-location.js): the home in which a run writes in its project container
// and reads on resume (rolloutOfTheThread).
let codexHomeOfProject = null;
export function setCodexHomeSource(fn, homeOfProject = null) {
  codexHomeSource = typeof fn === "function" ? fn : null;
  codexHomeOfProject = typeof homeOfProject === "function" ? homeOfProject : null;
}
// → [{ base, project }]: `project` means the home came from the source of the project homes (and is not a backend
// home) — a project container writes there, and its rollouts are CLAIMS (see rolloutText). The backend's homes come
// first.
function codexSessionRoots(codexHome) {
  let projectHomes = [];
  try { projectHomes = codexHomeSource ? codexHomeSource() || [] : []; } catch { projectHomes = []; }
  const on = (p) => path.resolve(String(p));
  const homesB = [codexHome, process.env.CODEX_HOME, path.join(os.homedir(), ".codex")].filter(Boolean).map(on);
  const inB = new Set(homesB);
  const homes = [...new Set([...homesB, ...projectHomes.filter(Boolean).map(on)])];
  return homes.map((home) => ({ base: path.join(home, "sessions"), project: !inB.has(home) }));
}

// ── Rollouts from the project homes ──────────────────────────────────────────────────────────────────────────────────────
// A project home lies in the runtime folder that the project container mounts rw — whatever lies there, an agent with
// an injection creates: a sparse file of 1.9 GB, a FIFO or a link in place of a file that is swapped between listing
// and reading (a blocking open would halt the backend), a rollout with mtime 2030 (it would always sort first) and an
// invented `rate_limit_reached_type` (a foreign project would hold every Codex chat at the "limit" that way).
// Therefore from a project home:
//   - opened only via runs/runtime-write.js openFromRuntimeFolder (O_NOFOLLOW|O_NONBLOCK, regular files only); what
//     cannot be opened that way does not exist;
//   - read only the END (at most ROLLOUT_END_MAX bytes, the cut-off first line is dropped) — snapshot and limit are in
//     the last lines;
//   - a rollout with mtime in the future drops already at listing (it would otherwise push the real ones out of the
//     first twelve);
//   - for the limit (codexRateLimitSnapshot) only the rollout of the OWN thread counts there, and the fallback of the
//     limit gate (codexUsage with `projectHomes: false`) only reads the backend's homes.
// The backend's homes are read plainly.
export const ROLLOUT_END_MAX = 1024 * 1024;
// "In the future" means: more than FUTURE_SPIEL_MS after now — a file just written carries fractions of a millisecond
// above Date.now().
const FUTURE_SLACK_MS = 5000;
function rolloutText(p, project) {
  if (!project) return fs.readFileSync(p, "utf8");
  let fd;
  try { fd = openFromRuntimeFolder(p); } catch { return null; }
  if (fd === null) return fs.readFileSync(p, "utf8"); // not under the runtime folders (a home without one): read plainly
  try {
    const st = fs.fstatSync(fd);
    if (st.mtimeMs > Date.now() + FUTURE_SLACK_MS) return null;
    const length = Math.min(st.size, ROLLOUT_END_MAX);
    const buf = Buffer.alloc(length);
    let n = 0;
    while (n < length) {
      const r = fs.readSync(fd, buf, n, length - n, st.size - length + n);
      if (!r) break;
      n += r;
    }
    const text = buf.subarray(0, n).toString("utf8");
    return length < st.size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { fs.closeSync(fd); }
}
// The COUNT from a project home: with only the read size per file capped, 100,000 empty rollout-*.jsonl created by a
// process in the project container would cost every call of codexUsage (usage tab, about every 45 s) and
// codexRateLimitSnapshot ≈ 350 ms synchronously on the backend's main thread (readdir and lstat per file, BEFORE the
// filter). Therefore per project home: the tree NEWEST FIRST (sessions/YYYY/MM/DD descending, the names carry their
// time), at most ROLLOUT_ENTRIES_PER_HOME directory entries read (via opendir, not readdir: a folder with 100,000
// entries is only read up to the cap) and at most ROLLOUTS_PER_HOME matching files looked at (lstat). Above that one
// message per home (once per process). The backend's homes are read plainly.
export const ROLLOUTS_PER_HOME = 200;
export const ROLLOUT_ENTRIES_PER_HOME = 10_000;
const rolloutCapReported = new Set();
function rolloutCapReport(base) {
  if (rolloutCapReported.has(base)) return;
  rolloutCapReported.add(base);
  console.warn(`[codex] project home ${base}: more than ${ROLLOUTS_PER_HOME} rollouts or ${ROLLOUT_ENTRIES_PER_HOME} entries — only the newest are read (cap)`);
}
function rolloutFilesProject(base, matches, files, now) {
  let entries = 0;
  let viewed = 0;
  let capped = false;
  const read = (dir) => {
    const out = [];
    let d;
    try { d = fs.opendirSync(dir); } catch { return out; }
    try {
      for (let e = d.readSync(); e !== null; e = d.readSync()) {
        if (++entries > ROLLOUT_ENTRIES_PER_HOME) { capped = true; break; }
        out.push(e);
      }
    } catch { /* folder disappeared */ } finally { try { d.closeSync(); } catch { /* already closed */ } }
    return out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)); // newest first
  };
  const walk = (dir, depth) => {
    for (const e of read(dir)) {
      if (capped) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl") && matches(e.name)) {
        if (++viewed > ROLLOUTS_PER_HOME) { capped = true; return; }
        try {
          const m = fs.lstatSync(p).mtimeMs;
          if (m > now) continue;
          files.push({ p, m, project: true, name: e.name });
        } catch { /* does not matter */ }
      }
    }
  };
  walk(base, 0);
  if (capped) rolloutCapReport(base);
}
// The rollout files under the roots: `{ p, m, project, name }`. A project home via lstat (no link counts), without
// entries with mtime in the future and capped (rolloutFilesProject).
function rolloutFiles(roots, matches, matchesProject = matches) {
  const files = [];
  const now = Date.now() + FUTURE_SLACK_MS;
  for (const { base, project } of roots) {
    if (!fs.existsSync(base)) continue;
    if (project) { rolloutFilesProject(base, matchesProject, files, now); continue; }
    const walk = (dir, depth) => {
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 4) walk(p, depth + 1);
        else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl") && matches(e.name)) {
          try { files.push({ p, m: fs.statSync(p).mtimeMs, project: false, name: e.name }); } catch { /* does not matter */ }
        }
      }
    };
    walk(base, 0);
  }
  return files;
}

// The consumption of the LAST turn from the rollout file: the sum of the `last_token_usage` of all model calls since
// the last `task_started` — independent of whether `total_token_usage` counts over the thread (0.162.1, measured) or
// starts anew per process (0.153.1: a difference to the previous state would swallow every follow-up turn there except
// for the growth). A token_count line with an unchanged total is a repetition, not a call. Without `task_started`
// before the last line: null (the caller computes with the difference).
function turnFromRollout(lines, until) {
  const sum = { input: 0, output: 0, cached: 0 };
  let prior = null, start = -1;
  for (let i = until; i >= 0; i--) {
    if (!lines[i].includes('"task_started"')) continue;
    try { if (JSON.parse(lines[i])?.payload?.type === "task_started") { start = i; break; } } catch { /* not a line */ }
  }
  if (start < 0) return null;
  for (let i = start + 1; i <= until; i++) {
    if (!lines[i].includes('"last_token_usage"')) continue;
    let obj; try { obj = JSON.parse(lines[i]); } catch { continue; }
    const last = normalizedUsage(findLastUsage(obj)), total = normalizedUsage(findTotalUsage(obj));
    if (!last) continue;
    const state = total ? `${total.input}/${total.output}` : null;
    if (state && state === prior) continue;
    prior = state;
    sum.input += last.input; sum.output += last.output; sum.cached += Math.min(last.cached, last.input);
  }
  return sum.input + sum.output > 0 ? sum : null;
}

// The consumption of a thread SINCE a point in time: for the turn that ended without `turn.completed` (stopped, died —
// runChatCodex below) and for the late booking after a crash (runs/lateBooking.js). The sum of the `last_token_usage`
// of all token_count lines with `timestamp` ≥ `sinceMs`; a line with an unchanged total is a repetition (like
// turnFromRollout), one without a timestamp cannot be assigned to a point in time and does not count.
// → `{ input, output, cached, untilMs }` (`untilMs` = timestamp of the last counted line) or null.
export function codexConsumptionSince(threadId, sinceMs, codexHome = "") {
  try {
    if (!threadId || !Number.isFinite(sinceMs)) return null;
    const hits = rolloutFiles(codexSessionRoots(codexHome), (name) => name.includes(threadId));
    hits.sort((a, b) => b.m - a.m);
    const text = hits[0] ? rolloutText(hits[0].p, hits[0].project) : null;
    if (text === null) return null;
    const sum = { input: 0, output: 0, cached: 0, untilMs: 0 };
    let prior = null;
    for (const row of text.split("\n")) {
      if (!row.includes('"last_token_usage"')) continue;
      let obj; try { obj = JSON.parse(row); } catch { continue; }
      const last = normalizedUsage(findLastUsage(obj)), total = normalizedUsage(findTotalUsage(obj));
      if (!last) continue;
      const state = total ? `${total.input}/${total.output}` : null;
      const repetition = state !== null && state === prior;
      prior = state;
      const t = Date.parse(String(obj?.timestamp || ""));
      if (repetition || !Number.isFinite(t) || t < sinceMs) continue;
      sum.input += last.input; sum.output += last.output; sum.cached += Math.min(last.cached, last.input);
      sum.untilMs = Math.max(sum.untilMs, t);
    }
    return sum.input + sum.output > 0 ? sum : null;
  } catch { return null; }
}

// Read the last token snapshot of a thread from its rollout file. `codexHome` stays as a parameter (default: the real
// home).
export function readCodexTokenSnapshot(threadId, codexHome = "") {
  try {
    if (!threadId) return null;
    const hits = rolloutFiles(codexSessionRoots(codexHome), (name) => name.includes(threadId));
    hits.sort((a, b) => b.m - a.m);
    for (const { p, project } of hits) {
      const text = rolloutText(p, project);
      if (text === null) continue;
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"last_token_usage"') && !lines[i].includes('"total_token_usage"')) continue;
        let obj; try { obj = JSON.parse(lines[i]); } catch { continue; }
        const last = normalizedUsage(findLastUsage(obj));
        const total = normalizedUsage(findTotalUsage(obj));
        if (last || total) return { last, total, contextWindow: findContextWindow(obj), path: p, turn: turnFromRollout(lines, i) };
      }
    }
    return null;
  } catch { return null; }
}

// The CONSUMPTION of the turn — the second question next to the context, and a different number. The first source is
// the rollout file (`turnFromRollout`, both counting modes of the CLI); only without it: `turn.completed` is cumulative
// over the thread (see above, re-measured at 0.162.1), so the turn is the difference to the state before. If the new
// state lies BELOW the old one (a baseline that does not fit this thread, or a CLI that counts anew per process), it
// is the turn itself.
function turnConsumption(current, previous) {
  const cumulative = current.input >= (previous.input || 0) && current.output >= (previous.output || 0);
  const minus = (k) => (cumulative ? Math.max(0, current[k] - (previous[k] || 0)) : current[k]);
  const input = minus("input");
  return { input, cached: Math.min(minus("cached"), input), output: minus("output") };
}

// Kept pure so that the critical case stays testable: the sum of all model calls of an agent turn must never appear
// as the current context — and the last call never as the consumption of the turn (`consumption`: a workflow agent
// would otherwise count 4 tokens, the empty response after StructuredOutput).
export function resolveCodexTurnUsage(eventUsage, snapshot, previous = { input: 0, output: 0, cached: 0 }) {
  const current = normalizedUsage(eventUsage) || { input: 0, output: 0, cached: 0 };
  const consumption = snapshot?.turn || turnConsumption(current, previous);
  const last = snapshot?.last;
  if (last) {
    const input = Math.max(0, last.input);
    return {
      current,
      input,
      output: Math.max(0, last.output),
      cached: Math.min(Math.max(0, last.cached), input),
      source: "last_token_usage",
      consumption,
    };
  }
  const input = Math.max(0, current.input - (previous.input || 0));
  return {
    current,
    input,
    output: Math.max(0, current.output - (previous.output || 0)),
    cached: Math.min(Math.max(0, current.cached - (previous.cached || 0)), input),
    source: "cumulative_delta",
    consumption,
  };
}

// Cumulative state as the baseline for the fallback after a server/thread change.
function readCodexCumulative(threadId, codexHome = "") {
  return readCodexTokenSnapshot(threadId, codexHome)?.total || null;
}
// Which kind of limit struck? `rate_limit_reached_type` is one of primary | secondary | credits |
// spend_control_reached; in addition an empty credit pot or a set spend cap reveals the same without this field.
function reachedKind(rl) {
  const t = String(rl?.rate_limit_reached_type || "");
  if (t === "primary" || t === "secondary" || t === "credits") return t;
  if (t === "spend_control_reached" || rl?.spend_control_reached === true) return "spend";
  const c = rl?.credits;
  if (c && typeof c === "object" && c.unlimited !== true && c.has_credits === false && t) return "credits";
  return "";
}

// `projectHomes: false` (the fallback of the limit gate, runs/limit-gate.js): only the backend's homes; an invented
// limit state of one project then holds no chat of another. The display (/api/usage/codex) reads all.
export function codexUsage(codexHome = "", { projectHomes = true } = {}) {
  try {
    const roots = codexSessionRoots(codexHome).filter((r) => (projectHomes || !r.project) && fs.existsSync(r.base));
    if (!roots.length) return { connected: false };
    const files = rolloutFiles(roots, () => true);
    if (!files.length) return { connected: false };
    files.sort((a, b) => b.m - a.m);
    const norm = (w) => (w && typeof w === "object")
      ? {
          usedPercent: typeof w.used_percent === "number" ? w.used_percent : null,
          windowMinutes: typeof w.window_minutes === "number" ? w.window_minutes : null,
          resetsAt: typeof w.resets_at === "number" ? new Date(w.resets_at * 1000).toISOString() : null,
        }
      : null;
    // IMPORTANT: do not stop at the first `rate_limits` entry. The current Codex CLI writes snapshots in which
    // `primary`/`secondary` are null (e.g. when the limit runs via credits instead of time windows) — measured on a
    // real account: the newest rollout without windows, 16 of 18 older ones WITH windows. Stopping there shows no ring
    // at all although the utilisation is known. So keep searching until a snapshot with a window comes whose reset is
    // still in the FUTURE (an expired window says nothing anymore). The newest snapshot only serves as the fallback
    // for "logged in, but no window (yet)".
    const usable = (w) => w && typeof w.usedPercent === "number";
    const stillOpen = (w) => !w?.resetsAt || Date.parse(w.resetsAt) > Date.now();
    let newest = null;
    for (const { p, project } of files.slice(0, 12)) {
      let txt; try { txt = rolloutText(p, project); } catch { continue; }
      if (txt === null || !txt.includes('"rate_limits"')) continue;
      const lines = txt.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        let obj; try { obj = JSON.parse(lines[i]); } catch { continue; }
        const rl = findRateLimits(obj);
        if (!rl) continue;
        const reached = reachedKind(rl);
        const snapshot = {
          connected: true,
          primary: norm(rl.primary),
          secondary: norm(rl.secondary),
          planType: rl.plan_type || newest?.planType || "",
          // Which kind struck — the display needs that because an exhausted window does not necessarily bring a
          // percentage along.
          reachedType: reached,
        };
        // EXACTLY AT THE LIMIT the CLI tends to write the exhausted window as null. Without this addition the loop
        // keeps searching, finds an old state at best — and the display shows nothing or something stale although
        // 100 % is reached.
        if ((reached === "primary" || reached === "secondary") && !usable(snapshot[reached])) {
          snapshot[reached] = { usedPercent: 100, windowMinutes: snapshot[reached]?.windowMinutes ?? null, resetsAt: snapshot[reached]?.resetsAt ?? null };
        }
        const primaryOk = usable(snapshot.primary) && stillOpen(snapshot.primary);
        const secondaryOk = usable(snapshot.secondary) && stillOpen(snapshot.secondary);
        if (primaryOk || secondaryOk) {
          if (!primaryOk) snapshot.primary = null;
          if (!secondaryOk) snapshot.secondary = null;
          return snapshot;
        }
        // Credits/spend cap reached: there is no time window that could be shown — still it is the most important
        // state of all and must reach the caller.
        if (reached === "credits" || reached === "spend") return { ...snapshot, primary: null, secondary: null };
        // Fallback without expired windows: a window whose reset is over says nothing about today's utilisation —
        // then rather no ring than a wrong one.
        if (!newest) {
          newest = {
            ...snapshot,
            primary: stillOpen(snapshot.primary) ? snapshot.primary : null,
            secondary: stillOpen(snapshot.secondary) ? snapshot.secondary : null,
          };
        }
      }
    }
    return newest || { connected: true }; // logged in, but no snapshot (yet)
  } catch { return { connected: false }; }
}

// Read the RAW rate_limits snapshot — for the automatic continuation at the limit (limits.js). Unlike codexUsage()
// (display: only usable, still open windows) EVERYTHING stays here, in particular `rate_limit_reached_type` (primary |
// secondary | credits | spend_control_reached), `credits` and `spend_control_reached`. Exactly this field says WHICH
// kind of limit struck. Prefers the rollout file of the given thread (= the run that just failed), otherwise the
// newest of all.
export function codexRateLimitSnapshot({ threadId = "", codexHome = "" } = {}) {
  try {
    // From a project home only the rollout of the own thread (see rolloutText); from the backend all. The filter
    // already applies at listing: otherwise the own rollout would drop out of the newest ROLLOUTS_PER_HOME.
    const own = (name) => Boolean(threadId) && name.includes(threadId);
    const files = rolloutFiles(codexSessionRoots(codexHome), () => true, own)
      .map((f) => ({ ...f, mine: threadId ? f.name.includes(threadId) : false }))
      .filter((f) => !f.project || f.mine);
    if (!files.length) return null;
    // own thread first, then by modification time
    files.sort((a, b) => (b.mine - a.mine) || (b.m - a.m));
    for (const { p, project } of files.slice(0, 12)) {
      let txt; try { txt = rolloutText(p, project); } catch { continue; }
      if (txt === null || !txt.includes('"rate_limits"')) continue;
      const lines = txt.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        let obj; try { obj = JSON.parse(lines[i]); } catch { continue; }
        const rl = findRateLimits(obj);
        if (rl) return rl;
      }
    }
    return null;
  } catch { return null; }
}

// ── One-shot (runOnce counterpart) ────────────────────────────────────────────
// Uses `-o <file>` (the last agent response lands in the file). The read-only sandbox suffices for the prompt
// functions (classification/title read files at most).
// The arguments of a oneshot — factored out so that a guard checks them without a fake binary. The prompt is the last
// positional argument.
export function buildCodexOnceArgs({ prompt, outFile, model = "", effort = "", cwd = "", withoutTools = false, images = [] } = {}) {
  // `--json`: only the JSONL stream carries `turn.completed` with the consumption; the result still comes from the
  // file behind `-o` (the same flag as in the chat, buildCodexChatArgs).
  // `images` (caps.vision): file paths, each as `-i <file>` — the CLI attaches them as `input_image` to the first user
  // message (measured at 0.162.1). `-i` takes several values:
  // every path therefore stands before a flag, never before the prompt (otherwise the CLI would read the prompt as
  // another image path).
  const args = ["exec", "--json", "--skip-git-repo-check", ...CODEX_WITHOUT_DELEGATION, ...CODEX_WITHOUT_SELF_READ, "-s", "read-only",
    "-c", "approval_policy=\"never\"", ...(images || []).flatMap((b) => ["-i", String(b)]), "--color", "never", "-o", outFile];
  // `withoutTools` (runs/sandboxing.js): a sandboxed oneshot must not keep shell, view_image and the goal tools (in
  // the read-only sandbox the shell reads the whole file system of the process). The same cut as an outer-loop run
  // without a choice; apply_patch stays (rejected by the sandbox, see CODEX_WITHOUT_FILE_ACCESS). Every other oneshot
  // loses Codex's own goal and question tools (CODEX_WITHOUT_OWN_TOOLS) — exactly one of the two lists, never both.
  args.push(...codexToolCut(withoutTools));
  const m = resolveCodexModel(model);
  if (m) args.push("-m", m);
  // The level as a config value as in the chat — clamped to the RESOLVED id.
  const level = effort ? mapEffort(effort, m) : "";
  if (level) args.push("-c", `model_reasoning_effort=${JSON.stringify(level)}`);
  if (cwd) args.push("-C", cwd);
  args.push(prompt);
  return args;
}

// The images of a oneshot as files (`-i` only takes paths): its own throwaway folder per call (mkdtemp, 0700), the
// suffix from the MIME type. Without images no folder. → { folder, paths }.
const IMAGE_SUFFIX = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp" };
function imagesAsFiles(images) {
  const gut = (Array.isArray(images) ? images : []).filter((b) => b?.mime && b?.dataB64);
  if (!gut.length) return { folder: null, paths: [] };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-images-"));
  const paths = gut.map((b, i) => {
    const p = path.join(folder, `image-${i + 1}.${IMAGE_SUFFIX[String(b.mime).toLowerCase()] || "png"}`);
    fs.writeFileSync(p, Buffer.from(String(b.dataB64), "base64"), { mode: 0o600 });
    return p;
  });
  return { folder, paths };
}

// The consumption from a line of the `--json` stream of a oneshot (only `turn.completed`), otherwise null. At module
// level and not as an arrow function in runOnceCodex: the guard of the runtime writers assigns every write site to the
// function that begins last before it — an inner function before the cleanup of outFile would shift it.
function consumptionFromRow(row) {
  if (!row.includes("turn.completed")) return null;
  try { const ev = JSON.parse(row); return ev?.type === "turn.completed" ? normalizedUsage(ev.usage) : null; } catch { return null; /* partial line */ }
}

// The error from a line of the `--json` stream of a oneshot (`error` ⇒ `message`, `turn.failed` ⇒ `error.message`,
// fallback as in the chat connector below), otherwise null. With `--json` `codex exec` writes its errors — among them
// the limit wording "You've hit your usage limit" — ONLY as an event on stdout; stderr then merely says "Reading
// additional input from stdin..." (measured at 0.151). Without this reading nobody would recognize a limit of a
// oneshot: verdicts would branch as failed instead of parking. Module level for the same reason as consumptionFromRow.
function errorFromRow(row) {
  if (!row.includes("error") && !row.includes("turn.failed")) return null;
  let ev;
  try { ev = JSON.parse(row); } catch { return null; /* partial line */ }
  if (ev?.type === "error") return String(ev.message || JSON.stringify(ev));
  if (ev?.type === "turn.failed") return String(ev.error?.message || (typeof ev.error === "string" ? ev.error : JSON.stringify(ev.error || ev)));
  return null;
}

// `instance`: a oneshot in the project container — the service detection — does NOT exist for Codex. Measured:
// `-s read-only` does not write but reads the whole file system, including `~/.claude-login` and `auth.json`; between
// "the shell reads everything" and "no file access" Codex has no reading path. With an instance the call therefore
// fails visibly instead of silently running in the backend (projects/scans.js asks the provider beforehand).
// `images` ([{ mime, dataB64 }] — Codex carries `caps.vision`): one file per image in the call's throwaway folder,
// passed as `-i` (buildCodexOnceArgs); the folder goes with the end of the process. Codex takes no documents
// (caps.documents).
export function runOnceCodex(prompt, { cwd, timeoutMs = 90_000, model, effort = "", provider = "codex", atConsumption, instance = null, withoutTools = false, images = [] } = {}) {
  if (instance) return Promise.reject(new Error(T("Detection in the project container only with Claude")));
  return new Promise((resolve, reject) => {
    const outFile = path.join(os.tmpdir(), `cbase-codex-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`);
    const { folder: imageFolder, paths: imageList } = imagesAsFiles(images);
    const args = buildCodexOnceArgs({ prompt, outFile, model, effort, cwd, withoutTools, images: imageList });
    const child = spawn(codexBin(), args, { cwd, env: cleanCodexEnv() });
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Timeout")); }, timeoutMs);
    closeStdin(child);
    // The stream (`--json`) is only searched for `turn.completed` — the result comes from outFile. A oneshot is a
    // FRESH thread with one turn: the cumulative state (header of this file, `codexCum`) IS the consumption of this
    // call here; `cached_input_tokens` is a subset of `input_tokens`, so already the contract "input including cache".
    // Error events of the same stream are collected in `streamError` (errorFromRow) — they stand BEFORE the stderr
    // rest in the rejection.
    let stream = "";
    let consumption = null;
    let streamError = "";
    child.stdout.on("data", (d) => {
      stream += d;
      let i;
      while ((i = stream.indexOf("\n")) >= 0) {
        const row = stream.slice(0, i);
        consumption = consumptionFromRow(row) || consumption;
        const f = errorFromRow(row);
        if (f) streamError += f + "\n";
        stream = stream.slice(i + 1);
      }
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      let text = "";
      try { text = fs.readFileSync(outFile, "utf8"); } catch {}
      try { fs.unlinkSync(outFile); } catch {}
      if (imageFolder) { try { fs.rmSync(imageFolder, { recursive: true, force: true }); } catch {} }
      if (stream) { consumption = consumptionFromRow(stream) || consumption; const f = errorFromRow(stream); if (f) streamError += f + "\n"; }
      if (consumption) reportConsumption(atConsumption, { provider: provider || "codex", model: resolveCodexModel(model) || model || "", ...consumption });
      if (code !== 0 && !text) return reject(new Error((streamError.slice(-500) + err.slice(-500)).slice(0, 500) || `exit ${code}`));
      resolve(String(text || "").trim());
    });
  });
}

// ── MCP servers as `-c` overrides (Codex configures MCP via config.toml) ────────
// Environment names of the cbase server whose VALUE must never be in the argv: the instance token. Codex only gets the
// NAME (`env_vars`) and passes the value from its OWN environment to the server — the value comes into the environment
// of the Codex process via `mcpSecretEnvironment` (runChatCodex) and from there as `-e NAME` without `=` into the
// project container (runtime/inProject.js). Measured at 0.153.1 and 0.162.1
// with a real stdio server: with `env_vars` the value arrives, WITHOUT it a stdio server does
// NOT inherit Codex's environment. Without a token the argv stays byte-identical.
// Plus every entry of the coding MCP airlock: the wrapper carries the run token `CBASE_AIRLOCK` and, in the project
// container, the instance token — both only as names in the argv. All wrappers of a run carry the same values, one
// name in Codex's environment suffices.
export const MCP_SECRET_ENVIRONMENT = Object.freeze(["CBASE_TOKEN"]);
export const AIRLOCK_SECRET_ENVIRONMENT = Object.freeze(["CBASE_AIRLOCK", "CBASE_TOKEN"]);
const secretNames = (name, env) => (name === "cbase" ? MCP_SECRET_ENVIRONMENT : env?.CBASE_AIRLOCK !== undefined ? AIRLOCK_SECRET_ENVIRONMENT : [])
  .filter((k) => env[k] !== undefined && env[k] !== "");

// The headers of an HTTP/SSE server (`headers`, e.g. `Authorization: Bearer …` of an external server): passing only
// the URL would drop the header, the call would go out unauthenticated (401) while the tool is offered. Codex knows
// `env_http_headers = { "<header>" = "<ENV>" }`: the VALUE is in the environment of the Codex process, never in the
// argv (ps shows the argv to every process of the same machine). Measured at 0.153.1 and 0.162.1: URL only ⇒ no
// request arrives at the server with the header; `env_http_headers` ⇒ all do, the argv does not carry the token. The
// name is unique per server and header: CBASE_MCP_HEADER_<n>_<server>_<header>, non-alnum ⇒ `_`.
const headerName = (server, header, i) => `CBASE_MCP_HEADER_${i}_${String(server).replace(/[^A-Za-z0-9]/g, "_")}_${String(header).replace(/[^A-Za-z0-9]/g, "_")}`.toUpperCase();
function headerRows(name, s) {
  const h = s && (s.type === "http" || s.type === "sse") && s.headers && typeof s.headers === "object" ? s.headers : null;
  if (!h) return [];
  return Object.entries(h).filter(([k, v]) => k && v !== undefined && v !== null && v !== "")
    .map(([k, v], i) => ({ header: String(k), env: headerName(name, k, i), value: String(v) }));
}

/** The secret values of the server list (the cbase server's token, the headers of the HTTP servers) — for the environment of the Codex process. */
export function mcpSecretEnvironment(mcpServers) {
  const env = mcpServers?.cbase?.env || {};
  const out = Object.fromEntries(secretNames("cbase", env).map((k) => [k, String(env[k])]));
  for (const [name, s] of Object.entries(mcpServers || {})) {
    if (name !== "cbase") for (const k of secretNames(name, s?.env || {})) out[k] = String(s.env[k]);
    for (const z of headerRows(name, s)) out[z.env] = z.value;
  }
  return out;
}
// `inB`: the run has no instance — Codex starts in the backend. Then every stdio server gets what
// runtime/inProject.js gives every other start in the backend: (a) in server operation the git folder in front of the
// PATH (withGitWrapperFront — with the raw PATH a `git` of the server would bypass the project container) and (b) the
// backend's package caches as `env_vars` (bOwnInOps — only the NAMES, Codex passes the values from its environment;
// without them an npx/uvx server would not see them, measured at Codex 0.151.0, and load from the shared caches of
// the project containers). Without the server-operation mark and with an instance unchanged: there Codex does not
// carry the names anyway (inProject.js filters them).
function pushMcpConfig(args, mcpServers, { inB = true } = {}) {
  for (const [name, s] of Object.entries(mcpServers || {})) {
    if (!s) continue;
    if (s.type === "http" || s.type === "sse") {
      if (s.url) args.push("-c", `mcp_servers.${name}.url=${JSON.stringify(s.url)}`);
      const headers = headerRows(name, s);
      if (headers.length) args.push("-c", `mcp_servers.${name}.env_http_headers={ ${headers.map((z) => `${JSON.stringify(z.header)} = ${JSON.stringify(z.env)}`).join(", ")} }`);
    } else if (s.command) {
      args.push("-c", `mcp_servers.${name}.command=${JSON.stringify(s.command)}`);
      args.push("-c", `mcp_servers.${name}.args=[${(s.args || []).map((a) => JSON.stringify(String(a))).join(",")}]`);
      const env = { ...(s.env || {}) };
      // GUI apps have a minimal PATH; MCP servers (node via execPath, npx) need it.
      const filePath = env.PATH || process.env.PATH;
      if (filePath) env.PATH = inB ? withGitWrapperFront({ env: { PATH: filePath } }).env.PATH : filePath;
      const secret = secretNames(name, env);
      for (const k of secret) delete env[k];
      for (const [k, v] of Object.entries(env)) args.push("-c", `mcp_servers.${name}.env.${k}=${JSON.stringify(String(v))}`);
      const caches = inB ? bOwnInOps().filter((k) => !(k in env)) : [];
      const further = [...secret, ...caches];
      if (further.length) args.push("-c", `mcp_servers.${name}.env_vars=[${further.map((k) => JSON.stringify(k)).join(",")}]`);
    }
    // Time limit of a tool call (Claude config field `timeout` in ms → Codex `tool_timeout_sec`). Without it a longer
    // call of the native agent tool aborts while the subagent is still working.
    const t = Number(s.timeout);
    if (t >= 1000) args.push("-c", `mcp_servers.${name}.tool_timeout_sec=${Math.round(t / 1000)}`);
    // Only individual tools of this server (the tool list of a subagent) — Codex knows `enabled_tools` per server for
    // that (measured at 0.153.1 and 0.162.1: only the named tools are
    // in ALL_TOOLS and callable, `[]` blocks the whole server); the Claude CLI cuts the same via allowedTools.
    if (Array.isArray(s.enabledTools)) args.push("-c", `mcp_servers.${name}.enabled_tools=[${s.enabledTools.map((w) => JSON.stringify(String(w))).join(",")}]`);
  }
}

// permissionMode → Codex sandbox/approval. Codex runs non-interactively and can NOT ask about individual tools like
// Claude (permissionPrompt cap = false); the modes therefore map onto Codex sandbox levels. approval_policy ALWAYS
// stays "never", so that no run waits for a question that cannot be answered in cbase:
//   bypassPermissions / '' → danger-full-access (full access)
//   acceptEdits            → workspace-write   (auto-edit: files in the workspace writable)
//   plan | default         → read-only         (plan or "ask" conservatively as read-only)
function pushCodexSandbox(args, permissionMode) {
  const mode = String(permissionMode || "bypassPermissions");
  if (mode === "bypassPermissions") { args.push("--dangerously-bypass-approvals-and-sandbox"); return; }
  const sandbox = mode === "acceptEdits" ? "workspace-write" : "read-only";
  args.push("-s", sandbox, "-c", 'approval_policy="never"');
}

// Builds the Codex exec arguments from the provider-neutral run spec.
// exec flags MUST stand before the `resume` subcommand; the prompt is the last positional.
export function buildCodexChatArgs(spec) {
  const args = ["exec", "--json", "--skip-git-repo-check", ...CODEX_WITHOUT_DELEGATION, ...CODEX_WITHOUT_SELF_READ];
  // Codex's own goal and question tools are off in EVERY run (chat, resumption, subagent, workflow agent, outer loop —
  // CODEX_WITHOUT_OWN_TOOLS, header); a run without chosen built-ins (outer loop, `codexWithoutFileAccess`)
  // additionally without shell and view_image — the full cut CODEX_WITHOUT_FILE_ACCESS, which already contains both.
  args.push(...codexToolCut(spec.codexWithoutFileAccess));
  pushCodexSandbox(args, spec.permissionMode);
  args.push("--color", "never", "-C", spec.cwd);
  for (const d of spec.addDirs || []) args.push("--add-dir", d);
  const model = resolveCodexModel(spec.model);
  if (model) args.push("-m", model);
  // Raise the window above the CLI default (see CODEX_MODELS). The CLI clamps to its catalog maximum, so a value that
  // is too large is never an error.
  const win = codexContextWindow(model);
  if (win) args.push("-c", `model_context_window=${win}`);
  // The clamp needs the RESOLVED id (mapEffort only knows the catalog, not the aliases).
  const eff = mapEffort(spec.effort, model);
  if (eff) args.push("-c", `model_reasoning_effort=${JSON.stringify(eff)}`);
  pushMcpConfig(args, spec.mcpServers, { inB: !spec.instance });
  // Resume only without fork_pending (Codex cannot fork a session → fork = fresh thread).
  if (spec.sessionId && !spec.forkPending) args.push("resume", spec.sessionId);
  return args;
}

// The system prompt (Claude: --append-system-prompt) has no counterpart in Codex → prepend it to the prompt, together
// with the names of the run's MCP tools — and only if the thread does not already carry this revision
// (codex-prefix.js). The proof is the thread's rollout in the home of THIS run: in the project container the
// project's (its setup gives it CODEX_HOME = <runtime>/home/.codex), otherwise the backend's (CODEX_HOME of the
// backend, otherwise ~/.codex — the child inherits the environment, cleanCodexEnv). On resume Codex reads ONLY its own
// home (measured at 0.162.1: a rollout only in another home ⇒ exit 1 "no rollout found") — a rollout elsewhere proves
// nothing for this run. runs/session-location.js:sessionForStart fetches the session into this home before the spawn.
// Without the source of the project home: no proof.
function codexHomeOfTheRun(instance) {
  if (instance) {
    let home = null;
    try { home = codexHomeOfProject && instance.projectId ? codexHomeOfProject(String(instance.projectId)) : null; } catch { home = null; }
    return home ? { base: path.join(path.resolve(String(home)), "sessions"), project: true } : null;
  }
  return { base: path.join(path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")), "sessions"), project: false };
}
export function rolloutOfTheThread(threadId, instance = null) {
  if (!threadId) return null;
  const root = codexHomeOfTheRun(instance);
  if (!root) return null;
  try {
    const hits = rolloutFiles([root], (name) => name.includes(threadId));
    hits.sort((a, b) => b.m - a.m);
    return hits[0] ? { p: hits[0].p, project: hits[0].project } : null;
  } catch { return null; }
}

// The compaction by Codex: whether `codex exec --json` reports it in the event stream is not measured (a turn up to
// the compaction costs a whole context window; translate below only knows the items agent_message, reasoning,
// command_execution, mcp_tool_call, file_change and would pass over another). Reliably it is in the rollout —
// `{"type":"compacted",…}` (the replacement history) and
// `{"type":"event_msg","payload":{"type":"context_compacted"}}`, the same lines by which codex-prefix.js sees the
// prefix due again. After every turn process runChatCodex reads the GROWTH of the rollout since the start of this
// process (`ab` = the size before; the rollout only grows at the end) and reports a compaction as the same event as
// the Claude CLI (`system`/`compact_boundary`) — runs/do-run.js notes it for the next turn (runs/hints.js). Read at
// most COMPACTION_SCAN_MAX bytes from the end of the growth; a file from a project home via the descriptor path. What
// cannot be read reports nothing.
export const COMPACTION_SCAN_MAX = 32 * 1024 * 1024;
/** The size of a thread's rollout now (0: none) — the beginning of the growth for codexCompactedFrom. */
export function codexRolloutSize(threadId, instance = null) {
  const r = rolloutOfTheThread(threadId, instance);
  if (!r) return 0;
  try { return fs.statSync(r.p).size; } catch { return 0; }
}
/** Is there a compaction in a thread's rollout from byte `ab` on? */
export function codexCompactedFrom(threadId, instance = null, fromIdx = 0) {
  const r = rolloutOfTheThread(threadId, instance);
  if (!r) return false;
  let fd = null;
  try {
    fd = r.project ? openFromRuntimeFolder(r.p) : null;
    if (fd === null) fd = fs.openSync(r.p, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  } catch { return false; }
  try {
    const size = fs.fstatSync(fd).size;
    const beginning = Number(fromIdx) > 0 && Number(fromIdx) <= size ? Number(fromIdx) : 0; // got smaller: another rollout, read all
    const from = Math.max(beginning, size - COMPACTION_SCAN_MAX);
    const buf = Buffer.alloc(size - from);
    let n = 0;
    while (n < buf.length) { const k = fs.readSync(fd, buf, n, buf.length - n, from + n); if (!k) break; n += k; }
    for (const row of buf.subarray(0, n).toString("utf8").split("\n")) {
      if (!row.includes('"compacted"') && !row.includes('"context_compacted"')) continue;
      let j = null;
      try { j = JSON.parse(row); } catch { return true; } // cut off: when in doubt a compaction (like codex-prefix.js)
      if (j?.type === "compacted" || j?.payload?.type === "context_compacted") return true;
    }
    return false;
  } catch { return false; } finally { try { fs.closeSync(fd); } catch { /* already closed */ } }
}

function reasoningText(item) {
  if (typeof item.text === "string") return item.text;
  if (typeof item.summary === "string") return item.summary;
  if (Array.isArray(item.summary)) return item.summary.map((s) => (typeof s === "string" ? s : s?.text || "")).join("");
  if (Array.isArray(item.content)) return item.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("");
  return "";
}

// ── Chat run: Codex event stream → Claude-shaped events ─────────────────────────
export function runChatCodex({ spec, onEvent, onSpawn }) {
  return new Promise((resolve) => {
    // Environment of the child process: the real ~/.codex (skills come via `cbase_skill`) — the rest of the
    // environment is cleaned. Plus the secret values of the cbase server: Codex passes them on via `env_vars`
    // (pushMcpConfig).
    const cenv = { ...cleanCodexEnv(), ...mcpSecretEnvironment(spec.mcpServers) };

    let stderr = "";
    let sessionId = spec.sessionId || null;
    let currentChild = null;
    let currentTurnTexts = [];
    let lastResultText = null;
    let sawText = false;
    let genId = 0;
    let inputOpen = true;
    let busy = false;
    let aborted = false;
    let settled = false;
    let finalCode = 0;
    let pendingUsage = null;
    let turnBegin = 0; // for the consumption of a turn without turn.completed (codexConsumptionSince)
    let withoutBlockResumed = null; // the thread the first process was meant to resume WITHOUT the block (see startTurn)
    let rolloutPrior = { thread: null, size: 0 }; // the rollout before this turn process (codexCompactedFrom)

    const finish = (code = finalCode) => {
      if (settled) return;
      settled = true;
      // `errorText` empty: with Codex `resultText` is ALWAYS the model's text (the agent_message blocks of the turn),
      // and its errors — turn.failed, error — are on stderr. The limit detection (runs/auto-continue.js) reads this
      // field instead of `resultText`: a turn in which the model wrote about "429" and "rate" and then died would
      // otherwise park as "limit, reset unknown" and be repeated up to twelve times.
      resolve({ code, sessionId, resultText: lastResultText, errorText: "", stderr });
    };

    // `codex exec` is one process per prompt. The handle still keeps the logical cbase run open: an injection starts
    // `codex exec resume <thread>` and thus acts like Claude's open stream-json stdin, without creating a second chat
    // message outside this run.
    const handle = {
      kill: (signal = "SIGTERM") => {
        aborted = true;
        inputOpen = false;
        finalCode = 130;
        try { currentChild?.kill(signal); } catch {}
        if (!busy) finish(finalCode);
      },
      cbaseInject: (text) => {
        if (!inputOpen || busy || settled) return false;
        const prompt = String(text || "").trim();
        if (!prompt) return false;
        startTurn(prompt, false);
        return true;
      },
      cbaseEndInput: () => {
        if (!inputOpen) return;
        inputOpen = false;
        if (!busy) finish(finalCode);
      },
    };
    onSpawn?.(handle);

    // Assistant text block (persistence) + live stream delta (display) in one go.
    const emitText = (text) => {
      if (!text) return;
      currentTurnTexts.push(text);
      const prefix = sawText ? "\n\n" : "";
      sawText = true;
      onEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: prefix + text } } });
      onEvent({ type: "assistant", message: { content: [{ type: "text", text }] } });
    };
    const emitThinking = (text) => {
      if (!text) return;
      onEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: text } } });
      onEvent({ type: "assistant", message: { content: [{ type: "thinking", thinking: text }] } });
    };
    const emitToolUse = (id, name, input) =>
      onEvent({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: input || {} }] } });
    const emitToolResult = (id, content, isError) =>
      onEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: !!isError }] } });

    function translate(evt) {
      if (evt.type === "thread.started") {
        if (withoutBlockResumed && evt.thread_id && evt.thread_id !== withoutBlockResumed) {
          console.warn(`[codex] resumption of ${withoutBlockResumed} ran as a new thread ${evt.thread_id} — this turn without the defaults, the next one carries them`);
        }
        withoutBlockResumed = null;
        sessionId = evt.thread_id || sessionId;
        // Cumulative baseline for the per-turn difference: when resuming a thread that the current server run does not
        // know yet, take the last state from the rollout file (prevents a one-time overcount after a server restart
        // for existing threads).
        if (sessionId && !codexCum.has(sessionId)) {
          const seed = readCodexCumulative(sessionId);
          if (seed) codexCum.set(sessionId, seed);
        }
        onEvent({ type: "system", subtype: "init", session_id: sessionId });
        return;
      }
      if (evt.type === "turn.completed") {
        // Evaluate only at process end: then the token_count snapshot is certainly written completely to the rollout
        // file.
        pendingUsage = evt.usage || {};
        return;
      }
      if (evt.type === "turn.failed") {
        const msg = evt.error?.message || (typeof evt.error === "string" ? evt.error : JSON.stringify(evt.error || evt));
        stderr += String(msg) + "\n";
        return;
      }
      if (evt.type === "error") { stderr += String(evt.message || JSON.stringify(evt)) + "\n"; return; }
      if (evt.type !== "item.started" && evt.type !== "item.completed") return;
      const item = evt.item;
      if (!item) return;
      const started = evt.type === "item.started";
      const done = evt.type === "item.completed";
      const id = item.id || `codex-${genId++}`;

      switch (item.type) {
        case "agent_message":
          if (done) emitText(String(item.text || ""));
          return;
        case "reasoning":
          if (done) emitThinking(reasoningText(item));
          return;
        case "command_execution":
          if (started) emitToolUse(id, CODEX_TOOL_NAME.command_execution, { command: item.command || "", description: "" });
          else if (done) emitToolResult(id, String(item.aggregated_output ?? ""), (item.exit_code != null && item.exit_code !== 0) || item.status === "failed");
          return;
        case "mcp_tool_call":
          if (started) emitToolUse(id, mcpToolName(item.server, item.tool), item.arguments || {});
          else if (done) {
            const err = item.error ? (item.error.message || JSON.stringify(item.error)) : null;
            const content = err != null ? err : (item.result?.content ?? item.result?.structured_content ?? "");
            emitToolResult(id, content, err != null || item.status === "failed");
          }
          return;
        case "file_change": {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          if (started) emitToolUse(id, CODEX_TOOL_NAME.file_change, { file_path: changes[0]?.path || "", changes });
          else if (done) emitToolResult(id, changes.map((c) => `${c.kind || "change"} ${c.path}`).join("\n") || "changed", item.status === "failed");
          return;
        }
        default:
          // Show unknown item types (web_search, todo_list, …) generically as a tool.
          if (started) emitToolUse(id, item.type || "tool", clipObj(item));
          else if (done) emitToolResult(id, JSON.stringify(item).slice(0, 2000), item.status === "failed");
          return;
      }
    }

    function startTurn(input, firstTurn) {
      if (settled || aborted) return;
      busy = true;
      turnBegin = Date.now();
      currentTurnTexts = [];
      pendingUsage = null;
      let buf = "";
      let turnSettled = false;
      const turnSpec = {
        ...spec,
        sessionId: firstTurn ? spec.sessionId : sessionId,
        forkPending: firstTurn ? spec.forkPending : false,
      };
      const args = buildCodexChatArgs(turnSpec);
      // The block (defaults + tool names) at most with the first process of this logical run — and there only if the
      // thread is new (no resume, fork) or does not provably carry its revision (codex-prefix.js). Further
      // monitor/user turns resume the same thread and inherit it from the history.
      const resumed = turnSpec.sessionId && !turnSpec.forkPending ? turnSpec.sessionId : null;
      rolloutPrior = resumed ? { thread: resumed, size: codexRolloutSize(resumed, spec.instance || null) } : { thread: null, size: 0 };
      const inputValue = firstTurn ? codexInput(spec, input, { threadId: resumed, rollout: (id) => rolloutOfTheThread(id, spec.instance || null) }) : { text: input, sent: false };
      // Resumed without the block: if the CLI reports ANOTHER thread, this turn ran without the defaults (the next one
      // carries them — the revision is missing in the new thread). Only reported; a replacement would be a second
      // model call.
      withoutBlockResumed = firstTurn && inputValue.prefix && !inputValue.sent ? resumed : null;
      args.push(inputValue.text);
      let child;
      // `spec.instance`: every turn process of this run in the same instance; without it a plain start. With it the
      // LFS environment — its shell inherits it (Codex 0.153.1 and 0.162.1 do not strip KEY/TOKEN/SECRET;
      // runs/lfs-environment.js).
      // CPU saver: a background agent with the toggle on under `nice -n 10`.
      const [program, argv] = withNice(codexBin(), args, spec.saver === true);
      try { child = inProject(spec.instance || null, program, argv, withLfsEnvironment(spec.instance || null, { cwd: spec.cwd, env: cenv })); }
      catch (e) {
        busy = false;
        inputOpen = false;
        finalCode = -1;
        stderr += String(e?.message || e);
        finish(finalCode);
        return;
      }
      currentChild = child;
      closeStdin(child); // the prompt comes as an argument — close stdin right away
      child.stdout.on("data", (d) => {
        buf += d.toString();
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line || line[0] !== "{") continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          try { translate(evt); } catch {}
        }
      });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("error", (e) => {
        if (turnSettled) return;
        turnSettled = true;
        busy = false;
        inputOpen = false;
        finalCode = -1;
        stderr += String(e?.message || e);
        finish(finalCode);
      });
      child.on("close", (code) => {
        if (turnSettled) return;
        turnSettled = true;
        currentChild = null;
        busy = false;
        finalCode = aborted ? 130 : (code ?? 1);
        const resultText = currentTurnTexts.join("\n\n").trim() || null;
        lastResultText = resultText;
        if (finalCode !== 0) inputOpen = false;

        if (pendingUsage) {
          // Without a thread id no baseline: otherwise all chats of this process would share `"_"`.
          const prev = (sessionId && codexCum.get(sessionId)) || { input: 0, output: 0, cached: 0 };
          const snapshot = readCodexTokenSnapshot(sessionId);
          const usage = resolveCodexTurnUsage(pendingUsage, snapshot, prev);
          if (sessionId) codexCum.set(sessionId, usage.current);
          // input MINUS cached as "fresh", cached separately → the frontend sum yields input again (no double count).
          // Two statements, two events (usage-tally.js): the pair with `onlyContext` is the LAST model call, for the
          // context display; `consumption` is the whole turn, for counters, booking and the budget.
          onEvent({ type: "stream_event", event: { type: "message_start", onlyContext: true, message: { usage: { input_tokens: usage.input - usage.cached, cache_read_input_tokens: usage.cached, cache_creation_input_tokens: 0, output_tokens: 0 } } } });
          onEvent({ type: "stream_event", event: { type: "message_delta", onlyContext: true, usage: { output_tokens: usage.output } } });
          const v = usage.consumption;
          onEvent({ type: "stream_event", event: { type: "consumption", usage: { input_tokens: v.input - v.cached, cache_read_input_tokens: v.cached, cache_creation_input_tokens: 0, output_tokens: v.output } } });
          pendingUsage = null;
        } else if (sessionId && finalCode !== 0) {
          // Without turn.completed (stopped, died): the turn still consumed — from the rollout file from its beginning.
          const v = codexConsumptionSince(sessionId, turnBegin);
          if (v) onEvent({ type: "stream_event", event: { type: "consumption", usage: { input_tokens: v.input - v.cached, cache_read_input_tokens: v.cached, cache_creation_input_tokens: 0, output_tokens: v.output } } });
        }

        // Did Codex compact in this process? Reported BEFORE the result — there runs/do-run.js may already hand over
        // the next user turn, and it has to know.
        if (sessionId && codexCompactedFrom(sessionId, spec.instance || null, rolloutPrior.thread === sessionId ? rolloutPrior.size : 0)) {
          onEvent({ type: "system", subtype: "compact_boundary", session_id: sessionId, source: "codex" });
        }
        // As with Claude this is a TURN end, not necessarily the end of the cbase run. runs/do-run.js sets run_waiting
        // with open monitors; otherwise it ends the handle.
        onEvent({ type: "result", result: resultText ?? "", session_id: sessionId });
        if (!inputOpen) finish(finalCode);
      });
    }

    startTurn(spec.input, true);
  });
}

function clipObj(o) {
  try { const s = JSON.stringify(o); return s.length > 500 ? { preview: s.slice(0, 500) } : o; } catch { return {}; }
}
