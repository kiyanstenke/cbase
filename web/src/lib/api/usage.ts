// Providers and usage (the lists of the contract `server/backend/electron/server/account/usage-contract.js` are the JSON shapes).
// Only openrouter/claude/codex work. The "Usage" page has five sub-pages, OpenRouter is a fixed provider with exactly one access
// (`/api/openrouter`), and every usage number comes from the four routes under `/api/usage/`; the server reads ONLY the database and
// the stored snapshots for them, never a live fetch.
//
// Leaf module (README there): imports only from lib/api/, with a `.js` ending. The contract lies OUTSIDE lib/api/ (on the server) and
// must not be imported here; the lists therefore stand here a second time, and `web/test/usage-binding.test.mjs` pins them to the
// contract (every exported list of the contract is mirrored here or named there as "server only"; the types are bound to the lists via
// `USAGE_TYPES_BOUND`).
//
// Empty is not unknown: every answer goes through a `norm*` function, and no default claims something the server did not say. A
// missing token count is `null` (never 0; "nothing used" would be a statement), a missing amount `null` (never "$0"), a missing
// `equivalentComplete`/`windowKnown` is NO (only whoever says so claims complete or the real window), an unknown provider or window
// `null`, and a credit with `known: false` carries NO number even if one came along. The labels per sub-page, window, origin and role
// are here too, as tables over exactly the contract's lists; a new role without a label is red in the binding test, not silently the
// raw identifier.
import { api } from "./core.js";

/** The ONLY providers, in the UI's order. */
export const PROVIDER = ["claude", "codex", "openrouter"] as const;
export type Provider = (typeof PROVIDER)[number];
/** The subscription providers: their consumption counts against a quota, not against money. */
export const SUBSCRIPTION_PROVIDER = ["claude", "codex"] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDER)[number];
/** The fixed identifier of OpenRouter (registry, `/api/providers`, `provider::model`). */
export const OPENROUTER_ID = "openrouter";

/** The key of the "Usage" page in the settings; jump to a sub-page: `usage:<subpage>` (`usageJump`). */
export const USAGE_PAGE = "usage";
export const USAGE_SUBPAGES = ["overview", "claude", "codex", "openrouter", "limit"] as const;
export type UsageSubpage = (typeof USAGE_SUBPAGES)[number];
/** The dynamic-workflows page (group "Behavior"), pulled out of "Usage". */
export const WORKFLOWS_PAGE = "workflows";

/** The windows per provider. The ring measures `session`/`week`; `30d` slides; OpenRouter knows only `30d` and `total`. */
export const SUBSCRIPTION_WINDOW = ["session", "week", "30d"] as const;
export const OPENROUTER_WINDOW = ["30d", "total"] as const;
export type UsageWindow = (typeof SUBSCRIPTION_WINDOW)[number] | (typeof OPENROUTER_WINDOW)[number];
/** Where an OpenRouter amount comes from; `null` = unknown (never 0). */
export const COST_ORIGIN = ["reported", "inquired", "estimated"] as const;
export type CostOrigin = (typeof COST_ORIGIN)[number];
/** The roles of the oneshot calls (`background[].role`). */
export const ONCE_ROLES = [
  "categorization", "extraction", "second_look", "compaction", "title", "target", "workflow_verdict", "adjust",
  "context_categorize", "project_categorize", "project_merge", "project_assign", "context_maintain", "services",
  "retrieval", "outer_loop",
] as const;
export type OnceRole = (typeof ONCE_ROLES)[number];

// ── The fields of the answers: `norm*` returns exactly these, in this order ──────────────────────────────────────────────
// `USAGE_CONSUMPTION_FIELDS` is called `CONSUMPTION_FIELDS` in the contract; the name is already taken in the facade `lib/api.ts`
// (administration.ts, the consumption of a user container); the binding test keeps the mapping in its table `MIRROR`.
export const USAGE_CONSUMPTION_FIELDS = [
  "provider", "window", "from", "until", "windowKnown", "sums", "models", "chats", "chatsAdditional", "background", "subagentsShare",
] as const;
export const SUMS_FIELDS = [
  "input", "output", "cacheRead", "cacheWrite", "cacheUnsplit", "runs",
  "equivalentUsd", "equivalentComplete", "partsUsd", "costUsd", "costOrigin",
] as const;
export const PARTS_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export const ORIGIN_TALLY_FIELDS = ["reported", "inquired", "estimated", "unknown"] as const;
export const MODEL_FIELDS = [
  "model", "input", "output", "cacheRead", "cacheWrite", "cacheUnsplit", "runs", "equivalentUsd", "costUsd", "priceKnown",
] as const;
export const CHAT_FIELDS = [
  "chatId", "title", "deleted", "input", "output", "cacheRead", "cacheWrite", "runs", "equivalentUsd", "costUsd",
] as const;
export const BACKGROUND_FIELDS = [
  "role", "input", "output", "cacheRead", "cacheWrite", "runs", "equivalentUsd", "costUsd",
] as const;
export const HISTORY_FIELDS = ["provider", "days", "offsetMin", "points"] as const;
export const POINT_FIELDS = ["day", "input", "output", "cacheRead", "cacheWrite", "equivalentUsd", "costUsd"] as const;
export const CLAUDE_LIMITS_FIELDS = ["measuredAt", "window"] as const;
export const LIMIT_WINDOW_FIELDS = ["id", "group", "area", "percent", "resetsAt"] as const;
export const CREDIT_FIELDS = ["known", "totalUsd", "consumedUsd", "restUsd", "keyLimitUsd", "keyRestUsd", "at"] as const;
/** GET /api/openrouter: the key itself never leaves the server. */
export const OPENROUTER_ACCESS_FIELDS = ["keySet", "onlyWithoutSaving", "noDataUsage"] as const;
/** PUT /api/openrouter: both switches MANDATORY; `apiKey` only when a new key is set (empty would be a 400). */
export const OPENROUTER_PUT_REQUIRED = ["onlyWithoutSaving", "noDataUsage"] as const;

// ── Labels (dictionary keys, translated at render time); iOS builds the same tables ──────────────────────────────
export const SUBPAGE_LABEL: Readonly<Record<UsageSubpage, string>> = {
  overview: "Overview", claude: "Claude", codex: "Codex", openrouter: "OpenRouter", limit: "At the limit",
};
/**
 * The window as the bar names it: `session`/`week` only while the server knows the real window (`windowKnown`); under "Current
 * window" it then says "since HH:MM" (from `from`). iOS builds the same words (Models/UsageModels.swift).
 */
export const WINDOW_LABEL: Readonly<Record<UsageWindow, string>> = {
  session: "Current window", week: "Current week", "30d": "30 days", total: "All time",
};
/** Without a snapshot the window slides over the same length; the bar then says exactly that. */
export const WINDOW_SLIDING_LABEL: Readonly<Record<"session" | "week", string>> = {
  session: "Last 5 hrs", week: "Last 7 days",
};
export const ORIGIN_LABEL: Readonly<Record<(typeof ORIGIN_TALLY_FIELDS)[number], string>> = {
  reported: "reported", inquired: "queried", estimated: "estimated", unknown: "unknown",
};
export const ONCE_ROLES_LABEL: Readonly<Record<OnceRole, string>> = {
  categorization: "Classification",
  extraction: "Extraction",
  second_look: "Second look",
  compaction: "Compaction",
  title: "Chat title",
  target: "Goal check",
  workflow_verdict: "Workflow verdict",
  adjust: "Adjust",
  context_categorize: "Classify context",
  project_categorize: "Classify project",
  project_merge: "Merge project context",
  project_assign: "Assign project",
  context_maintain: "Curate context",
  services: "Detect services",
  retrieval: "Summary on request",
  outer_loop: "Outer loop",
};
/** The sentence next to every equivalent: the number is an estimate, not a price anyone pays. */
export const EQUIVALENT_HINT = "Estimate at API list price — the subscription counts its quota itself.";

/** The windows a provider knows (the server answers 400 for another). */
export const windowOf = (provider: Provider): readonly UsageWindow[] => (provider === OPENROUTER_ID ? OPENROUTER_WINDOW : SUBSCRIPTION_WINDOW);
/** The jump to a sub-page of usage (`openSettings(usageJump("claude"))`). */
export const usageJump = (subpage: UsageSubpage): string => `${USAGE_PAGE}:${subpage}`;
export const isSubpage = (k: unknown): k is UsageSubpage => USAGE_SUBPAGES.includes(k as UsageSubpage);
/** The label of a role; an unknown one stands raw (the binding test ensures there is none). */
export const roleLabel = (role: string): string => (ONCE_ROLES.includes(role as OnceRole) ? ONCE_ROLES_LABEL[role as OnceRole] : role);

// ── Types ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The equivalent split up (USD per part; `null` = no price or not said). */
export type PartsUsd = { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null };
/** How many rows per origin (`unknown` = without an amount); per field `null` = not counted. */
export type OriginTally = { reported: number | null; inquired: number | null; estimated: number | null; unknown: number | null };
export type UsageSums = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** Cache of rows from before the split; the UI shows it only if > 0. */
  cacheUnsplit: number | null;
  runs: number | null;
  /** API list-price estimate (subscription providers); `null` for OpenRouter. */
  equivalentUsd: number | null;
  /** NO unless the server explicitly affirms it. */
  equivalentComplete: boolean;
  partsUsd: PartsUsd | null;
  /** OpenRouter only. */
  costUsd: number | null;
  costOrigin: OriginTally | null;
};
export type UsageModel = {
  model: string; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null;
  cacheUnsplit: number | null; runs: number | null; equivalentUsd: number | null; costUsd: number | null;
  /** NO without an explicit yes; then "Price unknown" stands instead of a number. */
  priceKnown: boolean;
};
export type UsageChat = {
  chatId: string; title: string; deleted: boolean; input: number | null; output: number | null; cacheRead: number | null;
  cacheWrite: number | null; runs: number | null; equivalentUsd: number | null; costUsd: number | null;
};
export type UsageBackground = {
  /** A role from ONCE_ROLES; a foreign one stays as text (the label then falls back to it). */
  role: string; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null;
  runs: number | null; equivalentUsd: number | null; costUsd: number | null;
};
export type UsageConsumption = {
  provider: Provider | null;
  window: UsageWindow | null;
  /** ms since epoch; `null` = not said. */
  from: number | null;
  until: number | null;
  /** Does the server know the real window (from the snapshot)? NO ⇒ sliding over the same length. */
  windowKnown: boolean;
  sums: UsageSums | null;
  models: UsageModel[];
  /** At most 25; `chatsAdditional` says how many are missing; never truncate silently. */
  chats: UsageChat[];
  chatsAdditional: number | null;
  background: UsageBackground[];
  /** Subagents' share of the output as a fraction 0…1; `null` = not said or no output. */
  subagentsShare: number | null;
};
export type HistoryPoint = {
  /** Calendar day in the client's time zone, as the server writes it (YYYY-MM-DD). */
  day: string; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null;
  equivalentUsd: number | null; costUsd: number | null;
};
export type UsageHistory = { provider: Provider | null; days: number | null; offsetMin: number | null; points: HistoryPoint[] };
export type LimitWindow = {
  /** As limits.js (session, weekly_all, weekly_opus, …). */
  id: string;
  group: string;
  /** Model name or "" for all. */
  area: string;
  percent: number | null;
  /** ms since epoch; `null` = no reset known. */
  resetsAt: number | null;
};
export type ClaudeLimits = { measuredAt: number | null; window: LimitWindow[] };
export type OpenRouterCredit = {
  /** NO ⇒ all numbers `null` (never 0). */
  known: boolean;
  totalUsd: number | null; consumedUsd: number | null; restUsd: number | null;
  keyLimitUsd: number | null; keyRestUsd: number | null;
  at: number | null;
};
/** Per field `null` = not said; a missing switch is neither on nor off. */
export type OpenRouterAccess = { keySet: boolean | null; onlyWithoutSaving: boolean | null; noDataUsage: boolean | null };
/** The body of PUT /api/openrouter: both switches ALWAYS, `apiKey` only with a new, non-empty key. */
export type OpenRouterPutRequired = { onlyWithoutSaving: boolean; noDataUsage: boolean };
export type OpenRouterBody = OpenRouterPutRequired & { apiKey?: string };

/** `true` if type `A` carries exactly the keys of list `L`; otherwise `false`, and the assignment below is a type error. */
type SameKeys<A, L extends readonly string[]> = [Exclude<keyof A, L[number]>, Exclude<L[number], keyof A>] extends [never, never] ? true : false;
/** Binds the types to the lists (exported so no "unused" check removes it). */
export const USAGE_TYPES_BOUND: [
  SameKeys<UsageConsumption, typeof USAGE_CONSUMPTION_FIELDS>,
  SameKeys<UsageSums, typeof SUMS_FIELDS>,
  SameKeys<PartsUsd, typeof PARTS_FIELDS>,
  SameKeys<OriginTally, typeof ORIGIN_TALLY_FIELDS>,
  SameKeys<UsageModel, typeof MODEL_FIELDS>,
  SameKeys<UsageChat, typeof CHAT_FIELDS>,
  SameKeys<UsageBackground, typeof BACKGROUND_FIELDS>,
  SameKeys<UsageHistory, typeof HISTORY_FIELDS>,
  SameKeys<HistoryPoint, typeof POINT_FIELDS>,
  SameKeys<ClaudeLimits, typeof CLAUDE_LIMITS_FIELDS>,
  SameKeys<LimitWindow, typeof LIMIT_WINDOW_FIELDS>,
  SameKeys<OpenRouterCredit, typeof CREDIT_FIELDS>,
  SameKeys<OpenRouterAccess, typeof OPENROUTER_ACCESS_FIELDS>,
  SameKeys<OpenRouterPutRequired, typeof OPENROUTER_PUT_REQUIRED>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true];

// ── Normalizers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const count = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const isTrue = (x: unknown): boolean => x === true;
const bool = (x: unknown): boolean | null => (typeof x === "boolean" ? x : null);
const one = <T extends string>(l: readonly T[], x: unknown): T | null => (l.includes(x as T) ? (x as T) : null);
/** A point in time as ms; the server may write ms or ISO; the unreadable is `null`. */
const time = (x: unknown): number | null => {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim()) { const ms = Date.parse(x); return Number.isFinite(ms) ? ms : null; }
  return null;
};
const tokens = (r: Record<string, unknown>) => ({
  input: count(r.input), output: count(r.output), cacheRead: count(r.cacheRead), cacheWrite: count(r.cacheWrite),
});

export function normParts(raw: unknown): PartsUsd | null {
  const r = obj(raw);
  if (!r) return null;
  return { input: count(r.input), output: count(r.output), cacheRead: count(r.cacheRead), cacheWrite: count(r.cacheWrite) };
}

export function normOrigin(raw: unknown): OriginTally | null {
  const r = obj(raw);
  if (!r) return null;
  return { reported: count(r.reported), inquired: count(r.inquired), estimated: count(r.estimated), unknown: count(r.unknown) };
}

export function normSums(raw: unknown): UsageSums | null {
  const r = obj(raw);
  if (!r) return null;
  return {
    ...tokens(r),
    cacheUnsplit: count(r.cacheUnsplit),
    runs: count(r.runs),
    equivalentUsd: count(r.equivalentUsd),
    equivalentComplete: isTrue(r.equivalentComplete),
    partsUsd: normParts(r.partsUsd),
    costUsd: count(r.costUsd),
    costOrigin: normOrigin(r.costOrigin),
  };
}

export function normModel(raw: unknown): UsageModel | null {
  const r = obj(raw);
  if (!r || typeof r.model !== "string") return null;
  const t = tokens(r);
  return {
    model: r.model, input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite,
    cacheUnsplit: count(r.cacheUnsplit), runs: count(r.runs), equivalentUsd: count(r.equivalentUsd), costUsd: count(r.costUsd),
    priceKnown: isTrue(r.priceKnown),
  };
}

export function normChat(raw: unknown): UsageChat | null {
  const r = obj(raw);
  if (!r || !str(r.chatId)) return null;
  const t = tokens(r);
  return {
    chatId: str(r.chatId), title: str(r.title), deleted: isTrue(r.deleted), input: t.input, output: t.output,
    cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, runs: count(r.runs), equivalentUsd: count(r.equivalentUsd), costUsd: count(r.costUsd),
  };
}

export function normBackground(raw: unknown): UsageBackground | null {
  const r = obj(raw);
  if (!r || !str(r.role)) return null;
  const t = tokens(r);
  return {
    role: str(r.role), input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite,
    runs: count(r.runs), equivalentUsd: count(r.equivalentUsd), costUsd: count(r.costUsd),
  };
}

const withoutNull = <T>(x: T | null): x is T => x !== null;

/** GET /api/usage/consumption. A window the provider does not know is `null`, like an unknown provider. */
export function normUsageConsumption(raw: unknown): UsageConsumption {
  const r = obj(raw) ?? {};
  const provider = one(PROVIDER, r.provider);
  const window = one<UsageWindow>(provider ? windowOf(provider) : [...SUBSCRIPTION_WINDOW, ...OPENROUTER_WINDOW], r.window);
  const share = count(r.subagentsShare);
  return {
    provider,
    window,
    from: time(r.from),
    until: time(r.until),
    windowKnown: isTrue(r.windowKnown),
    sums: normSums(r.sums),
    models: list(r.models).map(normModel).filter(withoutNull),
    chats: list(r.chats).map(normChat).filter(withoutNull),
    chatsAdditional: count(r.chatsAdditional),
    background: list(r.background).map(normBackground).filter(withoutNull),
    subagentsShare: share !== null && share >= 0 && share <= 1 ? share : null,
  };
}

export function normPoint(raw: unknown): HistoryPoint | null {
  const r = obj(raw);
  if (!r || !str(r.day)) return null;
  return { day: str(r.day), ...tokens(r), equivalentUsd: count(r.equivalentUsd), costUsd: count(r.costUsd) };
}

/** GET /api/usage/history: gapless, oldest first (as the server writes it; nothing is filled in here). */
export function normHistory(raw: unknown): UsageHistory {
  const r = obj(raw) ?? {};
  return { provider: one(PROVIDER, r.provider), days: count(r.days), offsetMin: count(r.offsetMin), points: list(r.points).map(normPoint).filter(withoutNull) };
}

export function normLimitWindow(raw: unknown): LimitWindow | null {
  const r = obj(raw);
  if (!r || !str(r.id)) return null;
  return { id: str(r.id), group: str(r.group), area: str(r.area), percent: count(r.percent), resetsAt: time(r.resetsAt) };
}

/** GET /api/usage/claude-limits: all windows of the last snapshot (not just the blocking one). */
export function normClaudeLimits(raw: unknown): ClaudeLimits {
  const r = obj(raw) ?? {};
  return { measuredAt: time(r.measuredAt), window: list(r.window).map(normLimitWindow).filter(withoutNull) };
}

/** GET /api/usage/openrouter-credit. `known: false` ⇒ no number, even if one came along. */
export function normOpenRouterCredit(raw: unknown): OpenRouterCredit {
  const r = obj(raw) ?? {};
  const known = isTrue(r.known);
  const z = (x: unknown) => (known ? count(x) : null);
  return {
    known,
    totalUsd: z(r.totalUsd), consumedUsd: z(r.consumedUsd), restUsd: z(r.restUsd),
    keyLimitUsd: z(r.keyLimitUsd), keyRestUsd: z(r.keyRestUsd),
    at: time(r.at),
  };
}

/** GET /api/openrouter. */
export function normOpenRouterAccess(raw: unknown): OpenRouterAccess {
  const r = obj(raw) ?? {};
  return { keySet: bool(r.keySet), onlyWithoutSaving: bool(r.onlyWithoutSaving), noDataUsage: bool(r.noDataUsage) };
}

// ── Prices per provider behind OpenRouter (GET /api/usage/openrouter-prices) ─────────────────────────────────────────────
// Per model the range per 1M tokens across the active providers and the price of the provider of the last answer; display only;
// `known: false` means "not retrievable".
export type PriceSpan = { inMin: number; inMax: number; outMin: number; outMax: number; endpoints: number };
export type ModelPrices = { provider: string; model: string; upstream: string; known: boolean; span: PriceSpan | null; last: PriceSpan | null };

function spanOf(v: unknown): PriceSpan | null {
  const s = obj(v);
  if (!s) return null;
  const n = [s.inMin, s.inMax, s.outMin, s.outMax];
  if (!n.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  return { inMin: s.inMin as number, inMax: s.inMax as number, outMin: s.outMin as number, outMax: s.outMax as number, endpoints: count(s.endpoints) ?? 0 };
}

/** The prices as a lookup table "<provider>::<model>" → prices. */
export function normOpenRouterPrices(raw: unknown): Record<string, ModelPrices> {
  const out: Record<string, ModelPrices> = {};
  for (const m of list(obj(raw)?.models).map((x) => obj(x) ?? {})) {
    const e: ModelPrices = {
      provider: str(m.provider), model: str(m.model), upstream: str(m.upstream), known: m.known === true,
      span: spanOf(m.span), last: spanOf(m.last),
    };
    if (e.provider) out[`${e.provider}::${e.model}`] = e;
  }
  return out;
}

// ── Routes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Minutes east of UTC (the server expects −840…840), for the history's calendar days. */
export const offsetMinNow = (): number => Math.max(-840, Math.min(840, -new Date().getTimezoneOffset()));

export async function loadConsumption(provider: Provider, window: UsageWindow): Promise<UsageConsumption> {
  const q = new URLSearchParams({ provider, window });
  return normUsageConsumption(await api<unknown>(`/api/usage/consumption?${q}`));
}

export async function loadHistory(provider: Provider, days = 30, offsetMin = offsetMinNow()): Promise<UsageHistory> {
  const q = new URLSearchParams({ provider, days: String(days), offsetMin: String(offsetMin) });
  return normHistory(await api<unknown>(`/api/usage/history?${q}`));
}

export async function loadClaudeLimits(): Promise<ClaudeLimits> {
  return normClaudeLimits(await api<unknown>("/api/usage/claude-limits"));
}

export async function loadOpenRouterCredit(): Promise<OpenRouterCredit> {
  return normOpenRouterCredit(await api<unknown>("/api/usage/openrouter-credit"));
}

export async function loadOpenRouterPrices(): Promise<Record<string, ModelPrices>> {
  return normOpenRouterPrices(await api<unknown>("/api/usage/openrouter-prices"));
}

export async function loadOpenRouterAccess(): Promise<OpenRouterAccess> {
  return normOpenRouterAccess(await api<unknown>("/api/openrouter"));
}

/**
 * The body of PUT /api/openrouter. Both switches ALWAYS go along (a missing one would be a 400, not "unchanged"); the key only when a
 * new one is set: trimmed and non-empty, since an empty string is a 400 and `undefined` means "stays".
 */
export function openRouterBody(toggle: OpenRouterPutRequired, apiKey?: string): OpenRouterBody {
  const body: OpenRouterBody = { onlyWithoutSaving: toggle.onlyWithoutSaving, noDataUsage: toggle.noDataUsage };
  const key = (apiKey ?? "").trim();
  if (key) body.apiKey = key;
  return body;
}

/** Writes the access. The answer is not read as state; the UI reloads afterwards via `loadOpenRouterAccess`. */
export async function setOpenRouterAccess(toggle: OpenRouterPutRequired, apiKey?: string): Promise<void> {
  await api<unknown>("/api/openrouter", { method: "PUT", body: JSON.stringify(openRouterBody(toggle, apiKey)) });
}

/** DELETE /api/openrouter: removes the key; the card stays (the provider is fixed). Reload afterwards. */
export async function removeOpenRouterKey(): Promise<void> {
  await api<unknown>("/api/openrouter", { method: "DELETE" });
}
