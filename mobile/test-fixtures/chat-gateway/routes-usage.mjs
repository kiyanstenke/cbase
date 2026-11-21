// Provider and usage: the routes of the contract `server/backend/electron/server/account/usage-contract.js` for the UI tests of the
// sub-pages of Settings → Usage and the fixed OpenRouter card — `GET /api/usage/consumption|history|claude-limits|openrouter-credit`,
// `GET/PUT/DELETE /api/openrouter`, `PUT /api/default-model`, `GET /api/usage/openrouter-prices` and the test switch
// `POST /fixture/openrouter`. The state lives in `state.mjs` (`S.openrouter`, `S.defaultModel`, cleared by `resetSettings`).
//
// The shapes are the lists of the contract (field by field) — a fixture with fields of its own would test its own invention.
// What the contract leaves open is as the app reads it (`Models/UsageModels.swift`): `from`/`until`/`at`/`measuredAt` in ms,
// `resetsAt` as ISO text, `subagentsShare` as `{ share, output }`.
//
// The numbers are chosen, not measured, and each carries a check: Claude in the session window 30k of 86k output from
// subagents (35 %, `usage-subagent-share`), three chats more than the list shows (`chatsAdditional`), a week WITHOUT snapshot
// (`windowKnown: false` ⇒ "Last 7 days"), a model without price (equivalent "lower bound"), OpenRouter with all four origins.
import { S, json, body, NEXT } from "./state.mjs";

const SUBSCRIPTION_WINDOW = ["session", "week", "30d"];
const OPENROUTER_WINDOW = ["30d", "total"];
const PROVIDER = ["claude", "codex", "openrouter"];

const HOUR = 3_600_000;

/** The sums of a window in the shape of the contract (SUMS_FIELDS). */
const sums = (z) => ({
  input: z.input, output: z.output, cacheRead: z.cacheRead, cacheWrite: z.cacheWrite,
  cacheUnsplit: z.cacheUnsplit ?? 0, runs: z.runs,
  equivalentUsd: z.equivalentUsd ?? null, equivalentComplete: z.equivalentComplete ?? true,
  partsUsd: z.partsUsd ?? null, costUsd: z.costUsd ?? null, costOrigin: z.costOrigin ?? null,
});

/** An answer of `GET /api/usage/consumption` (CONSUMPTION_FIELDS). */
function consumption(provider, window) {
  const now = Date.now();
  const known = !(provider === "claude" && window === "week");
  const from = window === "total" ? null : now - (window === "session" ? 2 * HOUR : window === "week" ? 3 * 24 * HOUR : 30 * 24 * HOUR);
  const factor = window === "session" ? 1 : window === "week" ? 4 : window === "30d" ? 12 : 20;
  if (provider === "openrouter") {
    return {
      provider, window, from, until: now, windowKnown: true,
      sums: sums({
        input: 420_000 * factor, output: 38_000 * factor, cacheRead: 0, cacheWrite: 0, cacheUnsplit: 12_000, runs: 283,
        costUsd: 3.47 * factor, costOrigin: { reported: 88, inquired: 3, estimated: 190, unknown: 2 },
      }),
      models: [
        { model: "z-ai/glm-5.3-flash", input: 380_000 * factor, output: 34_000 * factor, cacheRead: 0, cacheWrite: 0, cacheUnsplit: 12_000, runs: 270, equivalentUsd: null, costUsd: 2.91 * factor, priceKnown: true },
        { model: "deepseek/deepseek-v4", input: 40_000 * factor, output: 4_000 * factor, cacheRead: 0, cacheWrite: 0, cacheUnsplit: 0, runs: 13, equivalentUsd: null, costUsd: 0.56 * factor, priceKnown: true },
      ],
      chats: [
        { chatId: "chat-1", title: "Sample issue → Coding workflow", deleted: false, input: 300_000, output: 26_000, cacheRead: 0, cacheWrite: 0, runs: 190, equivalentUsd: null, costUsd: 2.1 },
      ],
      chatsAdditional: 0,
      background: [
        { role: "outer_loop", input: 60_000, output: 5_000, cacheRead: 0, cacheWrite: 0, runs: 40, equivalentUsd: null, costUsd: 0.42 },
        { role: "retrieval", input: 20_000, output: 2_000, cacheRead: 0, cacheWrite: 0, runs: 9, equivalentUsd: null, costUsd: 0.11 },
      ],
      subagentsShare: null,
    };
  }
  if (provider === "codex") {
    return {
      provider, window, from, until: now, windowKnown: true,
      sums: sums({
        input: 1_500_000 * factor, output: 41_000 * factor, cacheRead: 6_200_000 * factor, cacheWrite: 0, runs: 22,
        equivalentUsd: 9.8 * factor, partsUsd: { input: 3.75 * factor, output: 4.1 * factor, cacheRead: 1.95 * factor, cacheWrite: 0 },
      }),
      models: [
        { model: "gpt-5.6-sol", input: 1_500_000 * factor, output: 41_000 * factor, cacheRead: 6_200_000 * factor, cacheWrite: 0, cacheUnsplit: 0, runs: 22, equivalentUsd: 9.8 * factor, costUsd: null, priceKnown: true },
      ],
      chats: [
        { chatId: "chat-2", title: "Examplecorp workspace overview", deleted: false, input: 1_500_000, output: 41_000, cacheRead: 6_200_000, cacheWrite: 0, runs: 22, equivalentUsd: 9.8, costUsd: null },
      ],
      chatsAdditional: 0,
      background: [],
      subagentsShare: null,
    };
  }
  // Claude: subagents 30k of 86k output (35 %), a model without price (Fable) ⇒ equivalent incomplete.
  return {
    provider, window, from: known ? from : now - 7 * 24 * HOUR, until: now, windowKnown: known,
    sums: sums({
      input: 1_240_000 * factor, output: 86_000 * factor, cacheRead: 9_300_000 * factor, cacheWrite: 500_000 * factor, runs: 20,
      equivalentUsd: 87.2 * factor, equivalentComplete: false,
      partsUsd: { input: 0.4 * factor, output: 20.9 * factor, cacheRead: 22.7 * factor, cacheWrite: 43.2 * factor },
    }),
    models: [
      { model: "claude-opus-5-5", input: 1_100_000 * factor, output: 80_000 * factor, cacheRead: 9_000_000 * factor, cacheWrite: 480_000 * factor, cacheUnsplit: 0, runs: 17, equivalentUsd: 87.2 * factor, costUsd: null, priceKnown: true },
      { model: "claude-fable-5-1", input: 140_000 * factor, output: 6_000 * factor, cacheRead: 300_000 * factor, cacheWrite: 20_000 * factor, cacheUnsplit: 0, runs: 3, equivalentUsd: null, costUsd: null, priceKnown: false },
    ],
    chats: [
      { chatId: "chat-1", title: "Sample issue → Coding workflow", deleted: false, input: 1_010_000, output: 71_000, cacheRead: 7_700_000, cacheWrite: 420_000, runs: 17, equivalentUsd: 71.4, costUsd: null },
      { chatId: "chat-2", title: "Examplecorp workspace overview", deleted: false, input: 230_000, output: 15_000, cacheRead: 1_600_000, cacheWrite: 80_000, runs: 3, equivalentUsd: 15.8, costUsd: null },
    ],
    chatsAdditional: 3,
    background: [
      { role: "extraction", input: 90_000, output: 9_000, cacheRead: 0, cacheWrite: 0, runs: 6, equivalentUsd: 1.35, costUsd: null },
      { role: "categorization", input: 50_000, output: 4_000, cacheRead: 0, cacheWrite: 0, runs: 9, equivalentUsd: 0.07, costUsd: null },
      { role: "title", input: 4_000, output: 300, cacheRead: 0, cacheWrite: 0, runs: 4, equivalentUsd: 0.01, costUsd: null },
    ],
    subagentsShare: { share: 30_000 / 86_000, output: 30_000 * factor },
  };
}

/** `GET /api/usage/history`: gapless, oldest day first (POINT_FIELDS). */
function history(provider, days, offsetMin) {
  const points = [];
  const today = new Date(Date.now() + offsetMin * 60_000);
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(today.getTime() - i * 24 * HOUR).toISOString().slice(0, 10);
    const w = (i * 7) % 5; // a calm rhythm, nothing on two of five days
    const money = w * 2.5;
    points.push({
      day, input: w * 100_000, output: w * 8_000, cacheRead: w * 600_000, cacheWrite: w * 30_000,
      // `/fixture/usage { historyUnknown }`: as the server does for days WITH runs without price `null`, without runs 0.
      equivalentUsd: provider === "openrouter" ? null : S.usageHistoryUnknown && w > 0 ? null : money,
      costUsd: provider === "openrouter" ? money / 10 : null,
    });
  }
  return { provider, days, offsetMin, points };
}

/** The access as `GET /api/openrouter` shows it (OPENROUTER_ACCESS_FIELDS) — the key itself never leaves the server. */
const access = () => ({
  keySet: Boolean(S.openrouter.key),
  onlyWithoutSaving: S.openrouter.onlyWithoutSaving,
  noDataUsage: S.openrouter.noDataUsage,
});

export async function routesUsage(ctx) {
  const { req, res, url, path, method } = ctx;
  if (path === "/api/usage/consumption" && method === "GET") {
    const provider = url.searchParams.get("provider") || "";
    const window = url.searchParams.get("window") || "";
    if (!PROVIDER.includes(provider)) return json(res, 400, { error: `unknown provider “${provider}” — allowed: ${PROVIDER.join(", ")}` });
    const allowed = provider === "openrouter" ? OPENROUTER_WINDOW : SUBSCRIPTION_WINDOW;
    if (!allowed.includes(window)) return json(res, 400, { error: `unknown window “${window}” for ${provider} — allowed: ${allowed.join(", ")}` });
    if (S.usageDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, S.usageDelayMs));
    return json(res, 200, consumption(provider, window));
  }
  if (path === "/api/usage/history" && method === "GET") {
    const provider = url.searchParams.get("provider") || "";
    if (!PROVIDER.includes(provider)) return json(res, 400, { error: `unknown provider “${provider}” — allowed: ${PROVIDER.join(", ")}` });
    const days = Number(url.searchParams.get("days") || 30);
    const offsetMin = Number(url.searchParams.get("offsetMin") || 0);
    if (!Number.isInteger(days) || days < 1 || days > 90) return json(res, 400, { error: "days must be a whole number from 1 to 90" });
    if (!Number.isInteger(offsetMin) || offsetMin < -840 || offsetMin > 840) return json(res, 400, { error: "offsetMin must be a whole number from −840 to 840" });
    return json(res, 200, history(provider, days, offsetMin));
  }
  if (path === "/api/usage/claude-limits" && method === "GET") {
    const reset = (h) => new Date(Date.now() + h * HOUR).toISOString();
    return json(res, 200, {
      measuredAt: Date.now() - 4 * 60_000,
      window: [
        { id: "session", group: "session", area: "", percent: 12, resetsAt: reset(3) },
        { id: "weekly_all", group: "weekly", area: "", percent: 4, resetsAt: reset(90) },
        { id: "weekly_fable", group: "weekly", area: "Fable", percent: 100, resetsAt: reset(40) },
      ],
    });
  }
  if (path === "/api/usage/openrouter-credit" && method === "GET") {
    if (!S.openrouter.key) {
      return json(res, 200, { known: false, totalUsd: null, consumedUsd: null, restUsd: null, keyLimitUsd: null, keyRestUsd: null, at: null });
    }
    return json(res, 200, { known: true, totalUsd: 25, consumedUsd: 12.7, restUsd: 12.3, keyLimitUsd: null, keyRestUsd: null, at: Date.now() - 20_000 });
  }
  if (path === "/api/usage/openrouter-prices" && method === "GET") {
    return json(res, 200, {
      models: [
        { provider: "openrouter", model: "z-ai/glm-5.3-flash", upstream: "Cerebras", known: true,
          span: { inMin: 0.08, inMax: 0.12, outMin: 0.3, outMax: 0.45 }, last: { inMin: 0.1, inMax: 0.1, outMin: 0.4, outMax: 0.4 } },
        { provider: "openrouter", model: "deepseek/deepseek-v4", upstream: "", known: false, span: null, last: null },
      ],
    });
  }
  if (path === "/api/openrouter" && method === "GET") return json(res, 200, access());
  if (path === "/api/openrouter" && method === "PUT") {
    const b = (await body(req)) || {};
    // As the contract (OPENROUTER_PUT_REQUIRED): both switches required and boolean — a missing one is a 400, not "unchanged".
    for (const k of ["onlyWithoutSaving", "noDataUsage"]) {
      if (typeof b[k] !== "boolean") return json(res, 400, { error: `The field “${k}” is missing or not a boolean.` });
    }
    if (b.apiKey !== undefined && (typeof b.apiKey !== "string" || !b.apiKey.trim())) {
      return json(res, 400, { error: "The key is empty — use DELETE /api/openrouter to remove it." });
    }
    S.openrouter.onlyWithoutSaving = b.onlyWithoutSaving;
    S.openrouter.noDataUsage = b.noDataUsage;
    if (typeof b.apiKey === "string") S.openrouter.key = b.apiKey.trim();
    S.openrouter.lastPut = { onlyWithoutSaving: b.onlyWithoutSaving, noDataUsage: b.noDataUsage, apiKey: b.apiKey !== undefined };
    return json(res, 200, { ok: true, ...access() });
  }
  if (path === "/api/openrouter" && method === "DELETE") {
    S.openrouter.key = "";
    return json(res, 200, { ok: true, ...access() });
  }
  // The default model per provider (`PUT /api/default-model`) — `/api/providers` then delivers it as `defaultModel`.
  if (path === "/api/default-model" && method === "PUT") {
    const b = (await body(req)) || {};
    if (!["claude", "codex", "openrouter", "flat"].includes(b.provider)) return json(res, 400, { error: "Unknown provider" });
    if (typeof b.model !== "string" || !b.model) return json(res, 400, { error: "The field “model” is missing." });
    S.defaultModel[b.provider] = b.model;
    return json(res, 200, { ok: true });
  }
  // Test switch: `{ delayMs }` — `consumption` answers that late (a window change aborts the old request); `{ historyUnknown }` —
  // in the history of the subscriptions the days with consumption carry `equivalentUsd: null`.
  if (path === "/fixture/usage" && method === "POST") {
    const b = (await body(req)) || {};
    S.usageDelayMs = Math.max(0, Math.min(15_000, Number(b.delayMs) || 0));
    S.usageHistoryUnknown = b.historyUnknown === true;
    return json(res, 200, { delayMs: S.usageDelayMs, historyUnknown: S.usageHistoryUnknown });
  }
  // Test switch: `{ key: true }` stores a key (OpenRouter connected, its catalog in every model choice), `{ key: false }` removes it.
  // Set it between `reset-run` and the app start (`launchApp` setup closure).
  if (path === "/fixture/openrouter" && method === "POST") {
    const b = (await body(req)) || {};
    S.openrouter.key = b.key === true ? "sk-or-fixture" : "";
    return json(res, 200, access());
  }
  return NEXT;
}
