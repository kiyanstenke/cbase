// The responses of the routes `/api/usage/*` (contract account/usage-contract.js). The routes themselves are in
// account/routes.js; the computation is here so the guard (server/backend/test/usage-routes.test.js) can run it without a server.
//
// The rules:
//   · The windows `session`/`week` are those of the RING (Claude fiveHour/sevenDay, Codex primary/secondary): start =
//     resetsAt − window length from the LAST snapshot (Claude `usage_cache_v1` via account/usage.js usageInMemory, Codex
//     `codexUsage()` from the local rollouts). NEVER a fetch: no fetchUsageLimits, no `claude doctor` (with an expired
//     token it starts a login refresher). Without a snapshot (or with an expired window) the window slides over the same
//     length and the response says `windowKnown: false` — otherwise this page and the ring would never agree.
//   · Separate per provider, the cache split into read and write (the expensive writing would otherwise hide in the
//     cheap reading), no compute time (it only counted main turns).
//   · The chat list does not truncate silently: at most 25, `chatsAdditional` says how many are missing.
//   · The headline number is the API equivalent (account/equivalent.js) with its split — for OpenRouter the cost with its origin.
//
// Field order = contract (the objects are built in exactly the order of the lists; the guard compares the keys).

import * as store from "../store.js";
import * as limits from "../limits.js";
import { T } from "../i18n.js";
import { codexUsage } from "../providers/index.js";
import { catalogModel, openRouterBase, openRouterNetworkAllowed } from "../providers/openrouter-catalog.js";
import { usageInMemory } from "./usage.js";
import { equivalent, equivalentModelId, equivalentPlus, equivalentPrices } from "./equivalent.js";
import {
  SUBSCRIPTION_PROVIDER, SUBSCRIPTION_WINDOW, PROVIDER, CHAT_FIELDS, ONCE_ROLES, CREDIT_FIELDS, ORIGIN_TALLY_FIELDS, BACKGROUND_FIELDS,
  LIMIT_WINDOW_FIELDS, MODEL_FIELDS, OPENROUTER_WINDOW, OPENROUTER_ID, POINT_FIELDS, SUMS_FIELDS, PARTS_FIELDS,
  CONSUMPTION_FIELDS, HISTORY_FIELDS, CLAUDE_LIMITS_FIELDS,
} from "./usage-contract.js";

const H = 3_600_000;
const DAY_MS = 24 * H;
/** The length of the windows when the snapshot does not name it (Claude: 5 h / 7 days; Codex names it in minutes). */
const WINDOW_LENGTH = Object.freeze({ session: 5 * H, week: 7 * DAY_MS, "30d": 30 * DAY_MS });
/** At most this many chats per response — the rest is a number in `chatsAdditional`. */
export const CHATS_MAX = 25;

/** An object with exactly the keys of the list, in its order. */
const afterContract = (list, values) => Object.fromEntries(list.map((k) => [k, values[k] === undefined ? null : values[k]]));

// ── Windows ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * A provider's window: `{ from, until, windowKnown }`. `now` and the snapshots are seams for the guard
 * (`claudeState`, `codexState`); in operation they read usageInMemory and codexUsage — both without network.
 */
export function windowOf(provider, window, { now = Date.now(), claudeState = () => usageInMemory(), codexState = () => codexUsage() } = {}) {
  if (window === "total") return { from: null, until: now, windowKnown: true };
  const length = WINDOW_LENGTH[window];
  const sliding = { from: now - length, until: now, windowKnown: window === "30d" };
  if (window === "30d" || !SUBSCRIPTION_PROVIDER.includes(provider)) return sliding;
  let w = null;
  try {
    if (provider === "claude") {
      const ws = limits.claudeWindows(claudeState() || null);
      w = ws.find((x) => x.id === (window === "session" ? "session" : "weekly_all") && !x.scope) || null;
    } else {
      const u = codexState();
      const ws = u?.connected === false ? [] : limits.codexWindows(u || null);
      w = ws.find((x) => x.id === (window === "session" ? "primary" : "secondary")) || null;
    }
  } catch { w = null; }
  const reset = typeof w?.resetsAt === "number" ? w.resetsAt : null;
  // A window whose reset has passed is over — the next one began some time after; when, only a new snapshot tells.
  if (reset === null || reset <= now) return sliding;
  const minutes = Number(w?.minutes) > 0 ? Number(w.minutes) : 0;
  const lang = minutes ? minutes * 60_000 : length;
  return { from: Math.max(0, reset - lang), until: now, windowKnown: true };
}

// ── Numbers per group ──────────────────────────────────────────────────────────────────────────────────────────────────────
const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; };
const TOKEN = ["input", "output", "cacheRead", "cacheWrite", "cacheUnsplit", "runs"];
const ORIGIN = ["reported", "inquired", "estimated", "unknown"];
function empty() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheUnsplit: 0, runs: 0, costUsd: null,
    origin: { reported: 0, inquired: 0, estimated: 0, unknown: 0 }, equivalent: null, last: 0 };
}
function alongside(target, g, gw) {
  for (const k of TOKEN) target[k] += n(g[k]);
  if (g.costUsd !== null && g.costUsd !== undefined && Number.isFinite(Number(g.costUsd))) target.costUsd = (target.costUsd ?? 0) + Number(g.costUsd);
  for (const k of ORIGIN) target.origin[k] += n(g[k]);
  if (gw) target.equivalent = equivalentPlus(target.equivalent, gw);
  target.last = Math.max(target.last, n(g.last));
  return target;
}

/** The equivalent of a group (subscription providers only; OpenRouter has cost, no equivalent). `priceOf` is the guard's seam. */
function equivalentTheGroup(provider, g, priceOf) {
  if (!SUBSCRIPTION_PROVIDER.includes(provider)) return null;
  const id = equivalentModelId(provider, g.model);
  return equivalent(g, equivalentPrices(provider, id ? priceOf(id) : null));
}

const isOR = (provider) => provider === OPENROUTER_ID;

// The sums of a window. Without a single row everything is 0 and complete (nothing consumed is a statement); with rows an
// equivalent without any price is null (unknown), as is an OpenRouter amount without any report.
function sumsFrom(provider, a) {
  const subscription = !isOR(provider);
  const nothing = a.runs === 0;
  const gw = nothing ? { equivalentUsd: 0, partsUsd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, complete: true }
    : (a.equivalent || equivalent(a, null));
  return afterContract(SUMS_FIELDS, {
    input: a.input, output: a.output, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite, cacheUnsplit: a.cacheUnsplit,
    runs: a.runs,
    equivalentUsd: subscription ? gw.equivalentUsd : null,
    equivalentComplete: subscription ? gw.complete === true && gw.equivalentUsd !== null : false,
    partsUsd: subscription ? afterContract(PARTS_FIELDS, gw.partsUsd || {}) : null,
    costUsd: subscription ? null : (nothing ? 0 : a.costUsd),
    costOrigin: subscription ? null : afterContract(ORIGIN_TALLY_FIELDS, a.origin),
  });
}

/**
 * GET /api/usage/consumption — `{ status, body }` (400 for a foreign provider or a window the provider does not know).
 * `priceOf(id)` returns the catalog prices (`catalogModel(id)?.prices`) — the guard's seam.
 */
export function consumption({ provider, window }, { now = Date.now(), priceOf = (id) => catalogModel(id)?.prices || null, ...seams } = {}) {
  if (!PROVIDER.includes(provider)) return { status: 400, body: { error: T`unknown provider “${provider ?? ""}” — allowed: ${PROVIDER.join(", ")}` } };
  const allowed = isOR(provider) ? OPENROUTER_WINDOW : SUBSCRIPTION_WINDOW;
  if (!allowed.includes(window)) return { status: 400, body: { error: T`unknown window “${window ?? ""}” for ${provider} — allowed: ${allowed.join(", ")}` } };
  const f = windowOf(provider, window, { now, ...seams });
  const groups = store.usageGroups(provider, f.from ?? 0, f.until + 1);

  const total = empty();
  const models = new Map();
  const chats = new Map();
  const background = new Map();
  let subOutput = 0;
  for (const g of groups) {
    const gw = equivalentTheGroup(provider, g, priceOf);
    alongside(total, g, gw);
    const m = models.get(g.model) || { ...empty(), priceKnown: isOR(provider) ? Boolean(priceOf(g.model)) : Boolean(gw?.priceKnown) };
    models.set(g.model, alongside(m, g, gw));
    if (g.kind === "sub") subOutput += n(g.output);
    if (g.role) background.set(g.role, alongside(background.get(g.role) || empty(), g, gw));
    else if (g.chatId) chats.set(g.chatId, alongside(chats.get(g.chatId) || empty(), g, gw));
  }
  // Sorted by equivalent (subscription) or cost (OpenRouter), then output — a row without an amount comes after every one with.
  const amountOf = (a) => (isOR(provider) ? a.costUsd : a.equivalent?.equivalentUsd) ?? -1;
  const ordering = (a, b) => amountOf(b) - amountOf(a) || b.output - a.output;
  const subscription = !isOR(provider);
  const gwUsd = (a) => (subscription ? a.equivalent?.equivalentUsd ?? null : null);
  const kUsd = (a) => (subscription ? null : a.costUsd);

  const modelList = [...models.entries()].map(([model, a]) => ({ model, ...a })).sort(ordering).map((a) => afterContract(MODEL_FIELDS, {
    model: a.model, input: a.input, output: a.output, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite,
    cacheUnsplit: a.cacheUnsplit, runs: a.runs, equivalentUsd: gwUsd(a), costUsd: kUsd(a), priceKnown: a.priceKnown === true,
  }));
  const chatAll = [...chats.entries()].map(([chatId, a]) => ({ chatId, ...a })).sort(ordering);
  const top = chatAll.slice(0, CHATS_MAX);
  const title = store.chatTitle(top.map((c) => c.chatId));
  const chatList = top.map((a) => afterContract(CHAT_FIELDS, {
    chatId: a.chatId, title: title.get(a.chatId) ?? "", deleted: !title.has(a.chatId), input: a.input, output: a.output,
    cacheRead: a.cacheRead, cacheWrite: a.cacheWrite, runs: a.runs, equivalentUsd: gwUsd(a), costUsd: kUsd(a),
  }));
  // Background in the order of the contract's roles; a foreign role (legacy data) after them, raw.
  const rang = (r) => { const i = ONCE_ROLES.indexOf(r); return i < 0 ? ONCE_ROLES.length : i; };
  const backgroundList = [...background.entries()].sort((a, b) => rang(a[0]) - rang(b[0]) || a[0].localeCompare(b[0]))
    .map(([role, a]) => afterContract(BACKGROUND_FIELDS, {
      role, input: a.input, output: a.output, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite, runs: a.runs,
      equivalentUsd: gwUsd(a), costUsd: kUsd(a),
    }));
  return {
    status: 200,
    body: afterContract(CONSUMPTION_FIELDS, {
      provider, window, from: f.from, until: f.until, windowKnown: f.windowKnown,
      sums: sumsFrom(provider, total),
      models: modelList,
      chats: chatList,
      chatsAdditional: Math.max(0, chatAll.length - top.length),
      background: backgroundList,
      subagentsShare: total.output > 0 ? subOutput / total.output : null,
    }),
  };
}

// ── History per day ────────────────────────────────────────────────────────────────────────────────────────────────────────
const twoDigit = (x) => String(x).padStart(2, "0");
const dayText = (dayNumber) => { const d = new Date(dayNumber * DAY_MS); return `${d.getUTCFullYear()}-${twoDigit(d.getUTCMonth() + 1)}-${twoDigit(d.getUTCDate())}`; };

/**
 * GET /api/usage/history?provider=&days=1..90&offsetMin=−840..840 — per calendar day in the client's time zone (`offsetMin`
 * minutes east of UTC), GAPLESS (a day without consumption is there with zeros), oldest first, today last.
 */
export function history({ provider, days, offsetMin }, { now = Date.now(), priceOf = (id) => catalogModel(id)?.prices || null } = {}) {
  if (!PROVIDER.includes(provider)) return { status: 400, body: { error: T`unknown provider “${provider ?? ""}” — allowed: ${PROVIDER.join(", ")}` } };
  const t = Number(days), o = Number(offsetMin);
  if (!Number.isInteger(t) || t < 1 || t > 90) return { status: 400, body: { error: T("days must be a whole number from 1 to 90") } };
  if (!Number.isInteger(o) || o < -840 || o > 840) return { status: 400, body: { error: T("offsetMin must be a whole number from −840 to 840") } };
  const offset = o * 60_000;
  const today = Math.floor((now + offset) / DAY_MS);
  const first = today - t + 1;
  const ofMs = first * DAY_MS - offset;
  const byKey = new Map();
  for (const g of store.usagePerDay(provider, ofMs, offset)) {
    if (g.dayNumber < first || g.dayNumber > today) continue;
    const a = byKey.get(g.dayNumber) || empty();
    byKey.set(g.dayNumber, alongside(a, g, equivalentTheGroup(provider, g, priceOf)));
  }
  const subscription = !isOR(provider);
  const points = [];
  for (let day = first; day <= today; day++) {
    const a = byKey.get(day) || empty();
    points.push(afterContract(POINT_FIELDS, {
      day: dayText(day), input: a.input, output: a.output, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite,
      equivalentUsd: subscription ? (a.runs ? a.equivalent?.equivalentUsd ?? null : 0) : null,
      costUsd: subscription ? null : (a.runs ? a.costUsd : 0),
    }));
  }
  return { status: 200, body: afterContract(HISTORY_FIELDS, { provider, days: t, offsetMin: o, points }) };
}

// ── Claude: all windows of the last snapshot ───────────────────────────────────────────────────────────────────────────────
/** GET /api/usage/claude-limits — reads ONLY `usage_cache_v1` (no fetch, no `claude doctor`). */
export function claudeLimits({ claudeState = () => usageInMemory() } = {}) {
  let state = null;
  try { state = claudeState() || null; } catch { state = null; }
  const measuredAt = Number(state?.at) > 0 ? Number(state.at) : null;
  const window = limits.claudeWindows(state).map((w) => afterContract(LIMIT_WINDOW_FIELDS, {
    id: String(w.id || ""), group: String(w.group || ""), area: String(w.scope || ""),
    percent: typeof w.percent === "number" && Number.isFinite(w.percent) ? w.percent : null,
    resetsAt: typeof w.resetsAt === "number" && w.resetsAt > 0 ? w.resetsAt : null,
  }));
  return afterContract(CLAUDE_LIMITS_FIELDS, { measuredAt, window });
}

// ── OpenRouter: credit, live, cached for 60 s ──────────────────────────────────────────────────────────────────────────────
const CREDIT_APPLIES_MS = 60_000;
const CREDIT_DEADLINE_MS = 8_000;
let creditBetween = { at: 0, key: "", value: null };
const unknown = () => afterContract(CREDIT_FIELDS, { known: false });
const amountUsd = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * GET /api/usage/openrouter-credit — `GET <base>/credits` (total and consumption of the account) and `GET <base>/key` (limit and
 * rest of THIS key), both with the access's key. Without a key, without network (CBASE_OPENROUTER_OFFLINE against the real
 * base) or when `/credits` fails: `known: false`, all numbers null (never 0). A missing `/key` only leaves its two numbers empty.
 */
export async function openRouterCredit({ now = Date.now(), retrieval = fetch } = {}) {
  const keyName = String(store.openRouterAccess().apiKey || "");
  if (!keyName || !openRouterNetworkAllowed()) return unknown();
  if (creditBetween.value && creditBetween.key === keyName && now - creditBetween.at < CREDIT_APPLIES_MS) return creditBetween.value;
  const base = openRouterBase();
  const fetch = async (path) => {
    const r = await retrieval(`${base}${path}`, { headers: { Authorization: `Bearer ${keyName}` }, signal: AbortSignal.timeout(CREDIT_DEADLINE_MS) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json())?.data || null;
  };
  const [credits, key] = await Promise.allSettled([fetch("/credits"), fetch("/key")]);
  const c = credits.status === "fulfilled" ? credits.value : null;
  if (!c) return unknown(); // nothing cached: the next call asks again
  const k = key.status === "fulfilled" ? key.value : null;
  const total = amountUsd(c.total_credits), consumed = amountUsd(c.total_usage);
  const value = afterContract(CREDIT_FIELDS, {
    known: true,
    totalUsd: total, consumedUsd: consumed, restUsd: total !== null && consumed !== null ? total - consumed : null,
    keyLimitUsd: k ? amountUsd(k.limit) : null, keyRestUsd: k ? amountUsd(k.limit_remaining) : null,
    at: now,
  });
  creditBetween = { at: now, key: keyName, value };
  return value;
}

/** Tests only: clear the credit cache. */
export function forgetCredit() { creditBetween = { at: 0, key: "", value: null }; }
