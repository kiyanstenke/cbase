// Routes: account and providers. Each function takes ctx = { req, res, url, p, m } and returns NEXT when it is not
// responsible; any other return value means "answered". Call order: ROUTES in server.js.
// Functions: accountRoutes (usage*, account, providers, default-model, provider, openrouter) · codexRoutes
// (/api/account/:provider, account/codex*, codex-oauth).
// No route here CREATES a provider: OpenRouter is built in and its access is under `/api/openrouter` (contract
// `OPENROUTER_*` in account/usage-contract.js). Every route here that takes a provider id rejects a foreign one with 400.
// Guard: server/backend/test/only-three-provider.test.js.
// `let lastClaudeConnected` lives HERE because the /api/providers route assigns it — in another file that would be a
// silent TypeError. In codexRoutes, /api/account/:provider ↔ /api/account/codex is defused by acm[1] !== "codex".

import { execFile } from "node:child_process";
import http from "node:http";
import { cleanClaudeEnv } from "../claude.js";
import { PROVIDERS, DEFAULT_LEVEL_SETTING, codexUsage, effortStandard, getActiveProviderId, getConnector, levelOnWire, isProviderId, modelSelectable, providerAuthStatus, setActiveProviderId, setAccountKind, visibleModels, defaultModelInvalid, forgetAccountKind } from "../providers/index.js";
import { createTerminal } from "../terminal.js";
import * as limits from "../limits.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { effortSavable } from "../workflows.js";
import { NEXT, readBody, send } from "../runtime/http.js";
import { claudeAuth, fetchUsageLimits } from "./usage.js";
import * as usage from "./usage-report.js";
import { defaultModelFor } from "./providers.js";
import { OPENROUTER_ID, OPENROUTER_PUT_REQUIRED } from "./usage-contract.js";
import { creditGateOn } from "../runs/limit-gate.js";

// Last SUCCESSFULLY read claude login status (CLI errors do not overwrite it).
let lastClaudeConnected = false;
// Failed price fetches per "<provider>::<model>" → until when they count as `known: false` (GET /api/usage/openrouter-prices).
// openrouter-endpoints.js only stores successes (1 h); without this map every page view would ask an unreachable OpenRouter again.
const priceError = new Map();
const PRICE_ERROR_MS = 5 * 60_000;

// The GET response of /api/openrouter (contract `OPENROUTER_ACCESS_FIELDS`): whether a key is set and the two switches —
// read from `extra_body.provider` of the row.
function openRouterResponse() {
  const z = store.openRouterAccess();
  const provider = z.extraBody?.provider && typeof z.extraBody.provider === "object" ? z.extraBody.provider : {};
  return {
    keySet: Boolean(z.apiKey),
    onlyWithoutSaving: provider.zdr === true,
    noDataUsage: provider.data_collection === "deny",
  };
}

export async function accountRoutes(ctx) {
  const { req, res, url, p, m } = ctx;

      // ── Usage ────────────────────────────────────────────────────────────
      if (p === "/api/usage" && m === "GET") {
        try {
          const data = await fetchUsageLimits();
          // `credit` and `gate` are derived at RESPONSE TIME, not written to the cache: they are views
          // of the same raw data, and two write paths for the same number are exactly the leftover
          // someone goes looking for later. `gate.window` says whether the credit gate would apply
          // NOW; the setting itself is under /api/credit-gate.
          return send(res, 200, {
            ...data,
            credit: limits.creditStatus(data),
            gate: {
              enabled: creditGateOn(),
              threshold: limits.START_GATE_PERCENT,
              window: limits.gatePayload(limits.claudeWindows(data)),
            },
          });
        } catch (e) { return send(res, 503, { error: String(e.message || e) }); }
      }
      // Codex usage (rate limits) — locally from the session rollouts, no network.
      // `ring`/`blocking` as in /api/usage: ring = short window, blocking = what is at its limit
      // (including credit/spend caps, which have no time window at all).
      if (p === "/api/usage/codex" && m === "GET") {
        const u = codexUsage();
        const wins = u?.connected ? limits.codexWindows(u) : [];
        return send(res, 200, { ...u, ring: limits.ringPayload(wins), blocking: limits.blockingPayload(wins) });
      }
      // The prices per provider behind OpenRouter — DISPLAY ONLY, billing follows the reported amount (the cost is under
      // `/api/usage/consumption?provider=openrouter`). For every model OpenRouter ever ran (usage_events): the span per
      // 1 M tokens (USD) across the active endpoints and the price of the provider of the LAST response (`upstream` from
      // usage_events). The response form (`provider` per entry) stays although there is only ONE provider — the clients
      // read it. A route OF ITS OWN so the usage report never waits for the network: the endpoints come from the cache
      // (1 h per model, providers/openrouter-endpoints.js), a cold fetch has an 8 s deadline, an error means
      // `known: false` (span null) — unknown, never 0. At most four fetches at once.
      // Two caps, otherwise with OpenRouter unreachable EVERY page view would take (models / 4) × 8 s: a failure counts as
      // `known: false` for 5 min (`PRICE_ERROR_MS`) without a new fetch; and the route answers after at most
      // `CBASE_OR_PRICES_DEADLINE_MS` (default 10 s) — what has not arrived by then is `known: false` (unknown, not
      // failed: the fetch keeps running and fills the cache for the next call).
      if (p === "/api/usage/openrouter-prices" && m === "GET") {
        const targets = store.meteredModels(OPENROUTER_ID).map((r) => ({ provider: OPENROUTER_ID, model: r.model, upstream: r.upstream }));
        const models = targets.map((r) => ({ provider: r.provider, model: r.model, upstream: r.upstream || "", known: false, span: null, last: null }));
        let next = 0;
        const worker = async () => {
          while (next < targets.length) {
            const i = next++;
            const r = targets[i];
            const key = `${r.provider}::${r.model}`;
            if ((priceError.get(key) || 0) > Date.now()) continue;
            try {
              const pr = await getConnector(r.provider).modelPrices(r.model, r.upstream || "");
              priceError.delete(key);
              Object.assign(models[i], { known: true, span: pr.span, last: pr.last });
            } catch { priceError.set(key, Date.now() + PRICE_ERROR_MS); /* unknown — the report shows no span */ }
          }
        };
        const deadline = Number(process.env.CBASE_OR_PRICES_DEADLINE_MS) > 0 ? Number(process.env.CBASE_OR_PRICES_DEADLINE_MS) : 10_000;
        let clock = null;
        await Promise.race([
          Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker)),
          new Promise((r) => { clock = setTimeout(r, deadline); clock.unref?.(); }),
        ]);
        clearTimeout(clock);
        // A copy: a fetch arriving after the deadline does not change the response already sent.
        const out = models.map((e) => ({ ...e })).sort((a, z) => a.provider.localeCompare(z.provider) || a.model.localeCompare(z.model));
        return send(res, 200, { models: out });
      }
      // Consumption of a workflow run per step — the view that names an expensive step. Without compute time (it only
      // counted main turns; the column `secs` is still written, not returned).
      if (p === "/api/usage/run" && m === "GET") {
        const runId = url.searchParams.get("run") || "";
        if (!runId) return send(res, 400, { error: T("run is missing") });
        const steps = store.usageByRun(runId);
        const run = store.getWorkflowRunById(runId) || null;
        const sum = (k) => steps.reduce((s, r) => s + (r[k] || 0), 0);
        return send(res, 200, {
          run: run && { id: run.id, name: run.workflowName, status: run.status, step: run.step, total: run.total },
          totals: { input: sum("input"), output: sum("output"), cached: sum("cached") },
          steps,
        });
      }
      // ── Usage page (contract account/usage-contract.js) ──────────────────────────────────────────────────
      // The four routes of the "Usage" page; computed in account/usage-report.js. They read ONLY the database and the
      // stored snapshots — never /api/usage, never fetchUsageLimits, never `claude doctor` (guard
      // server/backend/test/usage-routes.test.js) —, except OpenRouter's credit (live, cached for 60 s).
      if (p === "/api/usage/consumption" && m === "GET") {
        const r = usage.consumption({ provider: url.searchParams.get("provider") || "", window: url.searchParams.get("window") || "" });
        return send(res, r.status, r.body);
      }
      if (p === "/api/usage/history" && m === "GET") {
        const count = (k, preset) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : preset);
        const r = usage.history({ provider: url.searchParams.get("provider") || "", days: count("days", 30), offsetMin: count("offsetMin", 0) });
        return send(res, r.status, r.body);
      }
      if (p === "/api/usage/claude-limits" && m === "GET") return send(res, 200, usage.claudeLimits());
      if (p === "/api/usage/openrouter-credit" && m === "GET") return send(res, 200, await usage.openRouterCredit());
      // ── Account (Claude connection via `claude auth`) ────────────────────────
      if (p === "/api/account" && m === "GET") {
        const { err, stdout } = await claudeAuth(["auth", "status", "--json"]);
        try {
          const j = JSON.parse(stdout);
          return send(res, 200, { connected: !!j.loggedIn, ...j });
        } catch {
          // Not logged in or claude not found → report as "not connected".
          return send(res, 200, { connected: false, loggedIn: false, error: err ? String(err.message || err) : T("claude auth status not readable") });
        }
      }
      // Login starts `claude auth login` in a PTY; the frontend attaches to the generic
      // /api/terminal/:id endpoints (SSE output, POST input). The browser opens for the
      // OAuth authorization; on success the token is in the keychain.
      if (p === "/api/account/connect" && m === "POST") {
        try {
          const sess = createTerminal({ command: process.env.CLAUDE_BIN || "claude", args: ["auth", "login"], cwd: process.env.HOME, env: cleanClaudeEnv() });
          return send(res, 201, { ...sess, available: true });
        } catch (e) {
          return send(res, 200, { available: false, error: String(e.message || e) });
        }
      }
      if (p === "/api/account/logout" && m === "POST") {
        const { err, stdout, stderr } = await claudeAuth(["auth", "logout"]);
        return send(res, 200, { ok: !err, output: `${stdout}${stderr}`.trim() });
      }
      // ── Provider (Claude ⇄ OpenAI Codex) ─────────────────────────────────────
      if (p === "/api/providers" && m === "GET") {
        const active = getActiveProviderId();
        // If the claude CLI runs into an error/timeout (e.g. under load), keep the LAST known
        // status — otherwise the usage ring wrongly disappears from the top navigation although
        // the login is unchanged. Only a SUCCESSFULLY read response (including loggedIn:false
        // after a real logout) updates the status.
        let claudeConnected = lastClaudeConnected;
        try { const { stdout } = await claudeAuth(["auth", "status", "--json"]); claudeConnected = !!JSON.parse(stdout).loggedIn; lastClaudeConnected = claudeConnected; } catch {}
        const list = Object.values(PROVIDERS);
        // Status per provider: claude via CLI, codex via local status, OpenRouter "connected" = key set
        // (no network check during frequent polling; live check separately via /api/account/openrouter).
        // The list is exactly the three providers of the registry (`PROVIDERS`); OpenRouter carries the catalog list (only models with tools).
        const statuses = await Promise.all(list.map(async (pv) => {
          if (pv.id === "claude") return { connected: claudeConnected, authMethod: "" };
          if (pv.id === "codex") { const s = await providerAuthStatus("codex").catch(() => ({ connected: false })); return { connected: !!s.connected, authMethod: s.authMethod || "" }; }
          return { connected: Boolean(store.openRouterAccess().apiKey), authMethod: "apikey" };
        }));
        // Write the account kind back into the registry BEFORE anything enumerates models: there it
        // decides visibility — for this picker, for `defaultModel` one line below AND for every path
        // that names subagent models (system prompt, tool description, error hints). This route
        // fills the setter because the clients poll it constantly anyway; asking would only work
        // async, and `codex login status` has a 15 s timeout.
        list.forEach((pv, i) => setAccountKind(pv.id, statuses[i].authMethod));
        const providers = list.map((pv, i) => ({
          id: pv.id, label: pv.label, models: visibleModels(pv.id, pv.models), caps: pv.caps,
          connected: !!statuses[i].connected, authMethod: statuses[i].authMethod || "",
          defaultModel: defaultModelFor(pv.id),
          // OpenRouter: the stored default APPLIES even when the catalog currently does not list it with tools — this
          // field says so instead of silently naming another model. `defaultModel` "" means: none chosen (every run
          // without a model then ends with a message, connectors/openai-chat.js). Claude and Codex: always false.
          defaultModelInvalid: defaultModelInvalid(pv.id),
          // The default effort level: chosen, otherwise the catalog level of the default model, otherwise medium.
          // A level — whether it runs on a model is decided by the run's clamp. Empty for a provider that
          // puts no level on the wire (`caps.effort: false`): nothing assumes "medium" there.
          defaultEffort: levelOnWire(pv.id) ? effortStandard(pv.id) : "",
        }));
        return send(res, 200, { active, providers });
      }
      // Set a provider's default model (Settings → Providers). Applies to new chats
      // and to old chats without an explicit model (on the next run).
      if (p === "/api/default-model" && m === "PUT") {
        const b = await readBody(req);
        if (!isProviderId(b.provider)) return send(res, 400, { error: T("Unknown provider") });
        // OpenRouter: any catalog model with tools (`modelSelectable`; a still empty catalog is unknown, hence yes).
        if (b.provider === OPENROUTER_ID) {
          if (!modelSelectable(OPENROUTER_ID, b.model)) return send(res, 400, { error: T("Unknown model for this provider") });
          store.setSetting(`default_model_${b.provider}`, String(b.model).trim());
          return send(res, 200, { ok: true, provider: b.provider, model: String(b.model).trim() });
        }
        // Visible, not just known: a model may be in the catalog (a key account runs it) while the
        // signed-in subscription account rejects it with 400. Stored as DEFAULT that would be one
        // chat after another that never starts — and the settings page would silently show a
        // different entry. So the rejection states the reason in plain words: "unknown" would be
        // wrong here, the model does exist.
        const visible = visibleModels(b.provider, PROVIDERS[b.provider]?.models);
        if (!visible.some((mo) => mo.id && mo.id === b.model)) {
          const inCatalog = (PROVIDERS[b.provider]?.models || []).some((mo) => mo.id && mo.id === b.model);
          return send(res, 400, { error: inCatalog
            ? T("This model cannot run on the signed-in account — it needs an API key.")
            : T("Unknown model for this provider") });
        }
        store.setSetting(`default_model_${b.provider}`, b.model);
        return send(res, 200, { ok: true, provider: b.provider, model: b.model });
      }
      // Set a provider's default effort level (Settings → Providers). Affects every run whose chat carries NO
      // level, on the next run (`effortRunning`). A missing `effort` is not an instruction (400), nor is an
      // unknown one; "" means "back to the preset" (providers/index.js effortStandard: on the fallback model the
      // fallback level, otherwise the catalog level of the default model).
      if (p === "/api/default-effort" && m === "PUT") {
        const b = await readBody(req);
        if (!isProviderId(b.provider)) return send(res, 400, { error: T("Unknown provider") });
        const verdict = effortSavable(b.effort);
        if (verdict.kind === "missing") return send(res, 400, { error: T("The field “effort” is missing.") });
        if (verdict.kind === "unknown") return send(res, 400, { error: verdict.error });
        store.setSetting(DEFAULT_LEVEL_SETTING(b.provider), verdict.level);
        return send(res, 200, { ok: true, provider: b.provider, effort: effortStandard(b.provider) });
      }
      if (p === "/api/provider" && m === "GET") {
        // Cheap (setting only, no auth checks) — for frequent polling (e.g. the usage ring gate).
        return send(res, 200, { active: getActiveProviderId() });
      }
      if (p === "/api/provider" && m === "POST") {
        const b = await readBody(req);
        if (!isProviderId(b.provider)) return send(res, 400, { error: T("Unknown provider") });
        const prev = getActiveProviderId();
        const active = setActiveProviderId(b.provider);
        // Provider actually changed → drop the sessions of the chats following the global provider
        // (without an explicit provider) so no resume id of another provider is left over.
        if (active !== prev) store.clearGlobalProviderChatSessions();
        return send(res, 200, { active });
      }
      // ── OpenRouter: the access ────────────────────────────────────────────────────────────────────────────
      // Only the key and the two privacy switches ("only providers without data retention" = `provider.zdr`, "no data
      // usage" = `provider.data_collection: "deny"` in the body of every request). The key never leaves the server — GET
      // only says WHETHER one is set. PUT requires BOTH switches as booleans (a missing one is not an instruction but a
      // 400); `apiKey` is optional (if missing, the stored one stays), an empty string is a 400. DELETE removes the
      // key, the switches stay. Other fields in `extra_body` stay as they are.
      if (p === "/api/openrouter" && m === "GET") return send(res, 200, openRouterResponse());
      if (p === "/api/openrouter" && m === "PUT") {
        const b = await readBody(req);
        for (const field of OPENROUTER_PUT_REQUIRED) {
          if (typeof b?.[field] !== "boolean") return send(res, 400, { error: T`The field “${field}” is missing or not a boolean.` });
        }
        let apiKey;
        if (b.apiKey !== undefined) {
          if (typeof b.apiKey !== "string" || !b.apiKey.trim()) return send(res, 400, { error: T("The key is empty — use DELETE /api/openrouter to remove it.") });
          apiKey = b.apiKey.trim();
        }
        const old = store.openRouterAccess().extraBody;
        const provider = { ...(old.provider && typeof old.provider === "object" && !Array.isArray(old.provider) ? old.provider : {}) };
        if (b.onlyWithoutSaving) provider.zdr = true; else delete provider.zdr;
        if (b.noDataUsage) provider.data_collection = "deny"; else delete provider.data_collection;
        const extraBody = { ...old };
        if (Object.keys(provider).length) extraBody.provider = provider; else delete extraBody.provider;
        store.setOpenRouterAccess({ apiKey, extraBody });
        return send(res, 200, openRouterResponse());
      }
      if (p === "/api/openrouter" && m === "DELETE") {
        store.removeOpenRouterKey();
        return send(res, 200, openRouterResponse());
      }
  return NEXT;
}

export async function codexRoutes(ctx) {
  const { req, res, url, p, m } = ctx;
      // Live connection check of OpenRouter (a real fetch of /key with the key) — on demand, not while polling.
      {
        const acm = p.match(/^\/api\/account\/([a-z0-9_-]+)$/);
        if (acm && m === "GET" && acm[1] !== "codex") {
          // Only the three providers — a foreign id is a 400, not "not connected".
          if (!isProviderId(acm[1])) return send(res, 400, { error: T("Unknown provider") });
          const st = await providerAuthStatus(acm[1]).catch((e) => ({ connected: false, raw: String(e?.message || e), authMethod: "apikey" }));
          return send(res, 200, st || { connected: false });
        }
      }
      // Codex account (ChatGPT subscription via `codex login`).
      if (p === "/api/account/codex" && m === "GET") {
        const st = await providerAuthStatus("codex").catch((e) => ({ connected: false, raw: String(e.message || e), authMethod: "" }));
        return send(res, 200, st);
      }
      // ── Codex OAuth relay (container only): `codex login` listens INSIDE the container on
      // localhost:1455. The desktop client binds 127.0.0.1:1455 on the USER's device
      // (OpenAI redirects there) and passes the callback through the gateway to here —
      // so the normal browser login also works remotely (device auth is often
      // disabled by the org). The gateway session protects the route.
      if (p.startsWith("/api/codex-oauth/") && m === "GET") {
        if (process.env.CBASE_CONTAINER !== "1") return send(res, 404, { error: T("only in server mode") });
        const rest = req.url.slice("/api/codex-oauth".length) || "/";
        const relay = http.request({ host: "127.0.0.1", port: 1455, path: rest, method: "GET", headers: { host: "localhost:1455" } }, (rr) => {
          res.writeHead(rr.statusCode || 502, rr.headers);
          rr.pipe(res);
        });
        relay.on("error", () => { if (!res.headersSent) send(res, 502, { error: T("No codex login in progress") }); else try { res.end(); } catch {} });
        relay.end();
        return;
      }

      if (p === "/api/account/codex/connect" && m === "POST") {
        try {
          const cenv = { ...process.env }; delete cenv.OPENAI_API_KEY; // force the ChatGPT login
          // Default: normal browser flow (localhost:1455 — remotely via the client relay, see above).
          // Escape hatch: CBASE_CODEX_DEVICE_AUTH=1 forces the device code flow.
          const codexArgs = process.env.CBASE_CODEX_DEVICE_AUTH === "1" ? ["login", "--device-auth"] : ["login"];
          const sess = createTerminal({ command: process.env.CODEX_BIN || "codex", args: codexArgs, cwd: process.env.HOME, env: cenv });
          return send(res, 201, { ...sess, available: true });
        } catch (e) {
          return send(res, 200, { available: false, error: String(e.message || e) });
        }
      }
      if (p === "/api/account/codex/logout" && m === "POST") {
        const out = await new Promise((resolve) => {
          execFile(process.env.CODEX_BIN || "codex", ["logout"], { timeout: 15_000 }, (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout || ""}${stderr || ""}`.trim() }));
        });
        // The remembered account kind belongs to the logged-out account. It is stored in the settings and
        // thus survives a restart — left in place it would take two models away from the next (maybe
        // key) account for no reason. Unknown means show everything.
        forgetAccountKind("codex");
        return send(res, 200, out);
      }
  return NEXT;
}
