// cbase's LLM prompt functions (context classification, curator, title, compact). They are PROVIDER-INDEPENDENT: the CLI primitives
// runOnce/runChat/cleanClaudeEnv come from the provider registry (Claude OR OpenAI Codex, depending on the app setting).
// Auth runs per provider through its login (Claude: `claude auth login`; Codex: `codex login`).
import crypto from "node:crypto";

import { cleanClaudeEnv, canVision, materialCapabilities, runOnce } from "./providers/index.js";
import * as baseline from "./runs/compaction-baseline.js";
import { sandboxed } from "./runs/sandboxing.js";
import { onceBooking } from "./runs/booking.js";
import { T } from "./i18n.js";

export { cleanClaudeEnv, canVision, materialCapabilities, runOnce };

// The EFFORT grade: besides `model` every function here takes an `effort` (the app agent's grade, "" = default) and passes it to
// runOnce, where it is resolved and clamped to the model. Callers pass both from `agentRunFor(<key>)` (settings/agent-models.js).
//
// SANDBOXED: every function here except `scanServices` runs through runs/sandboxing.js: empty working directory (DIRS.empty) and
// no tools. Their prompts carry everything they need (history, snippets, categories, project list, stock), and all of it is FOREIGN
// TEXT: a history with tool output, a pasted document, a web page. With tools in the chat's folder (or without `cwd` in the server's,
// `/home/agent` with the DB and `~/.claude`) an injected instruction could have files read, and the answer lands as a summary,
// context entry or suggestion in later prompts. So they have no `cwd` parameter any more. `scanServices` reads the project
// DELIBERATELY (Read/Glob/Grep, `onlyRead`), the named exception in the guard server/backend/test/oneshot-sandboxing.test.js.

// Compresses a chat history into a summary with which the conversation continues in a fresh session, modelled on Claude Code
// (runs/compaction-baseline.js, measured on the pinned binary). The WHOLE conversation since the last boundary (`messages`, neutral
// like providers/transcript.js) goes in, truncated beforehand to the compaction model's window (`window`, tokens; 0 = unknown, no
// pre-truncation), and on "Prompt is too long" like the original: the oldest API rounds drop out (the gap from the message, else
// 20%), at most PTL_ATTEMPTS times.
// `instruction`: /compact <instruction> (the original: customInstructions -> "Additional Instructions").
// `chatId` and `overruled` pass through to runOnce: the start gate at the spawn layer checks the compaction on its own, unless the
// human explicitly released it with "Start anyway" (`overruled`).
// Sandboxed (see above): the history carries tool output and pasted text, which is foreign text, and the result goes into every
// following turn.
// `transcript` (a finished text) stays for callers without messages (tests of the grade pass-through): it counts as ONE message.
// Returns: `{ text, truncated, attempts }`; `text` raw (the caller formats), `truncated`: older rounds dropped out.
export async function compactConversation({ messages = null, transcript = "", instruction = "", window = 0, model, effort = "", provider, chatId = "", overruled = false } = {}) {
  const list = Array.isArray(messages) ? messages : [{ role: "user", content: String(transcript || "") }];
  const nonce = crypto.randomBytes(3).toString("hex");
  const size = (g) => baseline.estimateTokens(baseline.groupAsText(g, nonce));
  let gs = baseline.groups(list);
  let truncated = false;
  // Beforehand to the window: cbase's section since the last boundary can be larger than any window (the CLI has already compacted in
  // it itself); the original never sends more than fitted its window. The same truncation as after the message.
  const limit = Number(window) > 0 ? Number(window) - baseline.OUTPUT_RESERVE - baseline.estimateTokens(baseline.compactionJob(instruction)) - 1_000 : 0;
  if (limit > 0) {
    for (let n = baseline.estimateTokens(baseline.historyAsText(gs, nonce)); n > limit;) {
      const fresh = baseline.truncate(gs, n - limit, size);
      if (!fresh) break;
      gs = fresh;
      truncated = true;
      n = baseline.estimateTokens(baseline.historyAsText(gs, nonce));
    }
  }
  // What REALLY is a timeout: both CLI connectors throw literally `new Error("Timeout")`, the API connectors abort through an
  // AbortController (`AbortError`, "The operation was aborted"). A timeout gets ONE second attempt: compaction is expensive to lose
  // and cheap to repeat.
  const isDeadline = (e) => e?.name === "AbortError"
    || /^timeout$/i.test(String(e?.message || "").trim())
    || /\baborted\b/i.test(String(e?.message || ""));
  let attempts = 0;
  for (;;) {
    const prompt = baseline.compactionRequest(baseline.historyAsText(gs, nonce), { instruction, nonce });
    // The deadline grows with the request: base 120 s plus 1 s per 1,000 characters, capped at 10 minutes.
    const deadline = Math.min(600_000, 120_000 + prompt.length);
    // Pass the provider explicitly: the summary is made with the chat's provider (whose model is guaranteed valid + connected), NOT
    // with the globally active one.
    const once = () => runOnce(prompt, { ...sandboxed(), timeoutMs: deadline, model, effort, provider, chatId, overruled, atConsumption: onceBooking("compaction", chatId) });
    try {
      let result;
      try { result = await once(); } catch (e) { if (!isDeadline(e)) throw e; result = await once(); }
      return { text: String(result || "").trim(), truncated, attempts };
    } catch (e) {
      if (!baseline.isPromptTooLong(e)) throw e;
      attempts += 1;
      const fresh = attempts <= baseline.PTL_ATTEMPTS ? baseline.truncate(gs, baseline.tokenGap(e), size) : null;
      if (!fresh) {
        throw Object.assign(new Error(T`The conversation is still too long for the compaction model's window after ${attempts - 1} truncations (${String(e?.message || e).slice(0, 200)}).`), { tooLong: true });
      }
      gs = fresh;
      truncated = true;
    }
  }
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("no JSON found");
  return JSON.parse(raw.slice(start, end + 1));
}

function extractJsonArray(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < 0) return [];
  return JSON.parse(raw.slice(start, end + 1));
}

// Classifies a text draft -> {category, title, summary, tags[]}. Sandboxed (see above).
export async function classifyContext(text, existingCategories = [], { model = "", effort = "" } = {}) {
  const catHint = existingCategories.length
    ? `Existing categories (reuse preferably, otherwise choose a new concise one): ${existingCategories.join(", ")}.`
    : "There are no categories yet; choose a concise one.";
  const prompt = [
    "You sort a pasted text snippet into a knowledge archive.",
    catHint,
    "Answer with NOTHING but a single JSON object in exactly this form:",
    '{"category": "short, 1-2 words", "title": "concise title", "summary": "1-2 sentences", "tags": ["keyword", "..."]}',
    "No explanation, no prose, no markdown around it.",
    "",
    "Text snippet:",
    '"""',
    text.slice(0, 12000),
    '"""',
  ].join("\n");

  try {
    const result = await runOnce(prompt, { ...sandboxed(), timeoutMs: 90_000, model, effort, atConsumption: onceBooking("context_categorize") });
    const obj = extractJson(result);
    return {
      category: String(obj.category || "Other").slice(0, 60).trim() || "Other",
      title: String(obj.title || "").slice(0, 200).trim(),
      summary: String(obj.summary || "").slice(0, 600).trim(),
      tags: Array.isArray(obj.tags) ? obj.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12) : [],
    };
  } catch {
    // Fallback: file it unclassified instead of losing the draft.
    return {
      category: "Unsorted",
      title: text.trim().split("\n")[0].slice(0, 80),
      summary: "",
      tags: [],
    };
  }
}

// Project dumpster: sorts a pasted free text into the STRUCTURED project context. Chooses EXACTLY ONE fixed category slug and
// prepares title/summary/body (markdown)/tags. Unlike classifyContext (free workspace categories) restricted to the 10 project
// slugs. Sandboxed (see above).
export async function classifyProjectDump({ text, categories, model, effort = "" } = {}) {
  const cats = Array.isArray(categories) ? categories : [];
  const catList = cats.map((c) => `${c.slug} (${c.label})`).join(", ");
  const slugs = new Set(cats.map((c) => c.slug));
  const fallbackSlug = slugs.has("overview") ? "overview" : (cats[0]?.slug || "overview");
  const prompt = [
    "You sort a pasted text into the structured project context.",
    "Choose EXACTLY ONE category from this fixed list; return ONLY the slug: " + (catList || "overview"),
    "Produce: a concise title, a 1-2 sentence summary, the prepared content as markdown",
    "(the pasted text sensibly structured; invent NOTHING, omit nothing essential) and tags.",
    "Answer with NOTHING but ONE JSON object in exactly this form:",
    '{"category":"<slug>","title":"concise title","summary":"1-2 sentences","body":"# Title\\n\\n- …","tags":["keyword"]}',
    "No prose, no markdown around it.",
    "",
    "Pasted text:",
    '"""',
    String(text || "").slice(0, 12000),
    '"""',
  ].join("\n");
  try {
    const result = await runOnce(prompt, { ...sandboxed(), timeoutMs: 90_000, model, effort, atConsumption: onceBooking("project_categorize") });
    const obj = extractJson(result);
    return {
      category: slugs.has(obj.category) ? obj.category : fallbackSlug,
      title: String(obj.title || "").slice(0, 200).trim(),
      summary: String(obj.summary || "").slice(0, 600).trim(),
      body: String(obj.body || text || "").slice(0, 20000),
      tags: Array.isArray(obj.tags) ? obj.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12) : [],
    };
  } catch {
    // Fallback: file it unclassified under "Overview" instead of losing the draft.
    return { category: fallbackSlug, title: String(text || "").trim().split("\n")[0].slice(0, 80), summary: "", body: String(text || ""), tags: [] };
  }
}

// Dumpster (fully autonomous): merges NEWLY pasted knowledge into an EXISTING context entry (merge/update) instead of duplicating.
// The result is ONE coherent, current entry. Sandboxed (see above): stock and new text stand completely in the prompt.
export async function mergeProjectContext({ existing, incomingText, categories, model, effort = "" } = {}) {
  const cats = Array.isArray(categories) ? categories : [];
  const catList = cats.map((c) => `${c.slug} (${c.label})`).join(", ");
  const slugs = new Set(cats.map((c) => c.slug));
  const prompt = [
    "You merge NEWLY pasted knowledge into an EXISTING project context entry (merge/update).",
    "Goal: ONE coherent, CURRENT entry. Integrate the new without duplicating; replace outdated",
    "statements with the new ones; keep what is still valid; lose nothing essential; brief and clear.",
    "Category EXACTLY ONE of (slug only; as a rule keep the existing one): " + (catList || "overview"),
    "",
    "EXISTING entry:",
    `Category: ${existing?.category || ""}`,
    `Title: ${existing?.title || ""}`,
    "Content:",
    String(existing?.body || "").slice(0, 12000),
    "",
    "NEWLY pasted (raw; the update is in here):",
    '"""',
    String(incomingText || "").slice(0, 8000),
    '"""',
    "",
    "Answer with NOTHING but ONE JSON object in exactly this form:",
    '{"category":"<slug>","title":"concise title","summary":"1-2 sentences","body":"# Title\\n\\n- …","tags":["keyword"]}',
    "No prose, no markdown around it.",
  ].join("\n");
  const obj = extractJson(await runOnce(prompt, { ...sandboxed(), timeoutMs: 90_000, model, effort, atConsumption: onceBooking("project_merge") }));
  return {
    category: slugs.has(obj.category) ? obj.category : (existing?.category || cats[0]?.slug || "overview"),
    title: String(obj.title || existing?.title || "").slice(0, 200).trim(),
    summary: String(obj.summary || existing?.summary || "").slice(0, 600).trim(),
    body: String(obj.body || existing?.body || "").slice(0, 20000),
    tags: Array.isArray(obj.tags) ? obj.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12) : [],
  };
}

// Workspace dump routing: recognizes which project a pasted text belongs to.
// -> { decision: "project"|"none"|"unsure", projectId, candidates[], question, reason }. Sandboxed (see above): the project list with
// keywords stands in the prompt.
export async function routeDumpToProject({ text, projects = [], model, effort = "" } = {}) {
  const ids = new Set(projects.map((p) => p.id));
  const list = projects.map((p, i) => `${i + 1}. id=${p.id} · ${p.name}${p.hints ? ` — ${p.hints}` : ""}`).join("\n") || "(no Projects)";
  const prompt = [
    "You assign a pasted knowledge/note text to the FITTING project, or recognize that none fits or that it is unclear.",
    "",
    "PROJECTS in the workspace (id · name — keywords):",
    list,
    "",
    "PASTED TEXT:",
    '"""',
    String(text || "").slice(0, 8000),
    '"""',
    "",
    "Decide:",
    '- Text belongs UNAMBIGUOUSLY to exactly ONE project → decision "project" + its projectId.',
    '- Fits NO project (general / workspace-wide) → decision "none".',
    '- Ambiguous, several would come into question or too little to go on → decision "unsure" + candidates (project ids) + a short German follow-up question (question).',
    'When in doubt, prefer "unsure" over a wrong assignment.',
    "",
    "Answer with NOTHING but ONE JSON object:",
    '{"decision":"project|none|unsure","projectId":"<id or null>","candidates":["<id>"],"question":"…","reason":"short"}',
  ].join("\n");
  try {
    const obj = extractJson(await runOnce(prompt, { ...sandboxed(), timeoutMs: 90_000, model, effort, atConsumption: onceBooking("project_assign") }));
    let decision = ["project", "none", "unsure"].includes(obj.decision) ? obj.decision : "unsure";
    const projectId = ids.has(obj.projectId) ? obj.projectId : null;
    const candidates = Array.isArray(obj.candidates) ? [...new Set(obj.candidates.filter((c) => ids.has(c)))] : [];
    if (decision === "project" && !projectId) decision = "unsure"; // claimed project does not exist -> ask back
    return {
      decision,
      projectId,
      candidates: candidates.length ? candidates : (projectId ? [projectId] : []),
      question: String(obj.question || "").slice(0, 400).trim(),
      reason: String(obj.reason || "").slice(0, 400).trim(),
    };
  } catch {
    return { decision: "none", projectId: null, candidates: [], question: "", reason: T("Routing failed") };
  }
}

// Service scan: an AI agent examines the project folder (cwd) and inventories the stack: backends, frontends, databases, caches,
// queues, workers, including port, technology and start command. Returns validated service objects.
const SERVICE_KINDS = new Set(["backend", "frontend", "db", "cache", "queue", "worker", "infra", "other"]);

// The fields of a detected service row are FOREIGN TEXT: the model writes what it reads in the project, and that can be a secret from
// a `.env`. A field that looks like a credential is DISCARDED (not truncated: a cut-off token is still part of it), and
// `atDismissed` tells the caller, who writes a bell without values (projects/scans.js). The RAW value is checked, before
// truncating; otherwise a token that begins beyond the limit would slip through as a fragment.
//   Prefixes  `sk-ant-` (Anthropic), `ghp_` and `github_pat_` (GitHub), `glpat-` (GitLab), followed by a token character.
//   Chain     >= 40 characters from the base64 alphabet (also URL-safe: `-`, `_`) with upper case, lower case AND a digit; a chain
//             that begins with `/` is an absolute path, not one.
//   Path      a RELATIVE path-like chain (with `/`, without `+` and `=`, and with few changes of character kind: upper, lower, digit,
//             separator; share below PATH_SWITCH_MAX) is split at `/`, and only its parts go against the chain rule. `dir` is relative
//             to the project root (prompt below): a long monorepo path with a digit (`packages/CustomerPortal/apps/frontend-web2`,
//             42 characters) was otherwise discarded, the service started in the root, and a bell reported a secret that did not exist.
//             Measured: paths made of words change character kind at 0.29-0.37 of the transitions, random base64 chains with `/` at
//             0.40-0.88 (12,737 samples, one at 0.40); a token with `/` stays a chain that is discarded.
// Lengths: name 80, description 400, start command 1,000 characters.
const TOKEN_PREFIX = /(?:sk-ant-|ghp_|github_pat_|glpat-)[A-Za-z0-9_-]/;
const LONG_CHAIN = /[A-Za-z0-9+/=_-]{40,}/g;
const PATH_SWITCH_MAX = 0.38;
const mixed = (k) => /[A-Z]/.test(k) && /[a-z]/.test(k) && /[0-9]/.test(k);
const characterKind = (c) => (c >= "A" && c <= "Z" ? 1 : c >= "a" && c <= "z" ? 2 : c >= "0" && c <= "9" ? 3 : 4);
function switchShare(k) {
  let n = 0;
  for (let i = 1; i < k.length; i++) if (characterKind(k[i]) !== characterKind(k[i - 1])) n += 1;
  return k.length > 1 ? n / (k.length - 1) : 0;
}
const pathLike = (k) => k.includes("/") && !/[+=]/.test(k) && switchShare(k) < PATH_SWITCH_MAX;
export function looksLikeSecret(text) {
  const t = String(text ?? "");
  if (TOKEN_PREFIX.test(t)) return true;
  for (const k of t.match(LONG_CHAIN) || []) {
    if (k.startsWith("/") || !mixed(k)) continue;
    if (!pathLike(k)) return true;
    if (k.split("/").some((part) => part.length >= 40 && mixed(part))) return true;
  }
  return false;
}
export const SERVICE_FIELD_MAX = Object.freeze({ name: 80, container: 120, tech: 120, dir: 200, startCommand: 1000, description: 400 });

// NOT sandboxed, the named exception (server/backend/test/oneshot-sandboxing.test.js): the scan READS the project with Read/Glob/Grep
// in the working folder `cwd`, that is its job; hardened through `onlyRead` (see below) instead of an empty cwd.
// `instance`/`projectId`: the detection of a relocated project runs in the project container (runOnce -> runOnceClaude ->
// inProject) and asks its project's lock (start gate); without an instance in B as before. Always `onlyRead`: Read/Glob/Grep and the
// hardened environment (providers/connectors/claude.js DETECTION_ENVIRONMENT).
// `atDismissed({ seq, name, fields })`: per service the fields that looked like a secret (see above), without values.
export async function scanServices({ cwd, model, effort = "", instance = null, projectId = null, atDismissed = null }) {
  const prompt = [
    "You are a service scanner. Examine the project in the current working directory with your",
    "file tools (Glob/Read/Grep): package.json, docker-compose*, Dockerfile*, README*, .env*/.env.example,",
    "framework configs, monorepo subfolders (apps/, packages/, backend/, frontend/, services/ …).",
    "Inventory all SERVICES of the stack: backends/APIs, frontends, databases, caches, queues,",
    "workers and other infrastructure, i.e. everything that runs on its own.",
    "",
    "For every service determine:",
    "- name: concise name (e.g. \"API\", \"Web frontend\", \"Postgres\")",
    "- kind: backend | frontend | db | cache | queue | worker | infra | other",
    "- port: ONLY the port reachable from the HOST as a number, otherwise null. IMPORTANT with Docker Compose:",
    "  a port only counts if it is published through a ports mapping (\"4201:4201\" → 4201).",
    "  Container-INTERNAL ports (expose:, default ports without a ports mapping such as Redis 6379 or",
    "  Postgres 5432 without publishing) are NOT reachable from the host → port: null.",
    "  If a service publishes SEVERAL host ports, create a separate entry per port",
    "  (name including addition, e.g. \"API\" and \"API (Jupyter)\").",
    "- container: for Docker services the container name (container_name from the Compose file,",
    "  otherwise the Compose service name, e.g. \"redis\" or \"web\"); for native processes empty.",
    "- tech: technology/framework including version if recognizable (e.g. \"Next.js 15\", \"FastAPI\", \"Postgres 16\")",
    "- dir: subfolder relative to the project root (empty if root)",
    "- startCommand: how to start the service locally (e.g. \"npm run dev\", \"docker compose up db\").",
    "  ONLY the executable shell command itself, NO remarks such as \"(in folder/)\" or",
    "  \"; browser: http://…\" (the folder belongs in the field dir; the command is run 1:1).",
    "- description: 1 sentence on what the service does",
    "",
    "Answer with NOTHING but a JSON array in exactly this form (empty array if nothing is recognizable):",
    '[{"name":"...","kind":"backend","port":8000,"container":"","tech":"...","dir":"...","startCommand":"...","description":"..."}]',
    "No prose, no markdown around it, only the array.",
  ].join("\n");

  const result = await runOnce(prompt, { cwd, timeoutMs: 300_000, model, effort, onlyRead: true, instance, projectId, atConsumption: onceBooking("services") });
  const arr = extractJsonArray(result);
  const clean = [];
  (Array.isArray(arr) ? arr : []).forEach((s, i) => {
    if (!s || typeof s !== "object") return;
    const dismissed = [];
    const field = (key) => {
      const raw = String(s[key] || "");
      if (looksLikeSecret(raw)) { dismissed.push(key); return ""; }
      return raw.slice(0, SERVICE_FIELD_MAX[key]).trim();
    };
    const row = {
      name: field("name"),
      kind: SERVICE_KINDS.has(s.kind) ? s.kind : "other",
      port: Number.isInteger(s.port) && s.port >= 1 && s.port <= 65535 ? s.port : null,
      container: field("container"),
      tech: field("tech"),
      dir: field("dir"),
      startCommand: field("startCommand"),
      description: field("description"),
    };
    if (dismissed.length && typeof atDismissed === "function") {
      try { atDismissed({ seq: i + 1, name: row.name, fields: dismissed }); } catch { /* a message never topples the scan */ }
    }
    if (row.name) clean.push(row);
  });
  return clean.slice(0, 30); // safety limit
}

// Post-run curator: a smaller LLM analyses the last exchange + the existing project context and proposes targeted changes
// (create/update/delete). Applies NOTHING, only returns validated proposals. Conservative: empty when in doubt.
// `approval`: the curator is a follow-up of the turn it describes; doRun passes the turn's approval along, so the start gate does not
// ask again.
// Sandboxed (see above): the exchange is foreign text (the agent's answer carries tool output), the stock stands in the prompt.
export async function curateContext({ userText, assistantText, existing, categories, model, effort = "", chatId = "", approval = false }) {
  const catList = categories.map((c) => `${c.slug} (${c.label})`).join(", ");
  const existingList = existing.length
    ? existing.map((e) => `[${e.id}] (${e.category}) ${e.title}${e.summary ? " — " + e.summary : ""}`).join("\n")
    : "(no context yet)";
  const slugs = new Set(categories.map((c) => c.slug));

  const prompt = [
    "You are a curator for project-specific long-term knowledge. A larger LLM has just worked on a",
    "task in a chat. Your job: distill lastingly relevant project knowledge from the COMPLETED exchange",
    "and deliver it as change proposals for the context DB.",
    "",
    "Fixed categories (use only these slugs): " + catList,
    "",
    "Project context already stored (ID, category, title, summary):",
    existingList,
    "",
    "The exchange that has just completed:",
    "### User:",
    (userText || "").slice(0, 6000),
    "### Assistant:",
    (assistantText || "").slice(0, 12000),
    "",
    "Rules:",
    "- Only lastingly relevant FACTS/DECISIONS/FINDINGS that ease future work on the project.",
    "- NO intermediate steps, failed attempts, small talk or things that were discarded again in the exchange.",
    "- If a fitting entry already exists → 'update' with its id instead of creating a duplicate.",
    "- If existing knowledge is clearly superseded/done → propose 'delete' or 'update'.",
    "- When in doubt, PREFER proposing NOTHING. An empty array [] is a good, frequent answer.",
    "- Every proposal needs a short 'reason' (why it makes sense).",
    "",
    "Answer with NOTHING but a JSON array in exactly this form (empty array if nothing):",
    '[{"op":"create","category":"<slug>","title":"...","summary":"1 sentence","body":"# Markdown …","tags":["..."],"validAsOf":"","reason":"..."},',
    ' {"op":"update","id":<number>,"category":"<slug>","title":"...","summary":"...","body":"...","reason":"..."},',
    ' {"op":"delete","id":<number>,"reason":"..."}]',
    "No prose, no markdown around it, only the array.",
  ].join("\n");

  let result;
  try {
    result = await runOnce(prompt, { ...sandboxed(), timeoutMs: 120_000, model, effort, chatId, approval, atConsumption: onceBooking("context_maintain", chatId) });
  } catch {
    return [];
  }
  let arr;
  try { arr = extractJsonArray(result); } catch { return []; }
  if (!Array.isArray(arr)) return [];

  const existingIds = new Set(existing.map((e) => e.id));
  const clean = [];
  for (const s of arr) {
    if (!s || typeof s !== "object") continue;
    const op = s.op;
    if (op === "create") {
      if (!slugs.has(s.category)) continue;
      if (!String(s.title || "").trim() && !String(s.body || "").trim()) continue;
      clean.push({
        op, category: s.category, title: String(s.title || "").slice(0, 200).trim(),
        body: String(s.body || ""), summary: String(s.summary || "").slice(0, 600).trim(),
        tags: Array.isArray(s.tags) ? s.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12) : [],
        validAsOf: String(s.validAsOf || "").slice(0, 80).trim(), reason: String(s.reason || "").slice(0, 400).trim(),
      });
    } else if (op === "update") {
      const id = Number(s.id);
      if (!existingIds.has(id)) continue;
      if (s.category != null && !slugs.has(s.category)) continue;
      clean.push({
        op, targetId: id, category: s.category ?? "", title: String(s.title || "").slice(0, 200).trim(),
        body: s.body != null ? String(s.body) : "", summary: String(s.summary || "").slice(0, 600).trim(),
        tags: Array.isArray(s.tags) ? s.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12) : [],
        validAsOf: String(s.validAsOf || "").slice(0, 80).trim(), reason: String(s.reason || "").slice(0, 400).trim(),
      });
    } else if (op === "delete") {
      const id = Number(s.id);
      if (!existingIds.has(id)) continue;
      clean.push({ op, targetId: id, reason: String(s.reason || "").slice(0, 400).trim() });
    }
  }
  return clean.slice(0, 20); // safety limit
}

// (runChat now lives in the provider registry; runs/do-run.js imports it from there.)
