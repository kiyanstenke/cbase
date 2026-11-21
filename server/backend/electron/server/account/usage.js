// Usage and credit of the Claude account: credentials (keychain, credentials file, refresh), usage cache with
// backoff, requestClaudeUsage, fetchUsageLimits. The module-wide `let`s are assigned only here.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanClaudeEnv } from "../claude.js";
import * as limits from "../limits.js";
import * as store from "../store.js";
import { T } from "../i18n.js";


// ── Usage limits (claude.ai subscription) ─────────────────────────────────────────────
// Calls `claude auth …` (status/logout). Callback-based execFile → promise.
function claudeAuth(args) {
  return new Promise((resolve) => {
    // Call without the .env token/API key — otherwise the status does not reflect the real
    // keychain login.
    execFile(process.env.CLAUDE_BIN || "claude", args, { timeout: 15_000, env: cleanClaudeEnv() }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

// Reads Claude Code's OAuth token and queries the usage endpoint (5 h / 7 day windows). 60 s cache — the top
// navigation polls regularly. The last successful value is PERSISTED in app_settings: the endpoint likes to answer
// 429 (rate limit), and right after a restart the cache would otherwise be empty → the ring would be missing for
// minutes. Slightly stale utilization is better than none.
let usageCache = { at: 0, data: null };
// The raw text last read FROM app_settings — see the comment in `fetchUsageLimits`.
let usagePersisted = null;
let usageBackoffUntil = 0; // after a 429, do not query the endpoint again for a while
// Claude Code's credentials: token PLUS expiry. The OAuth token only lives for a few hours — without knowing
// the expiry the server would happily send a dead token and the usage ring would disappear (HTTP 401).
function parseClaudeCredential(raw) {
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return { token: oauth.accessToken, expiresAt: Number(oauth.expiresAt) || 0 };
  } catch { return null; }
}
function keychainCredential() {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") return resolve(null);
    // SEVERAL entries can live under this service: one holds only MCP logins (`mcpOAuth`),
    // another the account token (`claudeAiOauth`). Without `-a`, `security` returns the first
    // one it finds — which may be the one without the account token. So first ask for the
    // signed-in user's account specifically, then without an account filter.
    let user = process.env.USER || "";
    try { user = os.userInfo().username || user; } catch {}
    const accounts = [user, ""].filter((value, index, all) => value !== undefined && all.indexOf(value) === index);
    const attempt = (index) => {
      if (index >= accounts.length) return resolve(null);
      const args = ["find-generic-password", "-w", "-s", "Claude Code-credentials"];
      if (accounts[index]) args.push("-a", accounts[index]);
      execFile("security", args, { timeout: 5_000 }, (err, stdout) => {
        const cred = err ? null : parseClaudeCredential(stdout);
        if (cred) return resolve(cred);
        attempt(index + 1);
      });
    };
    attempt(0);
  });
}
// Access token for the Anthropic usage endpoint. Sources in this order:
//  1. macOS keychain — where the Claude Code login of a backend on the Mac lives (local runs only;
//     the suites replace `security`, check.mjs).
//  2. ~/.claude/.credentials.json — on Linux (and thus in the per-user container) there is NO keychain;
//     `claude auth login` creates the file. Without this source /api/usage would always answer 503 in
//     client/server operation and the usage ring would be missing in EVERY client.
//  3. CLAUDE_CODE_OAUTH_TOKEN — the second login kind supported in the container.
// In front of these stands the shared login directory `$CLAUDE_SECURESTORAGE_CONFIG_DIR/.credentials.json` — ONLY when
// the variable is set (image ENV of the user container; on the Mac it does not exist, there the keychain stays).
// entry.sh moves the file there at start and the CLI writes it there from then on. An empty value means "~/.claude"
// to the CLI, and the list checks exactly that place anyway.
export function credentialsCandidates(env = process.env, home = os.homedir()) {
  const login = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  return [
    ...(login ? [path.join(login, ".credentials.json")] : []),
    path.join(home, ".claude", ".credentials.json"),
    path.join(home, ".config", "claude", ".credentials.json"),
  ];
}
export function credentialsFileCredential() {
  const candidates = credentialsCandidates();
  for (const file of candidates) {
    try {
      const cred = parseClaudeCredential(fs.readFileSync(file, "utf8"));
      if (cred) return cred;
    } catch {}
  }
  return null;
}
async function claudeUsageCredential() {
  const cred = (await keychainCredential()) || credentialsFileCredential();
  if (cred) return cred;
  // Static token from the environment: no known expiry (expiresAt 0) → it is never renewed
  // proactively; a 401 still triggers one attempt.
  return process.env.CLAUDE_CODE_OAUTH_TOKEN ? { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, expiresAt: 0 } : null;
}
// Have an expired OAuth token renewed. IMPORTANT: the CLI does the refresh, not this server. A refresh of our
// own would rotate the refresh token behind the CLI's back and log the user out of Claude Code. `claude doctor`
// renews the credentials at start and spends NO model request doing so.
let credentialRefreshAt = 0;
let credentialRefreshInflight = null;
function refreshClaudeCredentials() {
  if (credentialRefreshInflight) return credentialRefreshInflight;
  // Cooldown: if the refresh fails (expired refresh token, no login), the clients' 45 s poll
  // must not start one CLI per call forever.
  if (Date.now() - credentialRefreshAt < 120_000) return Promise.resolve();
  credentialRefreshAt = Date.now();
  credentialRefreshInflight = new Promise((resolve) => {
    execFile(process.env.CLAUDE_BIN || "claude", ["doctor"], {
      timeout: 60_000, cwd: os.homedir(), env: cleanClaudeEnv(),
    }, () => resolve());
  }).finally(() => { credentialRefreshInflight = null; });
  return credentialRefreshInflight;
}
// How long not to ask again after a 429. The endpoint names the real lock in `Retry-After`, and every request
// before it keeps the lock open. So the header applies — seconds or an HTTP date —, at least 90 s, at most
// 30 min (an absurd value must not freeze the ring for a day).
export function usageBackoffMs(retryAfter, now = Date.now()) {
  const MIN = 90_000, MAX = 30 * 60_000;
  const raw = String(retryAfter ?? "").trim();
  let ms = NaN;
  if (/^\d+(\.\d+)?$/.test(raw)) ms = Number(raw) * 1_000;
  else if (raw) { const t = Date.parse(raw); if (Number.isFinite(t)) ms = t - now; }
  if (!Number.isFinite(ms)) return MIN;
  return Math.min(MAX, Math.max(MIN, Math.ceil(ms)));
}
function requestClaudeUsage(token) {
  // Hard timeout: a hanging request (network/sleep) must not block the polls for minutes —
  // rather fail fast and serve the cache.
  return fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(8_000),
  });
}
// at:0 → a live attempt is still made immediately; the persisted value only serves as a fallback in case that
// fails (e.g. with 429). The rule is in the comment of `fetchUsageLimits`.
function persistedReload() {
  if (usageCache.data && usageCache.at !== 0) return;
  try {
    const raw = store.getSetting("usage_cache_v1");
    if (raw && raw !== usagePersisted) {
      usagePersisted = raw;
      usageCache = { at: 0, data: JSON.parse(raw) };
    }
  } catch {}
}
// The state cbase currently knows — WITHOUT a network call, without refreshing the token. For the sweeper of the
// wait rows (runs/auto-continue.js), which checks every minute whether a NEWER measurement shows the credit gate open:
// it must not ask the provider itself (the endpoint locks quickly with 429, and an expired token would start
// `claude doctor`). Whoever asks anyway keeps the state fresh — the clients' poll, the gate, the wakeup. When it was
// measured is in `data.at` (null = never measured).
function usageInMemory() {
  persistedReload();
  return usageCache.data;
}
async function fetchUsageLimits({ force = false } = {}) {
  // Look again AS LONG AS we sit on the fallback (`at === 0` means: no successful live fetch yet). A CHANGED raw
  // text is adopted — a state another path writes to `app_settings` later would otherwise stay invisible for the
  // life of the process, and a test could not RENEW its seed. A state fetched live (`at > 0`) is never
  // overwritten — it is fresher than anything stored. After the first successful fetch this line costs nothing.
  persistedReload();
  // force: auto-continue at the limit needs the state as of NOW. A cache up to 60 s old still shows
  // "56 %" after a limit hit — chooseWait would then find no exhausted window and the run would
  // probe blindly instead of waiting for the real reset.
  if (!force && Date.now() - usageCache.at < 60_000 && usageCache.data) return usageCache.data;
  if (Date.now() < usageBackoffUntil) {
    // Cooldown after 429: do NOT query the endpoint again (it only extends the rate limit) —
    // serve the cache, fail fast without one.
    if (usageCache.data) return usageCache.data;
    throw new Error(T("Usage endpoint: rate limit (429), waiting for the cooldown"));
  }
  try {
    let cred = await claudeUsageCredential();
    if (!cred) throw new Error(T("No Claude Code token found (keychain, $CLAUDE_SECURESTORAGE_CONFIG_DIR/.credentials.json, ~/.claude/.credentials.json, CLAUDE_CODE_OAUTH_TOKEN)"));
    if (cred.expiresAt && cred.expiresAt <= Date.now() + 60_000) {
      await refreshClaudeCredentials();
      cred = (await claudeUsageCredential()) || cred;
    }
    let r = await requestClaudeUsage(cred.token);
    if (r.status === 401) {
      // Token no longer valid after all (unknown expiry, revoked server-side):
      // have it renewed once and retry exactly once — never in a loop.
      await refreshClaudeCredentials();
      const fresh = await claudeUsageCredential();
      if (fresh && fresh.token !== cred.token) r = await requestClaudeUsage(fresh.token);
    }
    if (r.status === 429) usageBackoffUntil = Date.now() + usageBackoffMs(r.headers.get("retry-after"));
    if (!r.ok) throw new Error(T`Usage endpoint: HTTP ${r.status}`);
    const j = await r.json();
    // All windows in one form (session | weekly_all | weekly_scoped with model reference).
    // IMPORTANT: the legacy fields five_hour/seven_day are a compatibility layer and `null` there
    // as soon as the endpoint lists a window only in `limits[]` — the client would then lack every
    // percentage and the usage ring would DISAPPEAR. So they are filled in from `limits[]` when missing.
    const wins = limits.claudeWindows(j);
    const winOf = (id) => wins.find((w) => w.id === id) || null;
    const legacy = (raw, id) => {
      const w = winOf(id);
      return {
        utilization: raw?.utilization ?? (typeof w?.percent === "number" ? w.percent : null),
        resetsAt: raw?.resets_at ?? (typeof w?.resetsAt === "number" ? new Date(w.resetsAt).toISOString() : null),
      };
    };
    const data = {
      fiveHour: legacy(j.five_hour, "session"),
      sevenDay: legacy(j.seven_day, "weekly_all"),
      // All windows the endpoint knows — auto-continue needs the complete list
      // to find the window that REALLY blocks.
      limits: Array.isArray(j.limits) ? j.limits : null,
      // Credit. These fields are what /api/oauth/usage really delivers; `spend_limit_reached` (which this
      // endpoint does not carry) is still passed along so that an old cache loaded from app_settings
      // is not suddenly read differently than when it was written.
      extra_usage: {
        is_enabled: j.extra_usage?.is_enabled === true,
        monthly_limit: typeof j.extra_usage?.monthly_limit === "number" ? j.extra_usage.monthly_limit : null,
        used_credits: typeof j.extra_usage?.used_credits === "number" ? j.extra_usage.used_credits : null,
        utilization: typeof j.extra_usage?.utilization === "number" ? j.extra_usage.utilization : null,
        currency: String(j.extra_usage?.currency || ""),
        disabled_reason: String(j.extra_usage?.disabled_reason || ""),
        spend_limit_reached: j.extra_usage?.spend_limit_reached === true,
      },
      // WHEN this was measured. Without this number a response from the error path (network gone,
      // 429) cannot be told from a fresh one — the error path below passes the old cache through
      // WITHOUT LIMIT, and the credit gate would decide on yesterday's value.
      // It is persisted too, so it also survives a backend restart.
      at: Date.now(),
      // For display (limits.js): `ring` is the SESSION WINDOW (5 h, all models) — with a value even
      // when the legacy fields stay empty. `blocking` additionally names the window currently at its
      // limit (e.g. a model-specific weekly limit); it belongs in tooltip and settings, but NOT in
      // the ring value.
      ring: limits.ringPayload(wins),
      blocking: limits.blockingPayload(wins),
    };
    usageCache = { at: Date.now(), data };
    usageBackoffUntil = 0;
    try { store.setSetting("usage_cache_v1", JSON.stringify(data)); } catch {}
    return data;
  } catch (e) {
    // Short outage (token/network/rate limit): keep serving the last known values so the display
    // does not disappear. at stays old → the next call tries live again. Only when it has NEVER
    // worked, pass the error through.
    if (usageCache.data) return usageCache.data;
    throw e;
  }
}

export { claudeAuth, fetchUsageLimits, usageInMemory };
