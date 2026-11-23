// Settings routes of the fixture gateway: gw/info (with the server-api variants and the recorded client header), account self-deletion, push, adjust, autocompact, TTS, web search, permission rules, auto-continue, credit gate, hooks, GitLab accounts, notify, env, logout, health.
import { S, json, body, defaultLevelOf, AGENT_MODEL_KEYS, agentEffective, autocompactDoc, AUTOCOMPACT_STAGES, AUTOCOMPACT_MAX_STAGES, TTS_VOICES, WEB_SEARCH_PROVIDERS, autoContinueList, limitEvent, CREDIT_GATE_THRESHOLD, HOOK_EVENTS, gitlabCheck, NOTIFY_KINDS, NOTIFY_CHAT_KINDS, NOTIFY_SCHEDULE_KINDS, SERVICES_HOST_GATEWAY, NEXT } from "./state.mjs";

// The stages of the size guideline, as the real server delivers them (dynworkflows/size.js SIZES).
const DYNWF_SIZES = ["small", "medium", "large", "unrestricted"];

// Auto-archive of chats. The state lives HERE and not in `state.mjs` (that file sits at the 2,000-line guard);
// `/fixture/reset-run` resets it via `resetChatAutoArchive`. Default as on the real server: nothing stored means off, 30 days.
const CHAT_AUTO_ARCHIVE_DEFAULT = { enabled: false, days: 30 };
let chatAutoArchive = { ...CHAT_AUTO_ARCHIVE_DEFAULT };
export function resetChatAutoArchive() {
  chatAutoArchive = { ...CHAT_AUTO_ARCHIVE_DEFAULT };
}

// Account self-deletion, as server/gateway/index.js answers POST /gw/account/delete: the body is EXACTLY the contract's key list
// (ACCOUNT_DELETE_FIELDS in server/gateway/administration-contract.js — web/test/administration-binding.test.mjs pins this literal
// to it), otherwise 400. `POST /fixture/account-delete { mode }` picks the answer: "202" deleted (the default), "403" wrong password,
// "409" last admin with other users; `GET` reads the mode and every body received. `/fixture/reset-run` resets it.
const ACCOUNT_DELETE_KEYS = ["password"];
const ACCOUNT_DELETE_MODES = ["202", "403", "409"];
let accountDelete = { mode: "202", bodies: [] };
export function resetAccountDelete() {
  accountDelete = { mode: "202", bodies: [] };
}

// The server's version and API range in `GET /gw/info` (VERSIONING.md "API level"; the app's side is
// mobile/CbaseMobile/Models/ApiContract.swift). `POST /fixture/server-api { variant }` picks the server the app meets:
// "current" (the default: a build record and `api: { level: 1, oldest: 1 }`), "old" (a server from before the contract —
// none of the version fields), "newer" (`oldest: 2` — it no longer accepts the app's level 1 → blocking screen) and "older"
// (`level: 0` — older than the app → soft notice). The app reads /gw/info at LAUNCH (and again when Settings opens), so a
// test sets the variant in the `preparation` of `launchApp` — or later, to meet a server updated while the app runs; `/fixture/reset-run` returns to "current". An optional `build` replaces the variant's build id —
// the app remembers a dismissed older-server notice per server AND build, so a test that proves the memory gives each run a
// build of its own (otherwise a dismissal from an earlier run would make the proof pass without the app remembering anything).
// Beside it, the fixture remembers how the app named itself on its last request (`X-Cbase-Client`, `User-Agent`; requests to
// /fixture/ — the test runner's — do not count): `GET /fixture/client`.
const SERVER_API_BUILD = { build: "0.2.0+3.gabc1234", commit: "abc1234def5678901234567890abcdef12345678", release: "20261123-1795000000000" };
const SERVER_API_VARIANTS = {
  current: { version: "0.2.0", ...SERVER_API_BUILD, api: { level: 1, oldest: 1 }, gatewayVersion: "0.2.0" },
  old: { version: "0.1.0" },
  newer: { version: "0.9.0", ...SERVER_API_BUILD, build: "0.9.0", api: { level: 2, oldest: 2 }, gatewayVersion: "0.9.0" },
  older: { version: "0.1.5", ...SERVER_API_BUILD, build: "0.1.5", api: { level: 0, oldest: 0 }, gatewayVersion: "0.1.5" },
};
let serverApiVariant = "current";
let serverApiBuild = null;
let lastClient = { client: null, userAgent: null, path: null, requests: 0 };
export function resetServerApi() {
  serverApiVariant = "current";
  serverApiBuild = null;
}
function serverApiInfo() {
  const info = { ...SERVER_API_VARIANTS[serverApiVariant] };
  if (serverApiBuild && "build" in info) info.build = serverApiBuild;
  return info;
}
/** Called by the entry (`../chat-gateway.mjs`) for EVERY request before the routers. */
export function recordClient(req, path) {
  if (path.startsWith("/fixture/")) return;
  const header = req.headers["x-cbase-client"];
  lastClient = {
    client: typeof header === "string" ? header : null,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    path,
    requests: lastClient.requests + 1,
  };
}

// Administration: users and resources per user container, shapes as in the contract server/gateway/administration-contract.js
// (SERVER_FIELDS, USER_FIELDS, ENV_ADDITION_FIELDS). The state lives in `S.administration` (null = not seeded yet — `resetSettings`
// resets it) and is seeded on the first read. The server is computed as in the gateway: allocated = sum of the RAM limits,
// overcommitted = allocated > total - reserve.
const GIB = 1024 ** 3;
const VW_WEIGHT = { low: 50, normal: 100, up: 200 };
const VW_HOST = { threads: 16, ramTotalBytes: 64 * GIB, reserveBytes: 6 * GIB };
const VW_BUFFER = 512 * 1024 * 1024;
function vwUser(id, username, role, state, resources, ramBytes, extra = {}) {
  const n = {
    id, username, role, locked: false, createdAt: 1789000000000, itself: username === "mobile-fixture",
    container: { state, since: state === "missing" ? null : "2026-10-15T07:30:00.000Z" },
    resources, actual: null, consumption: null, deviating: false, ...extra,
  };
  vwIs(n);
  if (state === "running") n.consumption = { ramBytes: Math.round(ramBytes), cpuThreads: 0.4 };
  return n;
}
// What the container carries: from the stored values, unless the user already carries its `actual` (the deviation of the seed).
function vwIs(n) {
  if (n.container.state === "missing") { n.actual = null; return; }
  if (n.deviating && n.actual) return;
  n.actual = { ramBytes: n.resources.ramGiB * GIB, cpuMax: n.resources.cpuMax, cpuWeight: VW_WEIGHT[n.resources.cpuPrio] };
}
function administrationStatus() {
  if (!S.administration) {
    S.administration = [
      vwUser("u-fixture", "mobile-fixture", "admin", "running", { ramGiB: 16, cpuPrio: "normal", cpuMax: null }, 5.2 * GIB),
      vwUser("u-mara", "mara", "user", "running", { ramGiB: 24, cpuPrio: "up", cpuMax: 8 }, 11.5 * GIB, {
        deviating: true, actual: { ramBytes: 16 * GIB, cpuMax: null, cpuWeight: 100 },
      }),
      vwUser("u-jonas", "jonas", "user", "stopped", { ramGiB: 8, cpuPrio: "low", cpuMax: 2 }, 0),
      vwUser("u-new", "fresh", "user", "missing", { ramGiB: 8, cpuPrio: "normal", cpuMax: null }, 0, { locked: true }),
    ];
  }
  const allocated = S.administration.reduce((a, n) => a + n.resources.ramGiB * GIB, 0);
  return {
    server: { ...VW_HOST, ramAllocatedBytes: allocated, overcommitted: allocated > VW_HOST.ramTotalBytes - VW_HOST.reserveBytes },
    user: S.administration,
  };
}
// The rule of the gateway (server/gateway/resources.js `lastAdmin`): only ACTIVE admins are counted — a locked admin holds no
// other one in place, and demoting one is allowed.
const vwLastAdmin = (n) => {
  const active = S.administration.filter((x) => x.role === "admin" && !x.locked);
  return active.length === 1 && active[0] === n;
};

async function routesAdministration(req, res, path, method, url) {
  if (path === "/gw/admin/administration" && method === "GET") return json(res, 200, administrationStatus());
  if (path === "/gw/env" && method === "GET") {
    const n = administrationStatus().user.find((x) => x.itself);
    return json(res, 200, { state: "running", startedAt: n.container.since, resources: n.resources, actual: n.actual, consumption: n.consumption });
  }
  if (path === "/gw/admin/users" && method === "POST") {
    const b = await body(req);
    const username = String(b.username || "").trim();
    if (!username || !b.password || !["user", "admin"].includes(b.role)) return json(res, 400, { error: "username, password and role are required" });
    if (administrationStatus().user.some((n) => n.username === username)) return json(res, 409, { error: "Username taken" });
    S.administration.push(vwUser(`u-${username}`, username, b.role, "missing", { ramGiB: 8, cpuPrio: "normal", cpuMax: null }, 0));
    return json(res, 200, { ok: true, id: `u-${username}` });
  }
  const m = path.match(/^\/gw\/admin\/users\/([^/]+)(?:\/(resources|password|start|restart|stop))?$/);
  if (!m) return NEXT;
  const n = administrationStatus().user.find((x) => x.id === decodeURIComponent(m[1]));
  if (!n) return json(res, 404, { error: "Unknown user" });
  const what = m[2];
  if (!what && method === "DELETE") {
    if (n.itself) return json(res, 400, { error: "own account cannot be deleted" });
    if (!["0", "1"].includes(url.searchParams.get("purge"))) return json(res, 400, { error: "purge missing" });
    S.administration = S.administration.filter((x) => x !== n);
    return json(res, 200, { ok: true });
  }
  if (!what && method === "PATCH") {
    // EXACTLY one of the two keys (PATCH_FIELDS) — none or both is a 400, as in the gateway.
    const b = await body(req);
    const fields = ["role", "locked"].filter((k) => k in b);
    if (fields.length !== 1) return json(res, 400, { error: "exactly one of the fields role, locked" });
    if (fields[0] === "role") {
      if (!["user", "admin"].includes(b.role)) return json(res, 400, { error: "role: one of user, admin" });
      if (b.role !== "admin" && vwLastAdmin(n)) {
        return json(res, 400, { error: "The last active admin cannot be demoted — make someone else an admin first." });
      }
      n.role = b.role;
    } else {
      if (typeof b.locked !== "boolean") return json(res, 400, { error: "locked: true or false" });
      if (n.itself && b.locked) return json(res, 400, { error: "own account cannot be locked" });
      if (b.locked && vwLastAdmin(n)) return json(res, 400, { error: "The last active admin cannot be locked." });
      n.locked = b.locked;
    }
    return json(res, 200, n);
  }
  if (what === "password" && method === "POST") {
    const b = await body(req);
    if (!b.password) return json(res, 400, { error: "password: text" });
    return json(res, 200, { ok: true });
  }
  if (what === "resources" && method === "PUT") {
    const b = await body(req);
    // All three keys (RESOURCE_FIELDS), `cpuMax` also as null — a missing key is a 400, not a default.
    if (!["ramGiB", "cpuPrio", "cpuMax"].every((k) => k in b)) return json(res, 400, { error: "ramGiB, cpuPrio and cpuMax are required" });
    if (!Number.isInteger(b.ramGiB) || b.ramGiB < 2 || !(b.cpuPrio in VW_WEIGHT)) return json(res, 400, { error: "Invalid values" });
    if (b.cpuMax !== null && !(Number.isInteger(b.cpuMax) && b.cpuMax >= 1 && b.cpuMax <= VW_HOST.threads)) return json(res, 400, { error: "cpuMax invalid" });
    const consumption = n.consumption?.ramBytes;
    if (consumption != null && b.ramGiB * GIB < consumption + VW_BUFFER) {
      return json(res, 409, { error: `Below the consumption (${(consumption / GIB).toFixed(1)} GiB) plus 512 MiB headroom.`, consumptionBytes: consumption });
    }
    n.resources = { ramGiB: b.ramGiB, cpuPrio: b.cpuPrio, cpuMax: b.cpuMax };
    n.deviating = false;
    vwIs(n);
    return json(res, 200, n);
  }
  if (["start", "restart", "stop"].includes(what) && method === "POST") {
    // As in the gateway: a locked user gets no container (stopping works) — a 409 with plain text.
    if (what !== "stop" && n.locked) return json(res, 409, { error: "The user is locked — unlock first, then start." });
    n.container = { state: what === "stop" ? "stopped" : "running", since: "2026-10-15T09:00:00.000Z" };
    n.deviating = false;
    vwIs(n);
    n.consumption = n.container.state === "running" ? { ramBytes: 0.8 * GIB, cpuThreads: 0.1 } : null;
    return json(res, 200, n);
  }
  return NEXT;
}

export async function routesSettings(ctx) {
  const { req, res, url, path, method } = ctx;
    if (path.startsWith("/gw/admin/") || path === "/gw/env") {
      const response = await routesAdministration(req, res, path, method, url);
      if (response !== NEXT) return response;
    }
    if (path === "/gw/info" && method === "GET") {
      return json(res, 200, {
        gateway: true,
        setup: false,
        authenticated: true,
        user: { username: "mobile-fixture", role: "admin" },
        ...serverApiInfo(),
      });
    }
    if (path === "/fixture/server-api" && method === "POST") {
      const b = (await body(req)) || {};
      if (!Object.hasOwn(SERVER_API_VARIANTS, b.variant)) {
        return json(res, 400, { error: `variant: one of ${Object.keys(SERVER_API_VARIANTS).join(", ")}` });
      }
      serverApiVariant = b.variant;
      serverApiBuild = typeof b.build === "string" && b.build ? b.build : null;
      return json(res, 200, { variant: serverApiVariant, info: serverApiInfo() });
    }
    if (path === "/fixture/client" && method === "GET") return json(res, 200, { ...lastClient });
    // Notifications. The line (`/gw/push`) belongs to the gateway, the rules (`/api/notify`) to the backend — the app asks
    // for both, so the fixture serves both.
    if (path === "/gw/push" && method === "GET") {
      return json(res, 200, {
        sandbox: true, production: false, deviceCount: S.pushDevices.length,
        devices: S.pushDevices.map((d) => ({ ...d })),
      });
    }
    // The host behind the gateway (services button of the header). Only with `/fixture/services { on: true }` and the source
    // "gateway" — otherwise the route does not answer (404 from the entry) and the app shows NO machine: it no longer reads
    // the `host` field of the resources, like the web in gateway mode.
    if (path === "/gw/host" && method === "GET" && S.services && S.servicesMachine === "gateway") {
      return json(res, 200, { ...SERVICES_HOST_GATEWAY, at: Date.now() });
    }
    if (path === "/gw/push/test" && method === "POST") {
      S.pushTests += 1;
      if (!S.pushDevices.length) return json(res, 200, { devices: [], reason: "no device registered" });
      return json(res, 200, {
        devices: S.pushDevices.map((d) => ({ environment: d.environment, status: 200, reason: "", ok: true })),
        reason: "",
      });
    }
    // Adjust: reword marked text after an instruction — the answer is a fixed transformation ("jo, " + lower case), so the
    // test recognises the result on the clipboard. The instructions are remembered as on the real server (most recently
    // used first, same text = same entry, title changeable).
    if (path === "/api/adjust/prompts" && method === "GET") {
      return json(res, 200, { items: S.adjustPrompts.slice().sort((a, b) => b.used - a.used), max: 20 });
    }
    const adjustPromptMatch = path.match(/^\/api\/adjust\/prompts\/([^/]+)$/);
    if (adjustPromptMatch && method === "PATCH") {
      const b = await body(req);
      const e = S.adjustPrompts.find((x) => x.id === adjustPromptMatch[1]);
      if (!e) return json(res, 404, { error: "Instruction not found" });
      if (typeof b.title === "string") e.title = b.title.trim() || e.prompt.slice(0, 40);
      if (typeof b.prompt === "string") { if (!b.prompt.trim()) return json(res, 400, { error: "prompt empty" }); e.prompt = b.prompt.trim(); }
      return json(res, 200, e);
    }
    if (adjustPromptMatch && method === "DELETE") {
      const prior = S.adjustPrompts.length;
      S.adjustPrompts = S.adjustPrompts.filter((x) => x.id !== adjustPromptMatch[1]);
      if (S.adjustPrompts.length === prior) return json(res, 404, { error: "Instruction not found" });
      return json(res, 200, { ok: true, items: S.adjustPrompts });
    }
    if (path === "/api/adjust" && method === "POST") {
      const b = await body(req);
      const text = String(b.text || "");
      if (!text.trim()) return json(res, 400, { error: "text missing" });
      let e = null;
      if (b.promptId) {
        e = S.adjustPrompts.find((x) => x.id === b.promptId);
        if (!e) return json(res, 404, { error: "Instruction not found" });
      } else {
        const prompt = String(b.prompt || "").trim();
        if (!prompt) return json(res, 400, { error: "Instruction missing" });
        e = S.adjustPrompts.find((x) => x.prompt === prompt);
        if (!e) { e = { id: `anp-${++S.adjustSeq}`, title: "", prompt, used: 0, created: Date.now() }; S.adjustPrompts.push(e); }
        if (typeof b.title === "string" && b.title.trim()) e.title = b.title.trim();
        if (!e.title) e.title = prompt.length > 40 ? prompt.slice(0, 39).trimEnd() + "…" : prompt;
      }
      e.used = Math.max(Date.now(), ...S.adjustPrompts.map((x) => x.used + 1));
      S.adjustLast = { text, prompt: e.prompt, promptId: e.id, n: ++S.adjustCounter };
      return json(res, 200, { fresh: "jo, " + text.trim().toLowerCase().replace(/\.$/, ""), model: "fixture-adjuster", promptId: e.id, title: e.title });
    }
    // App agents: model AND level per key in ONE row, each half only if announced — as in settings/routes.js. `efforts`
    // ("" = default) and `effective` are the two maps the page reads.
    if (path === "/api/agent-models" && method === "GET") {
      const agents = {}, efforts = {}, effective = {};
      for (const k of AGENT_MODEL_KEYS) {
        const z = S.agentModels[k] || {};
        agents[k] = z.provider && z.model ? { provider: z.provider, model: z.model } : null;
        efforts[k] = z.effort || "";
        effective[k] = agentEffective(k);
      }
      return json(res, 200, { agents, defaults: {}, efforts, effective, lastPut: S.agentModelsPut });
    }
    if (path === "/api/agent-models" && method === "PUT") {
      const b = await body(req);
      const key = String(b.key || "");
      if (!AGENT_MODEL_KEYS.includes(key)) return json(res, 400, { error: "unknown agent key" });
      const modelAnnounced = b.provider !== undefined || b.model !== undefined;
      const levelAnnounced = b.effort !== undefined;
      if (!modelAnnounced && !levelAnnounced) return json(res, 400, { error: "model or effort missing" });
      if (levelAnnounced && b.effort !== "" && !["low", "medium", "high", "xhigh", "max"].includes(b.effort)) return json(res, 400, { error: "unknown effort" });
      S.agentModelsPut[key] = b;
      const old = S.agentModels[key] || {};
      const fresh = {};
      if (modelAnnounced) { if (b.provider && b.model) Object.assign(fresh, { provider: String(b.provider), model: String(b.model) }); }
      else if (old.provider && old.model) Object.assign(fresh, { provider: old.provider, model: old.model });
      const level = levelAnnounced ? b.effort : (old.effort || "");
      if (level) fresh.effort = level;
      S.agentModels[key] = fresh;
      return json(res, 200, { ok: true, value: fresh.provider ? { provider: fresh.provider, model: fresh.model } : null, effort: fresh.effort || "", effective: agentEffective(key) });
    }
    if (path === "/api/autocompact" && method === "GET") {
      return json(res, 200, autocompactDoc());
    }
    if (path === "/api/autocompact" && method === "PUT") {
      const payload = await body(req);
      // As on the real server: both fields can be set SINGLY — the UI has two sliders.
      if ("percent" in payload) {
        const p = Number(payload.percent);
        if (!(p === 0 || AUTOCOMPACT_STAGES.includes(p))) return json(res, 400, { error: "invalid level" });
        S.autocompactPercent = p;
      }
      if ("maxTokens" in payload) {
        const m = Number(payload.maxTokens);
        if (!(m === 0 || AUTOCOMPACT_MAX_STAGES.includes(m))) return json(res, 400, { error: "invalid cap" });
        S.autocompactMax = m;
      }
      return json(res, 200, { ok: true, ...autocompactDoc() });
    }

    // ── Read aloud (ElevenLabs) ───────────────────────────────────────────────
    // The key is stored and used but NEVER returned: the response only says THAT one is set — as on the real server
    // (settings/routes.js, /api/tts/config).
    if (path === "/api/tts/config" && method === "GET") {
      return json(res, 200, {
        hasKey: Boolean(S.ttsConfig.apiKey),
        voiceId: S.ttsConfig.voiceId,
        modelId: S.ttsConfig.modelId,
        baseUrl: S.ttsConfig.baseUrl,
      });
    }
    if (path === "/api/tts/config" && method === "PUT") {
      const b = await body(req);
      // An empty/missing apiKey means "keep" (the view never shows it); an explicit null deletes it. Without this
      // distinction every save of the form wiped the key it does not even show.
      if (b.apiKey === null) S.ttsConfig.apiKey = "";
      else if (typeof b.apiKey === "string" && b.apiKey) S.ttsConfig.apiKey = b.apiKey;
      if (b.voiceId !== undefined) S.ttsConfig.voiceId = String(b.voiceId || "") || "21m00Tcm4TlvDq8ikWAM";
      if (b.modelId !== undefined) S.ttsConfig.modelId = String(b.modelId || "") || "eleven_multilingual_v2";
      if (b.baseUrl !== undefined) S.ttsConfig.baseUrl = String(b.baseUrl || "") || "https://api.elevenlabs.io";
      return json(res, 200, {
        ok: true, hasKey: Boolean(S.ttsConfig.apiKey),
        voiceId: S.ttsConfig.voiceId, modelId: S.ttsConfig.modelId, baseUrl: S.ttsConfig.baseUrl,
      });
    }
    // Voice list of the account — 409 without a key, as on the real server. The test hangs on exactly this: "Load voices"
    // must not be offered without a key.
    if (path === "/api/tts/voices" && method === "GET") {
      if (!S.ttsConfig.apiKey) return json(res, 409, { error: "No ElevenLabs key configured" });
      return json(res, 200, { voices: TTS_VOICES.map((v) => ({ ...v })) });
    }

    // ── Web search of the own harness (WebSearch tool of the loop engine) ─────
    if (path === "/api/web-search" && method === "GET") {
      return json(res, 200, {
        provider: S.webSearch.provider,
        baseUrl: S.webSearch.baseUrl,
        hasKey: Boolean(S.webSearch.apiKey),
        providers: WEB_SEARCH_PROVIDERS,
      });
    }
    if (path === "/api/web-search" && method === "PUT") {
      const b = await body(req);
      // An unknown provider silently falls back to duckduckgo — no 400. Inventing something stricter here would test
      // against behavior that does not exist.
      S.webSearch.provider = WEB_SEARCH_PROVIDERS.includes(b.provider) ? b.provider : "duckduckgo";
      if (b.apiKey === null) S.webSearch.apiKey = "";
      else if (typeof b.apiKey === "string" && b.apiKey) S.webSearch.apiKey = b.apiKey;
      if (b.baseUrl !== undefined) S.webSearch.baseUrl = String(b.baseUrl || "");
      return json(res, 200, {
        ok: true, provider: S.webSearch.provider, baseUrl: S.webSearch.baseUrl, hasKey: Boolean(S.webSearch.apiKey),
      });
    }

    // ── Permanent tool approvals ("do not ask again") ─────────────────────────
    // Notation as in Claude Code's settings.json: "Bash(git status:*)", "Read(src/**)".
    if (path === "/api/permission-rules" && method === "GET") {
      return json(res, 200, { rules: S.permissionRules.slice() });
    }
    if (path === "/api/permission-rules" && method === "PUT") {
      const b = await body(req);
      if (!Array.isArray(b.rules)) return json(res, 400, { error: "expected rules array" });
      // As on the real server (savePermissionRules): trim, drop empty ones, drop duplicates, cap 500.
      S.permissionRules = [...new Set(
        b.rules.map((r) => String(r || "").trim()).filter(Boolean),
      )].slice(0, 500);
      return json(res, 200, { ok: true, rules: S.permissionRules.slice() });
    }

    // ── Auto-continue at the usage limit (global on/off) ──────────────────────
    // NOT to be confused with `/api/chats/:id/auto-continue` below: that is the waiting state of ONE chat, this is the switch
    // for all.
    if (path === "/api/auto-continue" && method === "GET") {
      // The list comes INDEPENDENT of the switch (like `listPendingResumes` on the real server): the rows parked by the gate
      // survive a switched-off auto-continue — a list that answered empty on "off" would hide exactly them.
      return json(res, 200, { enabled: S.autoContinueEnabled, waiting: autoContinueList() });
    }
    if (path === "/api/auto-continue" && method === "PUT") {
      const b = await body(req);
      // Same wording as the real server (settings/routes.js, PUT /api/auto-continue): a missing `enabled` is NOT a statement
      // and is rejected with 400 — the reading below would otherwise turn any body with a foreign field into ON. The error
      // path of the app (`usage-auto-continue-error`) depends on it.
      if (b.enabled === undefined || b.enabled === null) return json(res, 400, { error: "„enabled“ is missing" });
      // Anything except false/"0"/0 means on — same as the real server.
      S.autoContinueEnabled = b.enabled !== false && b.enabled !== "0" && b.enabled !== 0;
      // Off only switches WAITING off: the parked runs are released — EXCEPT those parked by the gate
      // (`reason === "credit"`, same as the real server): they belong to the other switch and keep waiting.
      if (!S.autoContinueEnabled) {
        S.autoContinueWaiting = S.autoContinueWaiting.filter((w) => w.reason === "credit");
        if (S.limitWait && S.limitWait.reason !== "credit") {
          S.limitWait = null;
          limitEvent();
        }
      }
      return json(res, 200, { ok: true, enabled: S.autoContinueEnabled });
    }

    // ── Cap per user of the dynamic workflows ─────────────────────────────────
    // As on the real server: 400 without `cap`, whole number 1–64, `runCap` as a fixed fixture number.
    if (path === "/api/dyn-workflow-cap" && method === "GET") {
      return json(res, 200, { cap: S.dynWfCap, preset: 8, max: 64, runCap: 8 });
    }
    if (path === "/api/dyn-workflow-cap" && method === "PUT") {
      const b = await body(req);
      if (b.cap === undefined || b.cap === null) return json(res, 400, { error: "„deckel“ is missing" });
      const n = Number(b.cap);
      if (!Number.isInteger(n) || n < 1 || n > 64) return json(res, 400, { error: "„deckel“ must be a whole number from 1 to 64" });
      S.dynWfCap = n;
      return json(res, 200, { ok: true, cap: n, preset: 8, runCap: 8 });
    }
    // ── Size guideline of the dynamic workflows ───────────────────────────────
    // As on the real server: 400 without `size`, 400 for an unknown stage; the stages come along.
    if (path === "/api/dyn-workflow-size" && method === "GET") {
      return json(res, 200, { size: S.dynWfSize, preset: "medium", stages: DYNWF_SIZES });
    }
    if (path === "/api/dyn-workflow-size" && method === "PUT") {
      const b = await body(req);
      if (b.size === undefined || b.size === null || b.size === "") return json(res, 400, { error: "„groesse“ is missing" });
      if (!DYNWF_SIZES.includes(b.size)) return json(res, 400, { error: "„groesse“ must be one of small, medium, large, unrestricted" });
      S.dynWfSize = b.size;
      return json(res, 200, { ok: true, size: b.size, preset: "medium" });
    }

    // ── Auto-archive of chats ─────────────────────────────────────────────────
    // As on the real server: BOTH fields required, `enabled` a boolean, `days` a whole number 1–365 — otherwise 400 with
    // wording (a missing field is not a statement). Answer `{ enabled, days }` as stored.
    if (path === "/api/chat-auto-archive" && method === "GET") {
      return json(res, 200, { ...chatAutoArchive });
    }
    if (path === "/api/chat-auto-archive" && method === "PUT") {
      const b = (await body(req)) || {};
      if (typeof b.enabled !== "boolean") return json(res, 400, { error: "„enabled“ is missing or not a boolean" });
      if (!Number.isInteger(b.days) || b.days < 1 || b.days > 365) return json(res, 400, { error: "„tage“ must be a whole number from 1 to 365" });
      chatAutoArchive = { enabled: b.enabled, days: b.days };
      return json(res, 200, { ...chatAutoArchive });
    }

    // ── Credit gate ───────────────────────────────────────────────────────────
    // OWN route beside `/api/auto-continue`, not a second field on it: own default (OFF while auto-continue is ON) and own
    // side effect on switching off. `threshold` comes along so the label in the app keeps no second 99.
    if (path === "/api/credit-gate" && method === "GET") {
      return json(res, 200, { enabled: S.creditGate, threshold: CREDIT_GATE_THRESHOLD, provider: "claude" });
    }
    if (path === "/api/credit-gate" && method === "PUT") {
      const b = await body(req);
      // Same trap as the route above, with the opposite sign: here a missing field would silently mean OFF. That is a
      // decision nobody made either — 400, same wording as the real server.
      if (b.enabled === undefined || b.enabled === null) return json(res, 400, { error: "„enabled“ is missing" });
      // Only true/"1"/1 means ON (the reverse of /api/auto-continue, and exactly the reason for two routes).
      S.creditGate = b.enabled === true || b.enabled === "1" || b.enabled === 1;
      // On switching OFF the real server releases the runs parked by the GATE (they wait for a rule that no longer
      // exists); time-limit waiting rows stay untouched.
      if (!S.creditGate) {
        if (S.limitWait?.gate) {
          S.limitWait = null;
          limitEvent();
        }
        S.autoContinueWaiting = S.autoContinueWaiting.filter((w) => !w.gate);
      }
      return json(res, 200, { ok: true, enabled: S.creditGate, threshold: CREDIT_GATE_THRESHOLD });
    }

    // ── Agent hooks (loop engine): shell commands on tool events ───────────────
    if (path === "/api/agent-hooks" && method === "GET") {
      return json(res, 200, { hooks: S.agentHooks.map((h) => ({ ...h })), events: HOOK_EVENTS });
    }
    if (path === "/api/agent-hooks" && method === "PUT") {
      const b = await body(req);
      if (!Array.isArray(b.hooks)) return json(res, 400, { error: "expected hooks array" });
      for (const h of b.hooks) {
        if (!h || !HOOK_EVENTS.includes(h.event)) return json(res, 400, { error: `unknown event: ${h?.event}` });
        if (typeof h.command !== "string" || !h.command.trim()) return json(res, 400, { error: "command required" });
      }
      S.agentHooks = b.hooks.slice(0, 50).map((h) => ({
        event: h.event, matcher: String(h.matcher || "*"), command: String(h.command),
      }));
      return json(res, 200, { ok: true, hooks: S.agentHooks.map((h) => ({ ...h })) });
    }

    // ── GitLab accounts (basis of the workflow triggers) ──────────────────────
    // The token is stored and used but NEVER returned: the row shows only `hasToken` plus the account name GitLab itself
    // reported.
    if (path === "/api/gitlab/accounts" && method === "GET") {
      return json(res, 200, { accounts: S.gitlabAccounts.map((a) => ({ ...a })) });
    }
    if (path === "/api/gitlab/accounts" && method === "POST") {
      const b = await body(req);
      const host = String(b.host || "https://gitlab.com").trim().replace(/\/+$/, "");
      const token = String(b.token || "").trim();
      // Check first, then store — as on the real server: an account that does not work helps nobody. The fixture checks
      // the FORM here, not reachability.
      if (!/^https?:\/\/[^/]+$/.test(host)) return json(res, 400, { error: "Invalid host (e.g. https://gitlab.com)." });
      if (!token) return json(res, 400, { error: "Access token required." });
      // A token that does not start with "glpat-" counts as rejected here. That way the error path of the view can be
      // tested without a real GitLab server.
      const response = gitlabCheck(null, token);
      if (!response.ok) return json(res, 400, { error: response.error });
      S.gitlabSeq += 1;
      const now = Date.now();
      const acc = {
        // Counted and left-padded, not glued into a fixed string: from the tenth account on `…-00000000000${gitlabSeq}`
        // would give a thirteen-digit last segment, i.e. no UUID any more.
        id: `a0000000-0000-4000-8000-${String(S.gitlabSeq).padStart(12, "0")}`,
        label: String(b.label || "").slice(0, 80) || host.replace(/^https?:\/\//, ""),
        host, userName: response.userName, userId: response.userId, hasToken: true, status: "",
        checkedAt: now, createdAt: now, updatedAt: now,
      };
      S.gitlabAccounts.push(acc);
      S.gitlabTokens.set(acc.id, token);
      return json(res, 201, acc);
    }
    {
      const gam = path.match(/^\/api\/gitlab\/accounts\/([0-9a-f-]+)$/);
      if (gam) {
        // As on the real server: the unknown id is rejected here, before the question of the method — otherwise a deleted
        // account would get a "route not found".
        const acc = S.gitlabAccounts.find((a) => a.id === gam[1]);
        if (!acc) return json(res, 404, { error: "Account not found" });
        if (method === "PATCH") {
          const b = await body(req);
          // Build a field bundle first, then check, then write — the real server works in exactly this order. The difference
          // is visible: whoever sends a name AND a bad token in ONE call gets a 400 here and afterwards finds the OLD name.
          // A fixture that set the label before the check would turn a failed change into a half-done one.
          const fields = {};
          let newToken = "";
          if (typeof b.label === "string") fields.label = b.label.slice(0, 80);
          if (typeof b.host === "string" && b.host.trim()) {
            const host = b.host.trim().replace(/\/+$/, "");
            if (!/^https?:\/\/[^/]+$/.test(host)) return json(res, 400, { error: "Invalid host." });
            fields.host = host;
          }
          // An empty token field = keep the token (as with the provider keys).
          if (typeof b.token === "string" && b.token.trim()) newToken = b.token.trim();
          if (fields.host || newToken) {
            // Checked with the token that is to apply AFTERWARDS. A freshly typed one is never the revoked one: the revocation
            // hangs on the old access, and replacing a token is exactly the action that lifts it — hence without account id.
            const response = newToken
              ? gitlabCheck(null, newToken)
              : gitlabCheck(acc.id, S.gitlabTokens.get(acc.id));
            if (!response.ok) return json(res, 400, { error: response.error });
            // After a token swap the account name is rewritten: another token can belong to another GitLab user, and the row
            // would otherwise claim the old one.
            Object.assign(fields, {
              userName: response.userName, userId: response.userId, status: "", checkedAt: Date.now(),
            });
          }
          if (newToken) {
            S.gitlabTokens.set(acc.id, newToken);
            S.gitlabRevoked.delete(acc.id);
            fields.hasToken = true;
          }
          Object.assign(acc, fields, { updatedAt: Date.now() });
          return json(res, 200, { ...acc });
        }
        if (method === "DELETE") {
          S.gitlabAccounts = S.gitlabAccounts.filter((a) => a.id !== acc.id);
          // The token goes with the account — otherwise an account created later under the same id would inherit an access
          // nobody entered.
          S.gitlabTokens.delete(acc.id);
          S.gitlabRevoked.delete(acc.id);
          return json(res, 200, { ok: true });
        }
      }
      // Check the connection again (button on the account row). ALWAYS answers 200 — also on failure (`ok:false` + `error`);
      // the real server does the same because a rejected token is no HTTP error of this route.
      //
      // Both branches are here, and the second is the more important one: the app decides by the field `ok` and expressly
      // not by the status code. A fixture that always answered `{ok:true}` would leave exactly the place unchecked where it
      // is built correctly — an app that blindly listens to 200 would pass. The error branch is triggered with
      // `POST /fixture/gitlab { id, valid: false }`.
      const gtm = path.match(/^\/api\/gitlab\/accounts\/([0-9a-f-]+)\/test$/);
      if (gtm && method === "POST") {
        const acc = S.gitlabAccounts.find((a) => a.id === gtm[1]);
        if (!acc) return json(res, 404, { error: "Account not found" });
        S.gitlabTests += 1;
        const response = gitlabCheck(acc.id, S.gitlabTokens.get(acc.id));
        acc.checkedAt = Date.now();
        if (!response.ok) {
          // The message goes to the account, as on the real server: the view reloads the list after every check run, and the
          // red row comes from there — not from the response.
          acc.status = response.error;
          return json(res, 200, { ok: false, error: response.error });
        }
        acc.status = "";
        acc.userName = response.userName;
        acc.userId = response.userId;
        return json(res, 200, { ok: true, userName: acc.userName, name: response.name, webUrl: `${acc.host}/${acc.userName}` });
      }
      // Project/group search of the trigger settings — for completeness, so the view does not run into the 404 fallback
      // midway.
      const gpm = path.match(/^\/api\/gitlab\/accounts\/([0-9a-f-]+)\/(projects|groups)$/);
      if (gpm && method === "GET") {
        if (!S.gitlabAccounts.some((a) => a.id === gpm[1])) return json(res, 404, { error: "Account not found" });
        return json(res, 200, {
          items: gpm[2] === "projects"
            ? [{ id: 1, pathWithNamespace: "geo/frontend", name: "frontend" }]
            : [{ id: 9, fullPath: "geo", name: "Geo" }],
        });
      }
    }

    // The free third-party providers (`/api/presets`, `/api/provider-configs*`, `/api/provider-models`) no longer exist —
    // OpenRouter is fixed, its routes are in routes-usage.mjs.

    // Default level per provider — as on the server: 400 without `effort` or with an unknown level, "" back to the preset.
    // `/api/providers` then delivers it as `defaultEffort`; `GET /fixture/default-level` reads the stored state for the XCUITest.
    if (path === "/api/default-effort" && method === "PUT") {
      const b = (await body(req)) || {};
      if (!["codex", "claude", "openrouter", "flat"].includes(b.provider)) return json(res, 400, { error: "unknown provider" });
      if (b.effort === undefined) return json(res, 400, { error: "The field “effort” is missing." });
      if (b.effort !== "" && !["low", "medium", "high", "xhigh", "max"].includes(b.effort)) return json(res, 400, { error: `Unknown effort level “${b.effort}”.` });
      S.defaultLevel[b.provider] = b.effort;
      return json(res, 200, { ok: true, provider: b.provider, effort: defaultLevelOf(b.provider) });
    }
    if (path === "/fixture/default-level" && method === "GET") {
      return json(res, 200, { set: { ...S.defaultLevel }, codex: defaultLevelOf("codex"), claude: defaultLevelOf("claude") });
    }
    if (path === "/api/notify" && method === "GET") {
      return json(res, 200, {
        kinds: NOTIFY_KINDS.map((a) => ({ ...a, value: S.notifyGlobal[a.key] ?? a.preset })),
        chatKinds: NOTIFY_CHAT_KINDS,
        scheduleKinds: NOTIFY_SCHEDULE_KINDS,
      });
    }
    if (path === "/api/notify" && method === "PUT") {
      const payload = await body(req);
      for (const a of NOTIFY_KINDS) if (a.key in (payload || {})) S.notifyGlobal[a.key] = Boolean(payload[a.key]);
      return json(res, 200, { ok: true, values: S.notifyGlobal });
    }
    if (path === "/gw/env/ensure" && method === "POST") return json(res, 200, { ready: true });
    if (path === "/gw/logout" && method === "POST") return json(res, 200, { ok: true });
    if (path === "/fixture/account-delete" && method === "POST") {
      const b = (await body(req)) || {};
      if (!ACCOUNT_DELETE_MODES.includes(b.mode)) return json(res, 400, { error: `mode: one of ${ACCOUNT_DELETE_MODES.join(", ")}` });
      accountDelete.mode = b.mode;
      return json(res, 200, { ok: true, mode: accountDelete.mode });
    }
    if (path === "/fixture/account-delete" && method === "GET") {
      return json(res, 200, { mode: accountDelete.mode, bodies: accountDelete.bodies.map((b) => b) });
    }
    if (path === "/gw/account/delete" && method === "POST") {
      const b = await body(req);
      accountDelete.bodies.push(b);
      const keys = b && typeof b === "object" && !Array.isArray(b) ? Object.keys(b) : [];
      if (keys.join(",") !== ACCOUNT_DELETE_KEYS.join(",") || typeof b.password !== "string" || !b.password) {
        return json(res, 400, { error: `the body is exactly ${ACCOUNT_DELETE_KEYS.join(", ")}` });
      }
      if (accountDelete.mode === "403") return json(res, 403, { error: "Wrong password", code: "PASSWORD" });
      if (accountDelete.mode === "409") {
        return json(res, 409, { error: "You are the last active admin — make someone else an admin first, then delete your account.", code: "LAST_ADMIN" });
      }
      return json(res, 202, { ok: true });
    }
    if (path === "/api/health" && method === "GET") return json(res, 200, { ok: true });
    return NEXT;
}
