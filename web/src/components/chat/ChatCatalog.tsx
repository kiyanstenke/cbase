import { API_BASE } from "@/lib/api";
import type { RunSummary } from "@/components/chat/chatBubbles";
import type { RightSidebarTab } from "@/lib/chat-bar";

// Native slash commands in the chat, interpreted client-side — ALWAYS, with or without an attachment. `claude -p`
// does know them: a "/goal …" that reaches the CLI sets ITS goal ("Goal set: …") in the CLI session, which cbase knows
// nothing about and which the next compaction discards. (A long pasted list after "/goal" counts as an attachment, and
// with an attachment the command used to pass through to the CLI.)
// /goal sets a chat goal, /compact compacts the context, /cost shows token usage, /help lists the commands.
// ONE source for FOUR uses: detection on send (`runSlash`), the blue highlight in the composer, the slash picker and
// the `/help` overview. The description stands exactly once; `/help` assembles name, argument and description into a
// Markdown line. A second list next to it would be the one that goes stale first — unnoticed.
type SlashCommand = { name: string; arg?: string; description: string };
const SLASH_COMMANDS: SlashCommand[] = [
  { name: "goal", arg: "<text>", description: "Set an overarching goal and send the text right away as the task. “/goal clear” removes the goal; without text: show the current one." },
  { name: "compact", description: "Compact the context: the history is summarized and the session restarted fresh." },
  { name: "clear", description: "Clear the previous context; the history remains visible and is dimmed." },
  { name: "model", arg: "<name>", description: "Switch this chat's model (across all connected providers). Without a value: show the available ones." },
  { name: "effort", arg: "<level|ultracode>", description: "Set the reasoning effort. Which levels apply depends on the model — `/effort` without an argument lists them." },
  { name: "mode", arg: "<full|auto|plan|ask>", description: "Set the permission mode (applies to all providers)." },
  { name: "browser", arg: "", description: "Shows how the agents' browser runs — always in the background (headless)." },
  { name: "cost", description: "Show this chat's token usage." },
  { name: "help", description: "This overview." },
];

// Alias names for /model → model id. Maps friendly shorthands to the real ids.
const MODEL_ALIAS: Record<string, string> = {
  // `opus` points to Opus 5.5 — like the CLI's alias, so `opus` means the same in cbase and in Claude Code; Opus 5 stays under `opus5`.
  standard: "", default: "", opus: "claude-opus-5-5", "opus5.5": "claude-opus-5-5", "opus5": "claude-opus-5",
  "opus4.8": "claude-opus-4-8",
  // `sonnet`/`haiku` point to the 5.5 models — like the CLI's aliases; the predecessors stay under `sonnet5`/`haiku4.5`.
  sonnet: "claude-sonnet-5-5", "sonnet5.5": "claude-sonnet-5-5", "sonnet5": "claude-sonnet-5", haiku: "claude-haiku-5-5",
  "haiku5.5": "claude-haiku-5-5", "haiku4.5": "claude-haiku-4-5-20251001",
  fable: "claude-fable-5-2", "fable5.2": "claude-fable-5-2", "fable5.1": "claude-fable-5-1", "fable5": "claude-fable-5",
  // Codex: one shorthand suffices, /model finds the other models by id or label ("gpt-6-sol").
  astra: "gpt-6-astra",
};
// Which provider an alias belongs to is told by its id — the alias table mixes both.
const aliasProvider = (id: string) => (/^(gpt-|codex-|o[0-9])/i.test(id) ? "codex" : "claude");
// Alias names for /mode → permission mode id (the German words are accepted user input).
const MODE_ALIAS: Record<string, string> = {
  voll: "bypassPermissions", vollzugriff: "bypassPermissions", full: "bypassPermissions",
  auto: "acceptEdits", "auto-edit": "acceptEdits", plan: "plan", fragen: "default", ask: "default",
};
// Short forms for /effort → level. Shorthands ONLY: the five levels themselves and `ultracode` (flips the switch) the
// command accepts anyway; whether the level applies to the model it checks afterwards like for any other word. The iOS
// counterpart is in `case "effort":` (ChatViewModel+Slash.swift) and is bound in web/test/list-binding.test.mjs.
const EFFORT_ALIAS: Record<string, string> = {
  mid: "medium", med: "medium", "x-high": "xhigh",
};

// Marker "do not show the provider-switch warning again" (user opt-out in the warning modal).
const PROVIDER_SWITCH_NOWARN = "cbase-provider-switch-nowarn";

// Known slash commands — derived, not copied (see SLASH_COMMANDS).
const SLASH_COMMANDSValue = SLASH_COMMANDS.map((b) => b.name);
const SLASH_RE = new RegExp(`^/(${SLASH_COMMANDSValue.join("|")})\\b\\s*([\\s\\S]*)$`, "i");
// Length of the leading "/command" token if the text (at the very start) looks like a command: exact match OR prefix
// of a known command (live glow already while typing "/go"). Paths like "/Users/…" do NOT glow (no command starts with
// "users") — 0 = no highlight. Hyphens may belong to future command names.
function slashCommandLen(text: string): number {
  const m = /^\/([a-zA-Z][a-zA-Z-]*)/.exec(text);
  if (!m) return 0;
  const w = m[1].toLowerCase();
  return SLASH_COMMANDSValue.some((c) => c === w || c.startsWith(w)) ? m[0].length : 0;
}
// Stricter than slashCommandLen: only EXACT commands (for persisted user bubbles, e.g. "/goal …").
function slashExactLen(text: string): number {
  const m = /^\/([a-zA-Z][a-zA-Z-]*)/.exec(text);
  return m && SLASH_COMMANDSValue.includes(m[1].toLowerCase()) ? m[0].length : 0;
}
// Render the leading "/command" glowing in accent blue (same look as the composer overlay).
function withSlashGlow(text: string, exact = true) {
  const n = exact ? slashExactLen(text) : slashCommandLen(text);
  if (!n) return text;
  return (
    <>
      <span style={{ color: "var(--color-accent)", textShadow: "0 0 9px var(--color-accent)" }}>{text.slice(0, n)}</span>
      {text.slice(n)}
    </>
  );
}

// `from` names the OWNER chat of a shared artifact (chat folder); without it the server reads in the open chat itself.
const artifactUrl = (chatId: string, artifactPath: string, inline = false, from?: string) =>
  `${API_BASE}/api/chats/${chatId}/artifacts/download?path=${encodeURIComponent(artifactPath)}${inline ? "&inline=1" : ""}${from && from !== chatId ? `&chatId=${encodeURIComponent(from)}` : ""}`;

// Title of a pasted text → file name of the artifact. Artifacts have no title field of their own; their path IS their
// name. Without an extension `.md` is appended (pasted text in this chat tool is practically always Markdown), folder
// paths stay allowed — the rest (control characters, "..", length) the server cleans up in sanitizeArtifactPath. The
// extension must start with a LETTER, otherwise "Note 12.8" counts as extensionless and gets `.md`.
// Same rule in the iOS app: artifactFileName(fromTitle:) in mobile/…/ChatView.swift.
const artifactNameFromTitle = (title: string) => {
  const clean = title.trim();
  return /\.[a-z][a-z0-9]{0,7}$/i.test(clean) ? clean : `${clean}.md`;
};
const RIGHT_SIDEBAR_TAB_KEY = "cbase-chat-right-sidebar-tab";
const RIGHT_SIDEBAR_OPEN_KEY = "cbase-chat-right-sidebar-open";
// `RightSidebarTab` comes from lib/chat-bar.ts (list, allow-list and shortcuts of the right bar in ONE place) and is only passed on below.

// Run display in the Claude Code style.
const STATUS_WORDS: { run: string; done: string }[] = [
  { run: "Tinkering", done: "Tinkered" },
  { run: "Forging", done: "Forged" },
  { run: "Mulling", done: "Mulled" },
  { run: "Weaving", done: "Woven" },
  { run: "Puzzling", done: "Puzzled" },
  { run: "Polishing", done: "Polishing" },
  { run: "Distilling", done: "Distilling" },
  { run: "Pondering", done: "Pondered" },
  { run: "Sorting", done: "Sorting" },
];

// Total run time of a workflow. A triggered run sometimes works for hours, hence a stage of its own for hours — nobody likes reading "74m 12s".
function fmtRunTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

const fmtTokens = (n: number) =>
  n >= 999_500 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "").replace(".", ",")}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
// Deterministic "done" verb from the metrics — identical live and after reload. The parser below already catches the
// compaction meta; the safety net here covers any other incomplete metrics line. A word is not worth a failed page.
const verbFor = (s?: RunSummary) => {
  const n = (Number(s?.secs) || 0) + (Number(s?.inTok) || 0) + (Number(s?.outTok) || 0);
  return STATUS_WORDS[Math.abs(Math.trunc(n)) % STATUS_WORDS.length].done;
};

// Selectable models in the composer ('' = default from profile/CLI) incl. context window — per provider.
// Claude: Fable 5.2/Fable 5.1/Fable 5/Opus 5.5/Opus 5/Opus 4.8/Sonnet 5.5/Sonnet 5/Haiku 5.5 = 1M, Haiku 4.5 = 200k. Codex: GPT-6.1 Sol, GPT-6 Astra/Sol/Luna, GPT-5.6 Sol/Terra/Luna = 872k (cap of the account catalog), gpt-5.4/-mini (API key only) = 272k.
//
// `efforts`: the MEASURED reasoning levels per model. The values are taken verbatim from
// `server/backend/electron/server/providers/connectors/codex.js` (`CODEX_MODELS`) and `…/claude.js` (`CLAUDE_MODELS`),
// where they are justified — not freely written. An EMPTY list (Haiku 4.5) means "no levels" (no picker), a missing one "unknown".
//
// Why this list carries the levels at all: the constants are the fallback until /api/providers has answered — and that
// answer waits on `codex login status` with a 15 s timeout. Without `efforts` here the picker would offer the old five
// levels during all that time, i.e. "max" even for models that reject it (HTTP 400). `web/test/composer-contract.test.mjs`
// holds the list against the server's — two places for the same measurement, but not two truths.
const CLAUDE_MODELS: { id: string; label: string; context: number; efforts?: string[] }[] = [
  { id: "claude-fable-5-2", label: "Fable 5.2", context: 1_000_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-fable-5-1", label: "Fable 5.1", context: 1_000_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-fable-5", label: "Fable 5", context: 1_000_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-opus-5-5", label: "Opus 5.5", context: 1_000_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-opus-5", label: "Opus 5", context: 1_000_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-opus-4-8", label: "Opus 4.8", context: 1_000_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", context: 1_000_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-sonnet-5", label: "Sonnet 5", context: 1_000_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", context: 1_000_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  // Haiku 4.5 carries NO levels (measured) — the empty list is a statement, not an absence.
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", context: 200_000, efforts: [] },
];
// Order like the server (priority of the account catalogue). gpt-5.5 is gone — stored values migrate on the server to
// gpt-6-sol (`account/model-migration.js`).
const CODEX_MODELS: { id: string; label: string; context: number; efforts?: string[] }[] = [
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", context: 872_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-astra", label: "GPT-6 Astra", context: 872_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-sol", label: "GPT-6 Sol", context: 872_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-luna", label: "GPT-6 Luna", context: 872_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", context: 872_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", context: 872_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", context: 872_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  // gpt-5.4/5.4-mini stay here: a key account runs them. They drop out of the /api/providers answer while the login
  // reports "chatgpt" — the server decides that alone, its marker never goes out, and no client checks it. The
  // fallback here does not know the account type and therefore shows both; it lives only until the first answer.
  { id: "gpt-5.4", label: "GPT-5.4", context: 272_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini", context: 272_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
];
// Models/context windows come primarily from /api/providers (single source, incl. third-party providers); the
// constants serve only as a fallback while the provider list is not yet loaded.
const modelsFor = (provider: string, list: { id: string; models: { id: string; label: string; context: number }[] }[] = []) =>
  list.find((p) => p.id === provider)?.models || (provider === "codex" ? CODEX_MODELS : CLAUDE_MODELS);
const contextWindowFor = (model: string, provider: string, list: { id: string; models: { id: string; label: string; context: number }[] }[] = []) =>
  modelsFor(provider, list).find((m) => m.id === model)?.context ?? (provider === "codex" ? 272_000 : 1_000_000);
// Label of a model — with the constants fallback as a SECOND stage, not only as a fallback for the still-empty list.
// `/api/providers` omits the models the signed-in account cannot run (gpt-5.4 and gpt-5.4-mini need an API key); a
// chat sitting on one of them would otherwise show its raw id ("gpt-5.4" instead of "GPT-5.4"). The id remains the
// last stage: nothing is invented for a model that neither the server nor the table knows.
const modelLabelFor = (provider: string, model: string, list: { id: string; models: { id: string; label: string; context: number }[] }[] = []) =>
  model
    ? (modelsFor(provider, list).find((m) => m.id === model)?.label ?? modelsFor(provider, []).find((m) => m.id === model)?.label ?? model)
    : "";
// Fallback for the default model per provider while /api/providers is not yet loaded (the backend delivers the value
// chosen in the settings as providerMeta.defaultModel). Copy of providers/index.js DEFAULT_MODEL_FALLBACK — bound in web/test/list-binding.test.mjs.
const DEFAULT_MODEL_FALLBACK: Record<string, string> = { claude: "claude-sonnet-5-5", codex: "gpt-5.6-sol" };

// Provider metadata (from /api/providers): only CONNECTED ones appear in the model picker.
// defaultModel = the default model of this provider chosen in the settings.
// efforts = the MEASURED reasoning levels of this model; if missing, the five default levels apply. The effort choice
// reads it via `lib/effort.ts` — so no level list stands here, it would sit next to one the backend measures.
// caps = the provider's capabilities; `caps.effort` is read (off ⇒ no effort picker, see `effortWithoutSelection` in
// lib/effort.ts). Optional: the fallback before the fetch does not carry it.
type ProviderMeta = { id: string; label: string; connected: boolean; models: { id: string; label: string; context: number; efforts?: string[] }[]; authMethod?: string; defaultModel?: string; defaultEffort?: string; caps?: { effort?: boolean } };

// Permission modes per chat (chat level; profiles no longer carry permissions). Default full access.
// codexHint: Codex runs non-interactively → the modes act via the Codex sandbox instead of interactive prompts (see
// pushCodexSandbox in providers/codex.js). For Codex the picker shows these more honest hints; "Ask" is conservatively read-only there.
const PERM_MODES: { id: string; label: string; hint: string; codexHint?: string }[] = [
  { id: "bypassPermissions", label: "Full access", hint: "Bypass all permissions — use with care", codexHint: "Codex: full access (danger-full-access) — use with care" },
  { id: "acceptEdits", label: "Auto-edit", hint: "File changes automatically; ask in the chat for shell/network", codexHint: "Codex: files writable in workspace (workspace-write), no prompts" },
  { id: "plan", label: "Plan", hint: "Read & plan only — no changes", codexHint: "Codex: read & plan only (read-only) — no changes" },
  { id: "default", label: "Ask", hint: "Ask in the chat for every sensitive tool (allow/deny)", codexHint: "Codex cannot prompt interactively → conservatively read-only" },
];


// Sort orders of the chat list. `label` and `hint` are i18n keys (English text).
const SORTINGS = [
  { key: "recent", label: "Recently active", hint: "Newest conversations first, pinned on top" },
  { key: "project", label: "By project", hint: "Grouped by project, unassigned last" },
] as const;

// Time-dependent greeting in the empty chat.
function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return "Good morning";
  if (h >= 11 && h < 18) return "Good afternoon";
  return "Good evening";
}

export { CLAUDE_MODELS, CODEX_MODELS, DEFAULT_MODEL_FALLBACK, EFFORT_ALIAS, MODEL_ALIAS, MODE_ALIAS, PERM_MODES, PROVIDER_SWITCH_NOWARN, RIGHT_SIDEBAR_OPEN_KEY, RIGHT_SIDEBAR_TAB_KEY, SLASH_COMMANDS, SLASH_RE, SORTINGS, STATUS_WORDS, aliasProvider, artifactNameFromTitle, artifactUrl, contextWindowFor, fmtRunTime, fmtTokens, greeting, modelLabelFor, modelsFor, verbFor, withSlashGlow };
export type { ProviderMeta, RightSidebarTab };
