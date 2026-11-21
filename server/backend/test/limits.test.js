// Unit tests of the limit module. The message texts are NOT invented: they come from the installed binaries
// (measured with `strings`; versions named at the tests below) or from the real answer of /api/oauth/usage — a
// usage limit cannot be provoked on demand, so the tests run against the verified wordings and data shapes.
import assert from "node:assert/strict";
import test from "node:test";

import {
  GROUPS, chooseWait, claudeWindows, codexWindows, collectFailureText,
  blockingPayload, detectLimitHit, detectModelSwitch, isExhausted, probeDelayMs, ringPayload,
  ringWindow, stillBlocked, MAX_WAIT_MS,
  START_GATE_PERCENT, mayStartTurn, gateWindow, gatePayload, creditStatus, gateLimitText,
  gateWindowStale,
  windowForModel,
} from "../electron/server/limits.js";
import * as limitsModule from "../electron/server/limits.js";
import { usageBackoffMs } from "../electron/server/account/usage.js";

const T0 = Date.UTC(2026, 6, 30, 12, 0, 0); // fixed "now" instant

test("recognizes the real limit messages of both CLIs", () => {
  const hits = [
    "Claude usage limit reached",
    "API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Number of request tokens has exceeded your per-min rate limit\"}}",
    "Your session limit reached — try later",
    "Weekly limit exceeded for this account",
    "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus)",
    "You've hit your usage limit for gpt-5.6-sol. Switch to another model now",
    "stream error: exceeded retry limit, last status: 429",
    "UsageLimitReached",
    "429 Too Many Requests",
  ];
  for (const text of hits) {
    assert.equal(detectLimitHit({ stderr: text, now: T0 }).hit, true, `not recognized: ${text}`);
  }
});

test("keeps harmless errors apart (no false waiting states)", () => {
  const misses = [
    "TypeError: Cannot read properties of undefined (reading 'id')",
    "Error: ENOENT: no such file or directory, open '/tmp/x'",
    "fatal: not a git repository",
    "Command failed with exit code 1: npm run build",
    "see https://example.com/docs/429-handling for details", // 429 without a limit word
    "Reached maximum number of turns (25)",
  ];
  for (const text of misses) {
    assert.equal(detectLimitHit({ stderr: text, now: T0 }).hit, false, `wrongly recognized: ${text}`);
  }
});

// The companion word to "429" counts only as a WORD: "rate" in "migrated"/"generated" and "limit" in "unlimited" must not match,
// else limit detection would park a run that died of something else.
test("\"429\" with a companion word that occurs only as part of a word is no limit — as a word it is", () => {
  const misses = [
    "Error: SQLITE_CONSTRAINT at migrations/0007.sql:429 — table already migrated",
    "src/generated/schema.ts:429:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
    "429 tests passed, 3 failed (plan: unlimited)",
  ];
  for (const text of misses) {
    assert.equal(detectLimitHit({ stderr: text, now: T0 }).hit, false, `wrongly recognized: ${text}`);
  }
  const hits = [
    "HTTP 429: quota exceeded for this project",
    "upstream answered 429 (rate-limited)",
    "request failed with status 429, limit hit",
    "Error 429: RateLimitError",
    // An error code with an underscore stays a companion word (the boundary is a letter, not `\b`).
    "Error code: 429 - {'error': {'code': 'insufficient_quota'}}",
  ];
  for (const text of hits) {
    assert.equal(detectLimitHit({ stderr: text, now: T0 }).hit, true, `not recognized: ${text}`);
  }
});

// "No letter before" must not exclude an UPPERCASE one (flag i): error reasons of Google-style providers carry the companion
// word INSIDE a camelCase name — the run must park, not end as an error. The joint counts only between lower and upper case.
test("\"429\" with the companion word at a camelCase joint is a limit — a word part without a joint still is not", () => {
  const hits = [
    "429 userRateLimitExceeded",
    "HTTP 429 dailyLimitExceeded",
    "429 rateLimitExceeded",
    "Error 429: RateLimitError",
    "429 TooManyRequests",
    "429 RATE_LIMIT_EXCEEDED",
    "429 Too Many Requests",
  ];
  for (const text of hits) {
    assert.equal(detectLimitHit({ stderr: text, now: T0 }).hit, true, `not recognized: ${text}`);
  }
  const misses = [
    "Error: SQLITE_CONSTRAINT at migrations/0007.sql:429 — table already migrated",
    "429 tests passed, 3 failed (plan: unlimited)",
    "429 tests passed (plan: UNLIMITED)",
    "see LIMITATION 429 in the manual",
    "429 rows separate",
  ];
  for (const text of misses) {
    assert.equal(detectLimitHit({ stderr: text, now: T0 }).hit, false, `wrongly recognized: ${text}`);
  }
});

test("credit/cap messages are marked as such", () => {
  const a = detectLimitHit({ stderr: "Your workspace is out of credits. Add credits to continue.", now: T0 });
  assert.equal(a.hit, true);
  assert.equal(a.credits, true);
  // Codex' Pro template ("Visit … to purchase more credits") is the account's time window instead — the credit is only an
  // offer there.
  const pro = detectLimitHit({ stderr: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits", now: T0 });
  assert.equal(pro.hit, true);
  assert.equal(pro.credits, false);
  const b = detectLimitHit({ stderr: "CreditsDepleted", now: T0 });
  assert.equal(b.credits, true);
  // A time-window limit is NOT a credit problem
  assert.equal(detectLimitHit({ stderr: "usage limit reached", now: T0 }).credits, false);
});

test("reads the model-specific limit and reset hints from the text", () => {
  assert.equal(detectLimitHit({ stderr: "You've hit your usage limit for gpt-5.6-sol. Switch to another model now", now: T0 }).model, "gpt-5.6-sol");
  // Old format of the Claude CLI (Unix seconds after a pipe)
  assert.equal(detectLimitHit({ stderr: "Claude AI usage limit reached|1785585600", now: T0 }).resetAt, 1785585600 * 1000);
  // ISO
  assert.equal(
    detectLimitHit({ stderr: "usage limit reached · resets at 2026-07-30T18:20:00Z", now: T0 }).resetAt,
    Date.parse("2026-07-30T18:20:00Z"),
  );
  // relative
  assert.equal(detectLimitHit({ stderr: "rate limit — try again in 2h 30m", now: T0 }).resetAt, T0 + 2 * 3600_000 + 30 * 60_000);
  // without a hint
  assert.equal(detectLimitHit({ stderr: "usage limit reached", now: T0 }).resetAt, null);
});

test("collects failure text from events too (Codex reports via turn.failed)", () => {
  const text = collectFailureText({
    events: [
      { type: "item.completed", item: { type: "agent_message", text: "all good" } },
      { type: "turn.failed", error: { message: "You've hit your usage limit." } },
    ],
  });
  assert.match(text, /hit your usage limit/);
  assert.equal(detectLimitHit({ events: [{ type: "turn.failed", error: { message: "You've hit your usage limit." } }], now: T0 }).hit, true);
});

test("Claude: limits[] is mapped to groups (session, week, model-specific)", () => {
  // Shape from the REAL answer of /api/oauth/usage
  const usage = {
    five_hour: { utilization: 56, resets_at: "2026-07-30T18:20:00.088636+00:00" },
    seven_day: { utilization: 83, resets_at: "2026-08-01T05:00:00.088659+00:00" },
    limits: [
      { kind: "session", group: "session", percent: 100, resets_at: "2026-07-30T18:20:00Z", scope: null, is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 83, resets_at: "2026-08-01T05:00:00Z", scope: null, is_active: true },
      { kind: "weekly_scoped", group: "weekly", percent: 35, resets_at: "2026-08-01T05:00:00Z", scope: { model: { display_name: "Fable" } }, is_active: false },
    ],
  };
  const w = claudeWindows(usage);
  assert.equal(w.length, 3);
  assert.deepEqual(w.map((x) => x.group), [GROUPS.SESSION, GROUPS.WEEKLY, GROUPS.WEEKLY]);
  assert.equal(w[2].label, "weekly:Fable");
  assert.equal(w[0].resetsAt, Date.parse("2026-07-30T18:20:00Z"));
  assert.equal(isExhausted(w[0]), true);
  assert.equal(isExhausted(w[1]), false);
});

test("Claude: the reduced cache shape works the same", () => {
  const w = claudeWindows({
    fiveHour: { utilization: 100, resetsAt: "2026-07-30T18:20:00Z" },
    sevenDay: { utilization: 40, resetsAt: "2026-08-01T05:00:00Z" },
  });
  assert.equal(w.length, 2);
  assert.equal(w[0].group, GROUPS.SESSION);
  assert.equal(isExhausted(w[0]), true);
  assert.equal(w[1].group, GROUPS.WEEKLY);
});

test("Claude: a reached spend cap shows up as its own window without a reset", () => {
  // REAL fields of /api/oauth/usage (measured on 2.1.259) — not `spend_limit_reached`, a field this endpoint does not carry.
  const w = claudeWindows({
    limits: [{ kind: "session", group: "session", percent: 10, resets_at: "2026-07-30T18:20:00Z" }],
    extra_usage: { is_enabled: false, monthly_limit: 5000, used_credits: 5000, utilization: 100, currency: "USD", disabled_reason: "out_of_credits" },
  });
  const credits = w.find((x) => x.group === GROUPS.CREDITS);
  assert.ok(credits);
  assert.equal(credits.resetsAt, null);
  // Counter-check: the DEAD field alone creates nothing — else credit detection would depend on a value that never comes.
  const tot = claudeWindows({
    limits: [{ kind: "session", group: "session", percent: 10, resets_at: "2026-07-30T18:20:00Z" }],
    extra_usage: { spend_limit_reached: true },
  });
  assert.equal(tot.length, 1);
  assert.equal(tot.find((x) => x.group === GROUPS.CREDITS), undefined);
});

test("Codex: rate_limit_reached_type names the limit kind", () => {
  // Shape from RateLimitSnapshot (Codex binary 0.145.0), resets_at in Unix SECONDS
  const snap = {
    primary: { used_percent: 100, window_minutes: 300, resets_at: Math.floor(T0 / 1000) + 3600 },
    secondary: { used_percent: 42, window_minutes: 10080, resets_at: Math.floor(T0 / 1000) + 86400 },
    plan_type: "plus",
    rate_limit_reached_type: "primary",
  };
  const w = codexWindows(snap);
  assert.equal(w.length, 2);
  assert.equal(w[0].group, GROUPS.SESSION);
  assert.equal(w[0].reached, true);
  assert.equal(w[0].resetsAt, T0 + 3600_000, "seconds must become milliseconds");
  assert.equal(w[1].group, GROUPS.WEEKLY);
  assert.equal(w[1].reached, false);
});

test("Codex: the weekly window is recognized by its window length, credit separately", () => {
  const w = codexWindows({
    primary: { used_percent: 12, window_minutes: 300, resets_at: Math.floor(T0 / 1000) + 60 },
    secondary: { used_percent: 100, window_minutes: 10080, resets_at: Math.floor(T0 / 1000) + 7200 },
    rate_limit_reached_type: "secondary",
  });
  assert.equal(w[1].group, GROUPS.WEEKLY);
  assert.equal(isExhausted(w[1]), true);
  const c = codexWindows({ credits: { has_credits: false, unlimited: false }, rate_limit_reached_type: "credits" });
  assert.equal(c[0].group, GROUPS.CREDITS);
  assert.equal(c[0].resetsAt, null);
  // reduced shape of codexUsage()
  const r = codexWindows({ primary: { usedPercent: 99, windowMinutes: 300, resetsAt: new Date(T0 + 1800_000).toISOString() }, reachedType: "primary" });
  assert.equal(r[0].resetsAt, T0 + 1800_000);
});

test("with several exhausted windows the LATEST reset applies", () => {
  const windows = [
    { group: GROUPS.SESSION, label: "session", percent: 100, resetsAt: T0 + 3600_000, reached: true },
    { group: GROUPS.WEEKLY, label: "weekly", percent: 100, resetsAt: T0 + 5 * 86400_000, reached: true },
  ];
  const r = chooseWait({ windows, now: T0, grace: 30_000 });
  assert.equal(r.ok, true);
  assert.equal(r.window.group, GROUPS.WEEKLY);
  assert.equal(r.resumeAt, T0 + 5 * 86400_000 + 30_000);
  // Only the short window exhausted -> its reset
  const only5h = chooseWait({ windows: [windows[0], { ...windows[1], percent: 20, reached: false }], now: T0, grace: 0 });
  assert.equal(only5h.window.group, GROUPS.SESSION);
  assert.equal(only5h.resumeAt, T0 + 3600_000);
});

test("credit used up: no waiting, a clear refusal", () => {
  const r = chooseWait({ windows: [{ group: GROUPS.CREDITS, label: "credits", percent: 100, resetsAt: null, reached: true }], now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "credits");
  // Even if only the MESSAGE points to credit and no window has a reset
  assert.equal(chooseWait({ windows: [], now: T0, creditsHint: true }).reason, "credits");
});

test("reset unknown -> probe; absurdly long waiting time -> refusal", () => {
  const unknown = chooseWait({ windows: [{ group: GROUPS.SESSION, label: "session", percent: 100, resetsAt: null, reached: true }], now: T0 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "unknown");
  assert.ok(probeDelayMs(0) < probeDelayMs(3));
  assert.equal(probeDelayMs(99), probeDelayMs(5), "capped");
  const tooLong = chooseWait({ windows: [{ group: GROUPS.WEEKLY, label: "weekly", percent: 100, resetsAt: T0 + MAX_WAIT_MS + 60_000, reached: true }], now: T0 });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.reason, "too-long");
});

test("the hint from the message carries when the usage endpoint is silent", () => {
  // The caller calls chooseWait ONLY after a recognized limit hit. If it knows no window (no network, no token), the instant
  // from the message is the only source — and counts.
  const r = chooseWait({ windows: [], now: T0, hintResetAt: T0 + 900_000, grace: 10_000 });
  assert.equal(r.ok, true);
  assert.equal(r.resumeAt, T0 + 910_000);
  assert.equal(r.window, null, "without window data there is no window to name");
  // Without a window AND without a hint only probing remains.
  assert.equal(chooseWait({ windows: [], now: T0 }).reason, "unknown");
  // With an exhausted window without a date the hint applies too.
  const withHit = chooseWait({
    windows: [{ group: GROUPS.SESSION, label: "session", percent: 100, resetsAt: null, reached: true }],
    now: T0, hintResetAt: T0 + 900_000, grace: 10_000,
  });
  assert.equal(withHit.ok, true);
  assert.equal(withHit.resumeAt, T0 + 910_000);
});

test("never continue at once (minimum waiting time)", () => {
  const r = chooseWait({ windows: [{ group: GROUPS.SESSION, label: "session", percent: 100, resetsAt: T0 - 60_000, reached: true }], now: T0, grace: 0 });
  assert.equal(r.ok, true);
  assert.ok(r.resumeAt > T0, "reset in the past -> still wait briefly");
});

test("stillBlocked recognizes a limit that still stands", () => {
  const w = [{ group: GROUPS.SESSION, percent: 100, resetsAt: T0 + 60_000, reached: true }];
  assert.equal(stillBlocked(w, { now: T0 }), true);
  assert.equal(stillBlocked(w, { now: T0 + 120_000 }), false, "reset past -> free");
  assert.equal(stillBlocked([{ group: GROUPS.SESSION, percent: 12 }], { now: T0 }), false);
});

// ── Display: which window belongs in the usage ring? ─────────────────────
// At the limit the ring VANISHED in the desktop and mobile apps instead of showing 100 %: not the display but the data — an
// exhausted window does not necessarily bring a percentage. The choice therefore lives here, shared by all clients, and is
// testable without a real limit.

test("the ring is the session window (5 h, ALL models) — even when a model limit stands", () => {
  // Real data shape: 5-hour window almost empty, a MODEL-SPECIFIC weekly limit ("Fable") at the stop. The ring must still NOT
  // jump to 100 % — it answers "how much session is left", and that was 98 % here.
  const w = claudeWindows({
    five_hour: { utilization: 2, resets_at: "2026-08-12T01:39:59Z" },
    seven_day: { utilization: 64, resets_at: "2026-08-15T04:59:59Z" },
    limits: [
      { kind: "session", group: "session", percent: 2, resets_at: "2026-08-12T01:39:59Z", scope: null },
      { kind: "weekly_all", group: "weekly", percent: 64, resets_at: "2026-08-15T04:59:59Z", scope: null },
      { kind: "weekly_scoped", group: "weekly", percent: 100, resets_at: "2026-08-15T05:00:00Z", scope: { model: { display_name: "Fable" } } },
    ],
  });
  const ring = ringPayload(w);
  assert.equal(ring.percent, 2);
  assert.equal(ring.group, GROUPS.SESSION);
  assert.equal(ring.scope, "", "no model reference in the ring");
  assert.equal(ring.reached, false);
  assert.equal(ring.resetsAt, "2026-08-12T01:39:59.000Z", "reset as ISO — the clients do not compute in ms");

  // What blocks goes along beside it — tooltip and settings show it, the ring value does not.
  const blocking = blockingPayload(w);
  assert.equal(blocking.percent, 100);
  assert.equal(blocking.reached, true);
  assert.equal(blocking.scope, "Fable");
  assert.equal(blocking.group, GROUPS.WEEKLY);
});

test("the ring stays the session window even when the weekly window is fuller", () => {
  const ring = ringPayload(claudeWindows({
    fiveHour: { utilization: 12, resetsAt: "2026-08-12T01:00:00Z" },
    sevenDay: { utilization: 64, resetsAt: "2026-08-15T04:00:00Z" },
  }));
  assert.equal(ring.percent, 12);
  assert.equal(ring.group, GROUPS.SESSION);
  assert.equal(ring.reached, false);
});

test("the session window itself at the stop -> 100 % in the ring", () => {
  const w = claudeWindows({
    five_hour: { utilization: null, resets_at: null }, // old field empty, everything is in limits[]
    limits: [{ kind: "session", group: "session", percent: 100, resets_at: "2026-08-12T01:39:59Z", scope: null }],
  });
  const ring = ringPayload(w);
  assert.equal(ring.percent, 100);
  assert.equal(ring.reached, true);
  assert.equal(ring.group, GROUPS.SESSION);
});

test("several limits exhausted -> blocking names the one with the latest reset (as chooseWait)", () => {
  const blocking = blockingPayload([
    { group: GROUPS.SESSION, percent: 100, resetsAt: T0 + 3600_000, reached: true },
    { group: GROUPS.WEEKLY, percent: 100, resetsAt: T0 + 86400_000, reached: true },
  ]);
  assert.equal(blocking.group, GROUPS.WEEKLY);
  assert.equal(new Date(blocking.resetsAt).getTime(), T0 + 86400_000);
});

test("exhausted WITHOUT a percentage is shown as 100 %, not hidden", () => {
  // Codex at the limit: the CLI likes to write the exhausted window as null and names only the kind.
  const ring = ringPayload(codexWindows({ primary: null, secondary: null, credits: { has_credits: false, unlimited: false }, rate_limit_reached_type: "credits" }));
  assert.equal(ring.percent, 100);
  assert.equal(ring.reached, true);
  assert.equal(ring.group, GROUPS.CREDITS);
  assert.equal(ring.resetsAt, null, "credit has no time window");
});

test("Codex: spend cap (also in the reduced shape) lands in the ring", () => {
  const ring = ringPayload(codexWindows({ primary: null, secondary: null, reachedType: "spend" }));
  assert.equal(ring.group, GROUPS.SPEND);
  assert.equal(ring.percent, 100);
});

test("Codex: the window length sticks to the ring (label 5h/7-day)", () => {
  const ring = ringPayload(codexWindows({
    primary: { used_percent: 100, window_minutes: 10080, resets_at: Math.floor(T0 / 1000) + 7200 },
    secondary: null,
    rate_limit_reached_type: "primary",
  }));
  assert.equal(ring.windowMinutes, 10080);
  assert.equal(ring.reached, true);
});

test("without any window there is no ring (no invented zero value)", () => {
  assert.equal(ringPayload([]), null);
  assert.equal(ringPayload(claudeWindows({})), null);
  assert.equal(ringWindow([{ group: GROUPS.SESSION, percent: null, resetsAt: null }]), null);
});

test("Codex: the ring takes the short window, the long exhausted one stands beside it", () => {
  const w = codexWindows({
    primary: { used_percent: 9, window_minutes: 300, resets_at: Math.floor(T0 / 1000) + 1800 },
    secondary: { used_percent: 100, window_minutes: 10080, resets_at: Math.floor(T0 / 1000) + 86400 },
    rate_limit_reached_type: "secondary",
  });
  const ring = ringPayload(w);
  assert.equal(ring.percent, 9);
  assert.equal(ring.group, GROUPS.SESSION);
  assert.equal(ring.windowMinutes, 300);
  assert.equal(blockingPayload(w).group, GROUPS.WEEKLY);
});

// ── Measured wordings ─────────────────────────────────────
// The following strings come from `strings` over the binaries (Claude 2.1.259, Codex 0.151.0), not from memory.

test("recognizes the 2026 limit wordings of both CLIs", () => {
  const hits = [
    // Claude 2.1.259
    "5-hour limit reached · resets 12:40am (Europe/Berlin)",
    "Usage limit reached · continuing automatically when it resets · esc to cancel",
    "Usage limit reached again after you continued · continuing automatically shortly",
    "Fable limit reached · continuing on Opus 5 uses usage credits",
    "Fast mode disabled · usage credit limit reached",
    "Fast limit reached and temporarily disabled · resets in 12m",
    "You're out of usage credits. /model to switch models.",
    "Your organization is out of usage credits. Contact your admin to add more.",
    "Lower-priority mode ended · you have reached your weekly usage limit",
    "spend limit reached (daily; resets 2026-08-08 00:00 UTC)",
    // Codex 0.151.0
    "Usage limit reached. You've reached your usage limit. Increase your limits to continue.",
    "Your workspace is out of credits. Add credits to continue using Codex.",
    "UsageLimitExceeded",
    "workspace_owner_credits_depleted",
  ];
  for (const text of hits) {
    assert.equal(detectLimitHit({ stderr: text, now: T0 }).hit, true, `not recognized: ${text}`);
  }
});

test("counter-check: the OTHER \"… limit reached\" messages of the same binaries do not trigger", () => {
  // The window name in "<name> limit reached" is deliberately open (model names change). That is exactly why this list must
  // hold: the other hits from the same two binaries that have nothing to do with the usage quota. Without the block list
  // cbase would park a run because the context was full or a subagent was nested too deep.
  const misses = [
    "Context limit reached · 200000 tokens",         // Claude: context window, not quota
    "Budget limit reached ($5.00 of $10.00); stopping background agents",
    "Concurrency Limit reached",
    "Concurrent export limit reached",
    "Concurrent subagent limit reached. You can run 8 subagents at once.",
    "Subagent nesting limit reached (depth 3 of 3). Complete this task directly.",
    "watch limit reached",
    "trigger limit reached",
    "deviceRegistry: account device limit reached",
    "dropped events because eventCountLimit reached",
    "retry limit reached",                            // Codex: HTTP retries
    "Memory limit reachedDecoder Not Found",
    "recursion limit reached",
    "JIT stack limit reached",
    "agent thread limit reached",
    "Agent depth limit reached. Solve the task yourself.",
    "Shadow stream limit reached, dropping oldest",
    "OS file watch limit reached.",
    "Responses websocket connection limit reached (60 minutes).",
    "You have not reached your usage limit", // negation with the same wording
  ];
  for (const text of misses) {
    assert.equal(detectLimitHit({ stderr: text, now: T0 }).hit, false, `wrongly recognized: ${text}`);
  }
});

test("the window name is open — a new model needs no code change", () => {
  // The old list was hard-wired as session|weekly|opus|sonnet. Fable, Sol and Astra were not in it; an unrecognized limit
  // means: the run dies instead of waiting.
  for (const name of ["Fable", "Sol", "Astra", "gpt-6-astra", "Haiku", "5-hour"]) {
    assert.equal(detectLimitHit({ stderr: `${name} limit reached`, now: T0 }).hit, true, name);
  }
  assert.equal(detectLimitHit({ stderr: "Sonnet limit exceeded", now: T0 }).hit, true);
});

test("the CLI's automatic model switch is readable (it is not prevented)", () => {
  // Wording from 2.1.259: at the Fable limit the CLI switches by itself and continues. cbase does not stop that but makes it
  // visible — the caller writes a log line from it.
  const w = detectModelSwitch("Fable limit reached · continuing on Opus 5 uses usage credits, and the prompt to confirm went unanswered");
  assert.deepEqual(w, { limit: "Fable", model: "Opus 5" });
  assert.equal(detectModelSwitch("Usage limit reached · continuing automatically at 3pm"), null, "waiting is no model switch");
  assert.equal(detectModelSwitch({ stderr: "Fable limit reached · continuing on gpt-6-astra." })?.model, "gpt-6-astra");
});

test("the wordings of 2.1.280: what is new compared with 2.1.273 is recognized", () => {
  // Pulled from the binary of the target version (set diff against 2.1.273): the two grace hints replace "finishing up" and
  // "a little extra on us, then your credits", the reset hangs behind as "· limit resets <time>", and the Fable consent
  // has a second tail (closed from Remote Control). The gap "<model> now uses usage credits · the prompt to confirm went
  // unanswered" is the same on 2.1.273 and 2.1.280 — named in the head of limits.js, not here. "You've hit your session
  // limit · resets …" (template `uh`) is recognized, see below.
  const now = new Date(2026, 8, 24, 10, 0, 0).getTime();
  for (const text of [
    "Usage limit reached · wrapping up",
    "Usage limit reached · brief included wrap-up, then usage credits",
  ]) {
    assert.equal(detectLimitHit({ stderr: text, now }).hit, true, `not recognized: ${text}`);
  }
  assert.equal(detectLimitHit({ stderr: "Usage limit reached · limit resets 1:09pm", now }).resetAt,
    new Date(2026, 8, 24, 13, 9, 0).getTime(), "the reset behind \"· limit resets\" is an instant");
  assert.deepEqual(
    detectModelSwitch("Fable limit reached · continuing on Opus 5 uses usage credits, and the prompt to confirm was closed from Remote Control without a choice — nothing was sent · it asks again on your next message, or /model to change"),
    { limit: "Fable", model: "Opus 5" });
});

test("the template `You've hit your ${window}${reset}` of 2.1.280: window session/weekly/Opus/Sonnet is a limit with a reset; the block list is not", () => {
  // Wording from the binary (function `uh`, reset from `Pc`: toLocaleTimeString "en-US", zone in parentheses). Detection
  // used to recognize only "… usage limit" — nothing parked here, and an agent at the limit failed.
  const now = new Date(2026, 8, 26, 12, 0, 0).getTime();
  const hits = (text) => detectLimitHit({ stderr: text, now });
  for (const window of ["session", "weekly", "Opus", "Sonnet"]) {
    const h = hits(`You've hit your ${window} limit · resets 5:40pm (Europe/Berlin)`);
    assert.equal(h.hit, true, window);
    assert.equal(h.credits, false, window);
    assert.equal(h.resetAt, new Date(2026, 8, 26, 17, 40, 0).getTime(), `${window}: the reset is an instant`);
  }
  assert.equal(hits("You've hit your weekly limit · resets Sep 30, 3pm (Europe/Berlin)").resetAt, new Date(2026, 8, 30, 15, 0, 0).getTime());
  // "You've hit your monthly spend limit." is a limit AND a credit case (test "Claude cap …" below).
  for (const text of ["You've hit your limit", "You've hit your context limit"]) {
    assert.equal(hits(text).hit, false, `wrongly recognized: ${text}`);
  }
});

// ── Codex 0.162.1 ──────────────────────────────────────
// The wordings come from `codex-rs/protocol/src/error.rs` at tag rust-v0.162.1 (the seven templates of
// `UsageLimitReachedError`, `QuotaExceeded`, `retry_suffix`/`retry_suffix_after_or`) and from a capture provider that played
// the error answers to the real 0.162.1 binary — the Plus and Pro lines below are verbatim what the CLI wrote from them as
// `error`/`turn.failed`. Since 0.155.0 there is a typographic apostrophe (U+2019); against the old limits.js all four tests
// are red (none of the seven templates matched, "Quota exceeded …" neither, no reset "Try again at Oct 11th …", and the
// named template with U+2019 not either).
const CODEX_NOW = new Date(2026, 9, 10, 0, 0, 0).getTime(); // local time: the CLI writes local time
const AT_1_08 = new Date(2026, 9, 10, 1, 8, 0).getTime();

test("Codex 0.162.1: all seven templates of \"You’ve hit your usage limit\" (typographic apostrophe) are a limit — with reset and model", () => {
  const hits = (text) => detectLimitHit({ stderr: text, now: CODEX_NOW });
  const templates = [
    // limit_name set (not "codex"/"gpt-reserve"): model-specific
    ["You’ve hit your usage limit for gpt-6-sol. Switch to another model now, or try again at 1:08 AM.", { model: "gpt-6-sol", resetAt: AT_1_08 }],
    // promo_message of the server — its text is not known, the template is
    ["You’ve hit your usage limit. <offer of the server>, or try again later.", { resetAt: null }],
    // Plus — measured (capture, plan_type plus, resets_at in one hour)
    ["You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 1:08 AM.", { resetAt: AT_1_08 }],
    // Team/Business/Enterprise-CBP
    ["You’ve hit your usage limit. To get more access now, send a request to your admin or try again at 1:08 AM.", { resetAt: AT_1_08 }],
    // Free/Go
    ["You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again later.", { resetAt: null }],
    // Pro — measured (capture, plan_type pro, resets_in_seconds)
    ["You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again later.", { resetAt: null }],
    // Enterprise/Edu and unknown plan: `retry_suffix` — "Try" UPPERCASE, without "or"
    ["You’ve hit your usage limit. Try again at 1:08 AM.", { resetAt: AT_1_08 }],
  ];
  for (const [text, expected] of templates) {
    const h = hits(text);
    assert.equal(h.hit, true, `not recognized: ${text}`);
    assert.equal(h.resetAt, expected.resetAt, `Reset: ${text}`);
    assert.equal(h.model, expected.model || "", `model: ${text}`);
  }
  // The path runChatCodex takes: the error comes as `error` and `turn.failed` in the stream, stderr carries only the CLI's
  // start line.
  const notice = templates[2][0];
  const stream = detectLimitHit({
    stderr: "Reading additional input from stdin...",
    events: [{ type: "error", message: notice }, { type: "turn.failed", error: { message: notice } }],
    now: CODEX_NOW,
  });
  assert.equal(stream.hit, true, "not recognized from the stream (error/turn.failed)");
  assert.equal(stream.resetAt, AT_1_08);
});

test("Codex 0.162.1: \"Quota exceeded. Check your plan and billing details.\" is a limit and a CREDIT case — auto-continue does not wait", () => {
  // insufficient_quota: 0.153.1 wrote "exceeded retry limit, last status: 429 Too Many Requests" for it (a limit with an
  // unknown reset => probe, up to 24 looks), 0.162.1 writes the text of `QuotaExceeded`. Codex itself treats it as final
  // (`retry_delay` => None); the billing pot does not come back by itself.
  // The API wording alone ("You exceeded your current quota, please check your plan and billing details.") is NOT a credit
  // case (Gemini writes it for a per-minute quota) — only with the code `insufficient_quota`.
  for (const text of [
    "Quota exceeded. Check your plan and billing details.",
    "{\"error\":{\"message\":\"You exceeded your current quota, please check your plan and billing details.\",\"code\":\"insufficient_quota\"}}",
  ]) {
    const h = detectLimitHit({ stderr: text, now: CODEX_NOW });
    assert.equal(h.hit, true, `not recognized: ${text}`);
    assert.equal(h.credits, true, `not a credit case: ${text}`);
    assert.equal(h.resetAt, null);
    const w = chooseWait({ windows: [], now: CODEX_NOW, hintResetAt: h.resetAt, creditsHint: h.credits });
    assert.equal(w.reason, "credits", `${text}: there is nothing to wait for`);
  }
  // An exhausted per-minute quota is a limit but NOT a credit case — it comes back by itself.
  const minute = detectLimitHit({ stderr: "Quota exceeded for quota metric 'Generate Content API requests' per minute", now: CODEX_NOW });
  assert.equal(minute.hit, true);
  assert.equal(minute.credits, false);
  // And the rate_limit shape is the same in both versions: limit, no credit, reset unknown.
  const rate = detectLimitHit({ stderr: "exceeded retry limit, last status: 429 Too Many Requests", now: CODEX_NOW });
  assert.deepEqual([rate.hit, rate.credits, rate.resetAt], [true, false, null]);
});

test("Codex: the reset on ANOTHER day (\"Try again at Oct 11th, 2026 1:08 AM.\") is an instant — and a weekly limit waits for it", () => {
  // `format_retry_timestamp`: on the same day "%-I:%M %p", otherwise "%b %-d<st|nd|rd|th>, %Y %-I:%M %p" — with "at" BEFORE the
  // date. The reset time pattern must read this "at" (and an uppercase "Try"), else the reset stays unknown.
  const tomorrow = new Date(2026, 9, 11, 1, 8, 0).getTime();
  const h = detectLimitHit({ stderr: "You’ve hit your usage limit. Try again at Oct 11th, 2026 1:08 AM.", now: CODEX_NOW });
  assert.equal(h.hit, true);
  assert.equal(h.resetAt, tomorrow);
  assert.equal(detectLimitHit({ stderr: "You’ve hit your usage limit for gpt-6-sol. Switch to another model now, or try again at Oct 12th, 2026 9:15 PM.", now: CODEX_NOW }).resetAt,
    new Date(2026, 9, 12, 21, 15, 0).getTime());
  const w = chooseWait({ windows: [], now: CODEX_NOW, hintResetAt: h.resetAt, creditsHint: h.credits, grace: 0 });
  assert.equal(w.ok, true);
  assert.equal(w.resumeAt, tomorrow, "wake at the reset, do not probe");
});

test("counter-check to Codex 0.162.1: no disk quota, no negation — and Claude's straight apostrophe still matches", () => {
  for (const text of [
    "write /home/agent/x: Disk quota exceeded",         // EDQUOT on Linux
    "cp: /Volumes/Data/x: Disc quota exceeded",        // EDQUOT on macOS
    "You have not reached your usage limit",
  ]) {
    assert.equal(detectLimitHit({ stderr: text, now: CODEX_NOW }).hit, false, `wrongly recognized: ${text}`);
  }
  // Claude writes the STRAIGHT apostrophe (2.1.280, template `uh`, and the Codex wordings up to 0.154) — both stay recognized.
  for (const text of ["You've hit your session limit · resets 5:40pm (Europe/Berlin)", "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later."]) {
    assert.equal(detectLimitHit({ stderr: text, now: CODEX_NOW }).hit, true, `no longer recognized: ${text}`);
  }
  // Since Claude 2.1.312 the window is called "5-hour limit": recognized with its reset like "session limit".
  assert.deepEqual(
    (({ hit, credits, resetAt }) => ({ hit, credits, resetAt }))(detectLimitHit({ stderr: "You've hit your 5-hour limit · resets 5:40pm (Europe/Berlin)", now: CODEX_NOW })),
    { hit: true, credits: false, resetAt: new Date(2026, 9, 10, 17, 40, 0).getTime() }, "the template with the new window name");
  // … and the UI hints that carry only the word are no hit.
  for (const text of ["Usage limit has reset · Press enter to continue", "Usage limit reset · Continuing automatically", "A 5-hour limit reset isn't available right now.", "Approaching your 5-hour usage limit — Claude will wrap up the current step."]) {
    assert.equal(detectLimitHit({ stderr: text, now: CODEX_NOW }).hit, false, `wrongly recognized: ${text}`);
  }
  assert.equal(detectLimitHit({ stderr: "You’ve hit your session limit · resets 5:40pm (Europe/Berlin)", now: CODEX_NOW }).resetAt,
    new Date(2026, 9, 10, 17, 40, 0).getTime(), "the named template reads both apostrophes");
});

// ── Codex plan templates ────────────────────────────────
// The plan templates of `UsageLimitReachedError` (Plus, Pro, Free/Go; the same sentences with a straight apostrophe in
// 0.153.1) are the TIME WINDOW of a ChatGPT account; "purchase more credits" and "Upgrade to …" are an offer there, not a
// finding. If they counted as a credit case, chooseWait (which reads the credit hint BEFORE the reset from the text) would
// discard the read reset and auto-continue would give up (reason "credits"). Counter-check: against that old state the
// first two tests are red.
const DAY_AFTER_TOMORROW = new Date(2026, 9, 12, 21, 15, 0).getTime();
const CODEX_PLAN_TEMPLATES = [
  // Plus (0.162.1, measured) — with a reset on another day and without a reset
  "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 12th, 2026 9:15 PM.",
  // Pro/ProLite/ProMax
  "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 12th, 2026 9:15 PM.",
  // Free/Go
  "You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Oct 12th, 2026 9:15 PM.",
  // the same sentences in 0.153.1 (straight apostrophe, old address)
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 12th, 2026 9:15 PM.",
  "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Oct 12th, 2026 9:15 PM.",
];

test("the plan templates (Plus, Pro, Free) are a time window — auto-continue waits for the reset from the text", () => {
  for (const text of CODEX_PLAN_TEMPLATES) {
    const h = detectLimitHit({ stderr: text, now: CODEX_NOW });
    assert.equal(h.hit, true, `not recognized: ${text}`);
    assert.equal(h.credits, false, `read as a credit case: ${text}`);
    assert.equal(h.resetAt, DAY_AFTER_TOMORROW, `Reset: ${text}`);
    const w = chooseWait({ windows: [], now: CODEX_NOW, hintResetAt: h.resetAt, creditsHint: h.credits, grace: 0, maxWaitMs: 7 * 86_400_000 });
    assert.equal(w.reason, "reset", `${text}: gave up instead of waiting`);
    assert.equal(w.ok, true);
    assert.equal(w.resumeAt, DAY_AFTER_TOMORROW);
  }
});

test("without a reset in the text the plan templates probe — they do not give up", () => {
  for (const text of CODEX_PLAN_TEMPLATES.map((t) => t.replace(/ try again at Oct 12th, 2026 9:15 PM\./, " try again later."))) {
    assert.match(text, /try again later\.$/);
    const h = detectLimitHit({ stderr: text, now: CODEX_NOW });
    assert.deepEqual([h.hit, h.credits, h.resetAt], [true, false, null], text);
    assert.equal(chooseWait({ windows: [], now: CODEX_NOW, hintResetAt: h.resetAt, creditsHint: h.credits }).reason, "unknown", text);
  }
});

// The two spend-cap templates (error.rs 0.162.1, verbatim in 0.153.1) must match a LIMIT_PATTERN — else a Codex run at the
// workspace cap would end as an error, without a line and without "credit". And "check your plan and billing details" alone
// must not make every quota a credit case — also not Gemini's per-minute/day quota, which comes back by itself.
test("real credit and cap cases stay \"credits\" — both spend-cap templates included", () => {
  for (const text of [
    "Your workspace is out of credits. Add credits to continue.",
    "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
    "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
    "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.",
    "Quota exceeded. Check your plan and billing details.",
    // OpenAI API (third party via a preset): the code `insufficient_quota` is in the body
    "429 {\"error\":{\"message\":\"You exceeded your current quota, please check your plan and billing details.\",\"type\":\"insufficient_quota\",\"code\":\"insufficient_quota\"}}",
    "You're out of usage credits",
    "CreditsDepleted",
  ]) {
    const h = detectLimitHit({ stderr: text, now: CODEX_NOW });
    assert.equal(h.hit, true, `not recognized: ${text}`);
    assert.equal(h.credits, true, `not a credit case: ${text}`);
    assert.equal(chooseWait({ windows: [], now: CODEX_NOW, hintResetAt: h.resetAt, creditsHint: h.credits }).reason, "credits", text);
  }
});

test("Gemini's exhausted quota (\"… please check your plan and billing details … Please retry in 31s\") waits or probes as before", () => {
  const gemini = "429 RESOURCE_EXHAUSTED: You exceeded your current quota, please check your plan and billing details. For more information on this error, " +
    "head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/usage?tab=rate-limit. " +
    "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-2.5-pro\nPlease retry in 31.5s.";
  for (const text of [gemini, "You exceeded your current quota, please check your plan and billing details."]) {
    const h = detectLimitHit({ stderr: text, now: CODEX_NOW });
    assert.equal(h.hit, true, `not recognized: ${text}`);
    assert.equal(h.credits, false, `read as a credit case: ${text}`);
    assert.notEqual(chooseWait({ windows: [], now: CODEX_NOW, hintResetAt: h.resetAt, creditsHint: h.credits }).reason, "credits", text);
  }
});

// ── Reset formats: the time of day that appears in everyday use ────────────────────────
// resetFromText must know the most common form too — without it the server probes blindly with backoff instead of waking
// at the reset. "now" is deliberately LOCAL time here: the CLI writes local time without a zone, and the test should
// measure the same in every time zone.
const AT_NOON = new Date(2026, 8, 9, 12, 0, 0).getTime();
const local = (...parts) => new Date(...parts).getTime();

test("reset from the time of day: plain time, date, year — with a comma and with \"at\"", () => {
  const reset = (text) => detectLimitHit({ stderr: `usage limit reached · ${text}`, now: AT_NOON }).resetAt;
  assert.equal(reset("resets 3pm"), local(2026, 8, 9, 15, 0, 0), "full hour without minutes");
  assert.equal(reset("resets 1:09pm (Europe/Berlin)"), local(2026, 8, 9, 13, 9, 0), "the zone in parentheses is display, not a computing value");
  assert.equal(reset("resets Sep 12, 3pm"), local(2026, 8, 12, 15, 0, 0));
  assert.equal(reset("resets Sep 12 at 3pm"), local(2026, 8, 12, 15, 0, 0), "\"at\" instead of a comma — depends on the ICU revision");
  assert.equal(reset("resets Sep 12, 11:09am"), local(2026, 8, 12, 11, 9, 0));
  assert.equal(reset("resets Oct 14, 2027, 11:09am"), local(2027, 9, 14, 11, 9, 0), "with a year");
  // The same instant also hangs behind "continuing automatically at" in the Claude CLI.
  assert.equal(
    detectLimitHit({ stderr: "Usage limit reached · continuing automatically at 12:40am (Europe/Berlin) · esc to cancel", now: AT_NOON }).resetAt,
    local(2026, 8, 10, 0, 40, 0),
  );
});

test("day change: a time that has already passed means TOMORROW", () => {
  const reset = (text) => detectLimitHit({ stderr: `usage limit reached · ${text}`, now: AT_NOON }).resetAt;
  assert.equal(reset("resets 9:30am"), local(2026, 8, 10, 9, 30, 0), "morning, now it is 12 o'clock -> tomorrow");
  assert.equal(reset("resets 12:40am"), local(2026, 8, 10, 0, 40, 0), "12am is midnight, not noon");
  assert.equal(reset("resets 12:40pm"), local(2026, 8, 9, 12, 40, 0), "12pm is noon");
  // Counter-check of the tolerance: the CLI prints to the minute, a reset just printed lies seconds "in the past" — it must NOT
  // slip to tomorrow.
  assert.equal(reset("resets 11:58am"), local(2026, 8, 9, 11, 58, 0), "two minutes past -> today (rounding)");
  assert.equal(reset("resets 11:50am"), local(2026, 8, 10, 11, 50, 0), "ten minutes past -> tomorrow");
  // A date is NOT guessed into the next year (see the comment in the module).
  assert.equal(reset("resets Sep 8, 3pm"), local(2026, 8, 8, 15, 0, 0), "a date in the past stays where it is");
});

test("day change across the clock change: \"tomorrow\" is the next calendar day, not 24 hours later", () => {
  // On the day DST ends a printed "resets 12:16am" was read back an hour off — `+24 h` on "today 00:16" (still summer time)
  // misses the 25-hour day. The zone is FIXED here (in this test only), else it measures nothing in a zone without a switch.
  const prior = process.env.TZ;
  process.env.TZ = "Europe/Berlin";
  try {
    const reset = (text, now) => new Date(detectLimitHit({ stderr: `usage limit reached · ${text}`, now }).resetAt).toISOString();
    // Autumn: 25.10.2026, 22:16 CET (21:16Z), the day had 25 hours.
    assert.equal(reset("resets 12:16am (Europe/Berlin)", Date.parse("2026-10-25T21:16:00Z")), "2026-10-25T23:16:00.000Z", "autumn: an hour too early");
    // Spring: 29.03.2026, 22:00 CEST (20:00Z), the day had 23 hours.
    assert.equal(reset("resets 12:30am", Date.parse("2026-03-29T20:00:00Z")), "2026-03-29T22:30:00.000Z", "spring: an hour too late");
    // An ordinary day stays as it was.
    assert.equal(reset("resets 12:30am", Date.parse("2026-10-26T21:00:00Z")), "2026-10-26T23:30:00.000Z");
  } finally {
    if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior;
  }
});

test("counter-check: the more exact forms keep precedence, and without am/pm there is no instant", () => {
  const hin = (text) => detectLimitHit({ stderr: text, now: AT_NOON }).resetAt;
  // ISO beats the time of day — else the time pattern would tear the digits from the timestamp.
  assert.equal(hin("usage limit reached · resets at 2026-07-30T18:20:00Z · retry 3pm"), Date.parse("2026-07-30T18:20:00Z"));
  // relative likewise
  assert.equal(hin("rate limit — try again in 2h 30m"), AT_NOON + 2 * 3600_000 + 30 * 60_000);
  // A trailing "UTC" belongs to the instant: without this reading it would be off by the zone offset.
  assert.equal(hin("spend limit reached (daily; resets 2026-08-08 00:00 UTC)"), Date.parse("2026-08-08T00:00:00Z"));
  // No am/pm => no invented time.
  assert.equal(hin("usage limit reached · resets soon"), null);
  assert.equal(hin("usage limit reached · resets in 45 minutes"), AT_NOON + 45 * 60_000);
  assert.equal(hin("usage limit reached"), null);
});

// ── has_credits: no pot is not an empty pot ─────────────────────────────

test("Codex: has_credits false means \"no credit pot\", not \"credit used up\"", () => {
  // A REAL snapshot: both windows almost empty, no limit reached, spend_control_reached null — and the chain must not deliver
  // blocking { percent: 100, group: "credits", reached: true } and chooseWait { ok:false, reason:"credits" } (auto-continue
  // could NEVER wait for Codex on such an account).
  const real = {
    primary: { used_percent: 2, window_minutes: 300, resets_at: Math.floor(T0 / 1000) + 3600 },
    secondary: { used_percent: 1, window_minutes: 10080, resets_at: Math.floor(T0 / 1000) + 86400 },
    credits: { has_credits: false, unlimited: false, balance: 0 },
    spend_control_reached: null,
    plan_type: "plus",
    rate_limit_reached_type: null,
  };
  const w = codexWindows(real);
  assert.equal(w.length, 2, "only the two time windows — no invented credit window");
  assert.equal(w.find((x) => x.group === GROUPS.CREDITS), undefined);
  assert.equal(blockingPayload(w), null, "nothing blocks");
  assert.notEqual(chooseWait({ windows: w, now: T0 }).reason, "credits");
  assert.equal(ringPayload(w).percent, 2, "the ring still shows the session window");
});

test("Codex: credit is used up only when it says so", () => {
  const window = (snap) => codexWindows(snap).find((x) => x.group === GROUPS.CREDITS);
  // Codex says it itself
  assert.ok(window({ credits: { has_credits: false, unlimited: false }, rate_limit_reached_type: "credits" }));
  // Existing pot, state null
  assert.ok(window({ credits: { has_credits: true, unlimited: false, balance: 0 } }));
  // An existing pot with credit => no window
  assert.equal(window({ credits: { has_credits: true, unlimited: false, balance: 1250 } }), undefined);
  // Unlimited => no window
  assert.equal(window({ credits: { has_credits: true, unlimited: true, balance: 0 } }), undefined);
  // State unknown => NO window: empty is not unknown
  assert.equal(window({ credits: { has_credits: true, unlimited: false } }), undefined);
  // The spend cap stays untouched by that
  assert.equal(codexWindows({ credits: { has_credits: false }, spend_control_reached: true }).find((x) => x.group === GROUPS.SPEND)?.group, GROUPS.SPEND);
});

// ── extra_usage: the real fields ───────────────────────────────────────────

test("credit state is computed from the REAL fields (amounts in cents)", () => {
  const g = creditStatus({ extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234, utilization: null, currency: "USD", disabled_reason: null } });
  assert.equal(g.active, true);
  assert.equal(g.unlimited, false);
  assert.equal(g.limitCent, 5000);
  assert.equal(g.limit, 50, "cents -> currency unit");
  assert.equal(g.consumed, 12.34);
  assert.equal(g.currency, "USD");
  assert.equal(Math.round(g.percent * 100) / 100, 24.68, "computed itself without a reported utilization");
  assert.equal(g.blocked, false);
  // A reported utilization beats the own computation.
  assert.equal(creditStatus({ extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234, utilization: 90 } }).percent, 90);
  // Currencies without decimal places (the same set the CLI's formatter keeps).
  assert.equal(creditStatus({ extra_usage: { is_enabled: true, monthly_limit: 900, used_credits: 450, currency: "JPY" } }).limit, 900);
  // Unlimited is no utilization of 100 %, and a missing extra_usage is no statement.
  assert.equal(creditStatus({ extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 900 } }).percent, null);
  assert.equal(creditStatus({ extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 900 } }).unlimited, true);
  assert.equal(creditStatus({ limits: [] }), null);
  assert.equal(creditStatus(null), null);
});

test("credit blocks only for the three measured reasons — or when the own cap is full", () => {
  const group = (extra) => claudeWindows({ fiveHour: { utilization: 4, resetsAt: "2026-07-30T18:20:00Z" }, extra_usage: extra }).find((w) => w.group === GROUPS.CREDITS || w.group === GROUPS.SPEND)?.group;
  assert.equal(group({ is_enabled: false, disabled_reason: "out_of_credits", monthly_limit: 5000, used_credits: 5000 }), GROUPS.CREDITS);
  assert.equal(group({ is_enabled: false, disabled_reason: "org_spend_cap_reached" }), GROUPS.SPEND);
  assert.equal(group({ is_enabled: false, disabled_reason: "org_level_disabled_until" }), GROUPS.SPEND);
  assert.equal(group({ is_enabled: true, monthly_limit: 5000, used_credits: 5000, utilization: 100 }), GROUPS.SPEND, "own monthly cap full");
  // Counter-checks: everything else does not block.
  assert.equal(group({ is_enabled: true, monthly_limit: 5000, used_credits: 4900, utilization: 98 }), undefined, "98 % is no full cap — credit is money, not a rounded window");
  assert.equal(group({ is_enabled: false, disabled_reason: "preference" }), undefined);
  assert.equal(group({ is_enabled: true, monthly_limit: null, used_credits: 999999 }), undefined, "unlimited");
  assert.equal(group({ is_enabled: false, monthly_limit: 5000, used_credits: 5000, utilization: 100 }), undefined, "switched-off credit is no reached cap");
});

test("the credit window applies in BOTH answer shapes (raw and reduced cache)", () => {
  // It must not hang on the limits[] branch alone — from the reduced cache shape it must appear too.
  const raw = claudeWindows({ limits: [{ kind: "session", group: "session", percent: 12, resets_at: "2026-07-30T18:20:00Z" }], extra_usage: { disabled_reason: "out_of_credits" } });
  const cache = claudeWindows({ fiveHour: { utilization: 12, resetsAt: "2026-07-30T18:20:00Z" }, extra_usage: { disabled_reason: "out_of_credits" } });
  assert.equal(raw.length, 2);
  assert.equal(cache.length, 2);
  assert.equal(cache[1].group, GROUPS.CREDITS);
  // The refusal "credits" is carried by the window only without any time window: at 12 % session the pot did not cause the
  // hit — probe.
  assert.equal(chooseWait({ windows: cache, now: T0 }).reason, "unknown");
  const onlyPot = claudeWindows({ extra_usage: { disabled_reason: "out_of_credits" } });
  assert.deepEqual(onlyPot.map((w) => w.group), [GROUPS.CREDITS], "precondition: no time window");
  assert.equal(chooseWait({ windows: onlyPot, now: T0 }).reason, "credits", "credit does not recover by itself");
});

// ── Start gate (credit) ────────────────────────────────────────────────────

test("the start gate engages at 99, not 98 — two thresholds, two meanings", () => {
  assert.equal(START_GATE_PERCENT, 99);
  const at = (p) => claudeWindows({ limits: [{ kind: "session", group: "session", percent: p, resets_at: "2026-07-30T18:20:00Z" }] });
  assert.equal(mayStartTurn({ windows: at(99), gateOn: true, now: T0 }).ok, false);
  assert.equal(mayStartTurn({ windows: at(99), gateOn: true, now: T0 }).reason, "credit-gate");
  // 98 means "wait, nothing gets through any more" — but not "start nothing new".
  assert.equal(isExhausted(at(98)[0]), true, "98 still counts as exhausted");
  assert.equal(mayStartTurn({ windows: at(98), gateOn: true, now: T0 }).ok, true);
  assert.equal(mayStartTurn({ windows: at(98), gateOn: true, now: T0 }).reason, "free");
});

test("the gate is a setting, and the human can override it for ONE turn", () => {
  const full = claudeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: "2026-07-30T18:20:00Z" }] });
  assert.deepEqual(mayStartTurn({ windows: full, gateOn: false, now: T0 }), { ok: true, reason: "off", window: null });
  assert.equal(mayStartTurn({ windows: full, gateOn: true, now: T0 }).ok, false);
  const anyway = mayStartTurn({ windows: full, gateOn: true, overruled: true, now: T0 });
  assert.equal(anyway.ok, true);
  assert.equal(anyway.reason, "overruled");
  assert.equal(anyway.window.percent, 100, "the window is named anyway — the button says what it costs");
  // Without any window the gate does not block: an unloaded state is not a full state.
  assert.deepEqual(mayStartTurn({ windows: [], gateOn: true, now: T0 }), { ok: true, reason: "free", window: null });
});

test("the gate does NOT apply to Codex (its value comes from the last run's session file)", () => {
  const codexFull = codexWindows({ primary: { used_percent: 100, window_minutes: 300, resets_at: Math.floor(T0 / 1000) + 60 }, rate_limit_reached_type: "primary" });
  assert.equal(gateWindow(codexFull), null);
  assert.equal(mayStartTurn({ windows: codexFull, gateOn: true }).ok, true);
  // The time limit itself works unchanged for Codex — only the PRE-EMPTIVE gate is absent.
  assert.equal(chooseWait({ windows: codexFull, now: T0, grace: 0 }).ok, true);
});

test("with several windows at the mark the gate names the one with the latest reset", () => {
  const window = [
    { group: GROUPS.SESSION, percent: 99, resetsAt: T0 + 3600_000, provider: "claude" },
    { group: GROUPS.WEEKLY, percent: 100, resetsAt: T0 + 5 * 86400_000, provider: "claude" },
  ];
  assert.equal(gateWindow(window, { now: T0 }).group, GROUPS.WEEKLY);
  const p = gatePayload(window, { now: T0 });
  assert.equal(p.percent, 100);
  assert.equal(new Date(p.resetsAt).getTime(), T0 + 5 * 86400_000);
  assert.equal(gatePayload([]), null);
});

// ── the window kind that is computed with ───────────────────
// Each test here is red on the state before (counter-checked, not asserted).

test("chooseWait: a dated window counts BEFORE the credit — a full cap does not switch waiting off", () => {
  // The REAL account shape, only used_credits set to the own cap: the session window is full and resets in 1 h 40, the monthly
  // cap for extra usage is reached. "credits" must not come out — the run would end as an error instead of continuing at
  // 19:40. Credit is the pot BEYOND the windows: a fresh window runs without it.
  const now = Date.parse("2026-09-14T18:00:00Z");
  const windows = claudeWindows({
    limits: [
      { kind: "session", group: "session", percent: 100, resets_at: "2026-09-14T19:40:00Z", scope: null },
      { kind: "weekly_all", group: "weekly", percent: 7, resets_at: "2026-09-21T16:00:00Z", scope: null },
    ],
    extra_usage: { is_enabled: true, monthly_limit: 35000, used_credits: 35000, utilization: 100, currency: "EUR", disabled_reason: null },
  });
  assert.ok(windows.find((w) => w.group === GROUPS.SPEND), "precondition: the cap is there as a window");
  const r = chooseWait({ windows, now, grace: 30_000 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "reset");
  assert.equal(r.window.group, GROUPS.SESSION);
  assert.equal(r.resumeAt, Date.parse("2026-09-14T19:40:00Z") + 30_000);
  // The credit HINT from the message changes nothing about that as long as a window has a date.
  assert.equal(chooseWait({ windows, now, grace: 0, creditsHint: true }).reason, "reset");
  // Counter-check: ONLY the cap exhausted — the refusal holds when the message itself says credit (creditsHint) …
  const onlyCap = claudeWindows({
    limits: [{ kind: "session", group: "session", percent: 12, resets_at: "2026-09-14T19:40:00Z", scope: null }],
    extra_usage: { is_enabled: true, monthly_limit: 35000, used_credits: 35000, utilization: 100 },
  });
  const refusal = chooseWait({ windows: onlyCap, now, creditsHint: true });
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, "credits");
  assert.equal(refusal.window.group, GROUPS.SPEND);
  // … not without the proof: the time window is there, only not at the mark — probe.
  assert.equal(chooseWait({ windows: onlyCap, now }).reason, "unknown");
});

test("the gate does not stand on credit or spend cap — an empty pot is no full window", () => {
  // Account without credit (disabled_reason out_of_credits), session window at 10 %. The next turn runs in the subscription and
  // costs nothing — the gate must not park it and promise "continue as soon as the window is free" for a pot that never recovers.
  const withoutCredit = claudeWindows({
    limits: [{ kind: "session", group: "session", percent: 10, resets_at: "2026-07-30T18:20:00Z", scope: null }],
    extra_usage: { is_enabled: false, monthly_limit: 5000, used_credits: 5000, utilization: 100, currency: "USD", disabled_reason: "out_of_credits" },
  });
  assert.ok(withoutCredit.find((w) => w.group === GROUPS.CREDITS), "precondition: the credit window is there");
  assert.equal(gateWindow(withoutCredit, { now: T0 }), null);
  assert.deepEqual(mayStartTurn({ windows: withoutCredit, gateOn: true, now: T0 }), { ok: true, reason: "free", window: null });
  assert.equal(gatePayload(withoutCredit, { now: T0 }), null, "the card at the chat says the same as the execution: nothing");
  // The same for the full own monthly cap (SPEND) and the org block.
  const capFull = claudeWindows({
    fiveHour: { utilization: 3, resetsAt: "2026-07-30T18:20:00Z" },
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 5000, utilization: 100 },
  });
  assert.equal(capFull.find((w) => w.group === GROUPS.SPEND)?.reached, true, "precondition");
  assert.equal(mayStartTurn({ windows: capFull, gateOn: true, now: T0 }).reason, "free");
  assert.equal(mayStartTurn({ windows: claudeWindows({ fiveHour: { utilization: 3 }, extra_usage: { is_enabled: false, disabled_reason: "org_spend_cap_reached" } }), gateOn: true, now: T0 }).reason, "free");
  // The two sides still each give their own correct answer: for an
  // exhausted pot "no waiting there" — but only with the message's proof or without any time window; at 10 % session without
  // proof it probes.
  assert.equal(chooseWait({ windows: withoutCredit, now: T0, creditsHint: true }).reason, "credits");
  assert.equal(chooseWait({ windows: withoutCredit, now: T0 }).reason, "unknown");
  // Counter-check: a full TIME window still blocks — the cut hits only the kind.
  const timeFull = claudeWindows({
    limits: [{ kind: "session", group: "session", percent: 100, resets_at: "2026-07-30T18:20:00Z", scope: null }],
    extra_usage: { is_enabled: false, disabled_reason: "out_of_credits" },
  });
  const verdict = mayStartTurn({ windows: timeFull, gateOn: true, now: T0 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.window.group, GROUPS.SESSION, "and it names the time window, not the pot");
});

test("the gate does not stand on the weekly limit of ANOTHER model — the same identifier the ring excludes", () => {
  // The state of the ring test above: session 2 %, week 64 %, the model-specific Fable window at 100 %. The gate must not park
  // EVERY chat of every model until the weekly reset — also not a Sonnet chat that never touches Fable. "Now" lies within
  // this state — the windows have a date, and a window with a past reset no longer blocks (see the test below).
  const T1 = Date.UTC(2026, 7, 11, 12, 0, 0);
  const w = claudeWindows({
    limits: [
      { kind: "session", group: "session", percent: 2, resets_at: "2026-08-12T01:39:59Z", scope: null },
      { kind: "weekly_all", group: "weekly", percent: 64, resets_at: "2026-08-15T04:59:59Z", scope: null },
      // `scope.model.id` is null in the real cache — the assignment runs via the display name.
      { kind: "weekly_scoped", group: "weekly", percent: 100, resets_at: "2026-08-15T05:00:00Z", scope: { model: { id: null, display_name: "Fable" } } },
    ],
  });
  assert.equal(w[2].scope, "Fable", "precondition: the identifier is `scope`");
  // Without a model (default model) and for another model: free.
  assert.equal(gateWindow(w, { now: T1 }), null);
  assert.equal(mayStartTurn({ windows: w, gateOn: true, now: T1 }).reason, "free");
  assert.equal(mayStartTurn({ windows: w, gateOn: true, model: "claude-opus-5", now: T1 }).reason, "free");
  assert.equal(mayStartTurn({ windows: w, gateOn: true, model: "claude-sonnet-5", now: T1 }).reason, "free");
  // For the model the window belongs to: blocked — in catalog, alias and reference form.
  for (const model of ["claude-fable-5-1", "claude-fable-5", "fable", "claude::claude-fable-5-1"]) {
    const verdict = mayStartTurn({ windows: w, gateOn: true, model, now: T1 });
    assert.equal(verdict.ok, false, model);
    assert.equal(verdict.window.scope, "Fable", model);
  }
  // The display computes with the same model as the execution.
  assert.equal(gatePayload(w, { now: T1 }), null);
  assert.equal(gatePayload(w, { model: "claude-fable-5-1", now: T1 }).scope, "Fable");
  // The old fields carry the identifier too (seven_day_opus => scope "Opus").
  const old = claudeWindows({ fiveHour: { utilization: 5, resetsAt: "2026-08-12T01:39:59Z" }, seven_day_opus: { utilization: 100, resets_at: "2026-08-15T05:00:00Z" } });
  assert.equal(gateWindow(old, { now: T1 }), null);
  assert.equal(gateWindow(old, { model: "claude-opus-4-8", now: T1 })?.scope, "Opus");
  assert.equal(gateWindow(old, { model: "claude-haiku-4-5-20251001", now: T1 }), null);
  // Counter-check: a window over ALL models blocks every chat, with and without a model.
  const all = claudeWindows({ limits: [{ kind: "weekly_all", group: "weekly", percent: 100, resets_at: "2026-08-15T04:59:59Z", scope: null }] });
  assert.equal(mayStartTurn({ windows: all, gateOn: true, now: T1 }).ok, false);
  assert.equal(mayStartTurn({ windows: all, gateOn: true, model: "claude-sonnet-5", now: T1 }).ok, false);
});

test("gateLimitText: ONE wording that detection reads as a limit and from which it reads the reset back", () => {
  // A one-shot caught at the gate throws this text; whoever catches it (filing chain, parkJudge, compaction) lands via
  // detectLimitHit on the existing park path — without knowing the gate case separately. The reset comes back to the
  // millisecond (ISO with milliseconds, and resetFromText reads it via Date.parse), hence strict equality instead of second
  // rounding.
  const w = { group: GROUPS.SESSION, label: "session", scope: "", percent: 99.4, resetsAt: T0 + 6000_000, provider: "claude" };
  const text = gateLimitText(w);
  assert.equal(text, "Usage limit reached — credit gate: session 99 % · resets at 2026-07-30T13:40:00.000Z");
  const hit = detectLimitHit({ stderr: text, now: T0 });
  assert.equal(hit.hit, true);
  assert.equal(hit.resetAt, w.resetsAt);
  assert.equal(hit.credits, false, "the gate stands on time windows — a credit case would mean: do not wait");
  assert.equal(hit.model, "", "no model-specific limit text");
  // Without a known reset the addition is dropped; detection still hits, and the caller probes as for "reset unknown".
  const without = gateLimitText({ group: GROUPS.WEEKLY, label: "weekly:Fable", scope: "Fable", percent: 100, resetsAt: null });
  assert.equal(without, "Usage limit reached — credit gate: weekly:Fable 100 %");
  assert.equal(detectLimitHit({ stderr: without, now: T0 }).hit, true);
  assert.equal(detectLimitHit({ stderr: without, now: T0 }).resetAt, null);
  // Label missing => group; percent missing => 100 (the same fallback rule as the card at the chat).
  assert.equal(gateLimitText({ group: GROUPS.WEEKLY }), "Usage limit reached — credit gate: weekly 100 %");
  // Also from a run's error object (events), not only from stderr.
  assert.equal(detectLimitHit({ events: [{ type: "error", message: text }], now: T0 }).resetAt, w.resetsAt);
});

// ── time and model — ONE rule per question, for gate and wake-up ─────────
test("a blocking window whose reset has passed is a number from earlier: the gate does not block on it, the wake-up does not wait for it", () => {
  const past = [{ group: GROUPS.SESSION, percent: 100, resetsAt: T0 - 60_000, provider: "claude" }];
  const open = [{ group: GROUPS.SESSION, percent: 100, resetsAt: T0 + 60_000, provider: "claude" }];
  const without = [{ group: GROUPS.SESSION, percent: 100, resetsAt: null, provider: "claude" }];
  assert.equal(gateWindow(past, { now: T0 }), null, "reset passed — no block");
  assert.equal(gateWindow(open, { now: T0 })?.group, GROUPS.SESSION);
  assert.equal(gateWindow(without, { now: T0 })?.group, GROUPS.SESSION, "without a reset instant the window blocks (probing is the caller's business)");
  // The same rule in the wake-up check — two answers to one question would make the gate re-park every 20 s (the wake-up
  // said "free", the gate "full").
  assert.equal(stillBlocked(past, { now: T0 }), false);
  assert.equal(stillBlocked(open, { now: T0 }), true);
  assert.equal(stillBlocked(without, { now: T0 }), true);
  // And the question whether the cache must be read fresh: yes, when a gate candidate has passed — no, when only a credit pot
  // or a foreign model window has passed (they do not concern the gate).
  assert.equal(gateWindowStale(past, { now: T0 }), true);
  assert.equal(gateWindowStale(open, { now: T0 }), false);
  assert.equal(gateWindowStale([{ group: GROUPS.CREDITS, reached: true, resetsAt: T0 - 1, provider: "claude" }], { now: T0 }), false);
  assert.equal(gateWindowStale([{ group: GROUPS.WEEKLY, percent: 100, resetsAt: T0 - 1, scope: "Fable", provider: "claude" }], { model: "claude-sonnet-5", now: T0 }), false);
  assert.equal(gateWindowStale([{ group: GROUPS.WEEKLY, percent: 100, resetsAt: T0 - 1, scope: "Fable", provider: "claude" }], { model: "claude-fable-5-1", now: T0 }), true);
});

test("windowForModel cuts foreign model windows for waiting time and wake-up check — the same rule as the gate", () => {
  const w = [
    { group: GROUPS.SESSION, percent: 99, resetsAt: T0 + 2 * 3600_000, provider: "claude" },
    { group: GROUPS.WEEKLY, percent: 30, resetsAt: T0 + 6 * 86400_000, provider: "claude" },
    { group: GROUPS.WEEKLY, percent: 100, resetsAt: T0 + 6 * 86400_000, scope: "Fable", label: "weekly:Fable", provider: "claude" },
  ];
  const sonnet = windowForModel(w, "claude-sonnet-5");
  assert.deepEqual(sonnet.map((x) => x.label || x.group), [GROUPS.SESSION, GROUPS.WEEKLY], "the Fable window does not belong to the Sonnet chat");
  // Otherwise the gate held the Sonnet chat at the session window (2 h) — and the waiting time took the latest reset of ALL
  // windows, i.e. Fable's weekly reset in six days.
  assert.equal(chooseWait({ windows: sonnet, now: T0, grace: 0 }).window.group, GROUPS.SESSION);
  assert.equal(chooseWait({ windows: w, now: T0, grace: 0 }).window.label, "weekly:Fable", "counter-check: uncut it is the Fable reset");
  assert.equal(stillBlocked(sonnet, { now: T0 + 3 * 3600_000 }), false, "after the session reset the Sonnet chat is free");
  assert.equal(stillBlocked(w, { now: T0 + 3 * 3600_000 }), true, "counter-check: uncut Fable would hold it six days");
  // A Fable chat keeps its window; without a model, model-specific windows drop out.
  assert.equal(windowForModel(w, "claude-fable-5-1").length, 3);
  assert.equal(windowForModel(w, "").length, 2);
});

// ── gate and wake-up give the same answer ──────────────────────────────────────
// The incident: a gate row, at the reset the 5-hour window stands at 4 %, extra usage is empty (`disabled_reason:
// "out_of_credits"`, a PERMANENT account state). The gate would have started — the wake-up check (stillBlocked) took the
// credit window without a reset for a valid block, probed 10/20/30/45/60 min and dropped the job after 24 looks. The rule
// now stands ONCE (limits.timeLocks): waiting and not-starting rest only on time windows.
// The new names (timeLocks, nextProbing) are read via the module object `limitsModule` (head): that way this file stays
// loadable against an old state, and the counter-check shows RED at the statement.

test("the wake-up check does not stand on credit or spend cap — the incident", () => {
  const now = Date.parse("2026-10-04T17:40:44Z");
  const incident = claudeWindows({
    five_hour: { utilization: 4, resets_at: "2026-10-04T22:40:00Z" },
    seven_day: { utilization: 85, resets_at: "2026-10-08T09:00:00Z" },
    extra_usage: { is_enabled: false, utilization: null, disabled_reason: "out_of_credits" },
  });
  assert.equal(incident.find((w) => w.group === GROUPS.CREDITS)?.reached, true, "precondition: the credit window stands there as exhausted");
  assert.equal(gateWindow(incident, { now, model: "claude-opus-5" }), null, "the gate starts");
  assert.equal(stillBlocked(incident, { now }), false, "and the wake-up starts too (formerly: true — forever)");
  assert.deepEqual(limitsModule.timeLocks?.(incident, { now }), []);
  // Spend cap and org block: the same kind, the same answer.
  for (const extra of [
    { is_enabled: true, monthly_limit: 5000, used_credits: 5000, utilization: 100 },
    { is_enabled: false, disabled_reason: "org_spend_cap_reached" },
    { is_enabled: false, disabled_reason: "org_level_disabled_until" },
  ]) {
    const w = claudeWindows({ five_hour: { utilization: 4, resets_at: "2026-10-04T22:40:00Z" }, extra_usage: extra });
    assert.ok(w.some((x) => x.group === GROUPS.SPEND || x.group === GROUPS.CREDITS), `precondition ${JSON.stringify(extra)}`);
    assert.equal(stillBlocked(w, { now }), false, JSON.stringify(extra));
  }
});

test("Codex: an empty credit pot from the snapshot holds no row beyond the reset", () => {
  // The snapshot comes from the LAST run and never changes without a new run — which the wake-up check prevented: primary
  // past the reset, credits still "reached".
  const past = Math.floor((T0 - 60_000) / 1000);   // Codex delivers Unix seconds
  for (const snap of [
    { primary: { used_percent: 100, resets_at: past, window_minutes: 300 }, credits: { has_credits: true, balance: 0 } },
    { primary: { used_percent: 100, resets_at: past, window_minutes: 300 }, rate_limit_reached_type: "credits" },
    { primary: { used_percent: 100, resets_at: past, window_minutes: 300 }, spend_control_reached: true },
  ]) {
    const w = codexWindows(snap);
    assert.ok(w.some((x) => x.group === GROUPS.CREDITS || x.group === GROUPS.SPEND), "precondition");
    assert.equal(stillBlocked(w, { now: T0 }), false, JSON.stringify(snap));
  }
});

test("gate and wake-up: the same answer over a matrix of states — credit changes nothing in any", () => {
  const inHour = T0 + 3600_000;
  const window = (group, percent, resetsAt) => ({ id: group, group, label: group, scope: "", percent, resetsAt, reached: false, provider: "claude" });
  const lagen = {
    free: [window(GROUPS.SESSION, 4, inHour)],
    "session 98": [window(GROUPS.SESSION, 98, inHour)],
    "session 100": [window(GROUPS.SESSION, 100, inHour)],
    "session 100, reset past": [window(GROUPS.SESSION, 100, T0 - 60_000)],
    "session 100 no reset": [window(GROUPS.SESSION, 100, null)],
    "week 100": [window(GROUPS.WEEKLY, 100, T0 + 3 * 86_400_000)],
    "week 85": [window(GROUPS.WEEKLY, 85, T0 + 3 * 86_400_000)],
  };
  const credit = { id: "extra_usage", group: GROUPS.CREDITS, label: GROUPS.CREDITS, scope: "", percent: 100, resetsAt: null, reached: true, provider: "claude" };
  const cap = { ...credit, group: GROUPS.SPEND, label: GROUPS.SPEND };
  for (const [name, w] of Object.entries(lagen)) {
    const gate = gateWindow(w, { now: T0 }) !== null;
    const wakeup = stillBlocked(w, { now: T0 });
    // What the gate blocks, the wake-up blocks too (threshold 99 within 98) — else the gate would re-park every 20 s.
    if (gate) assert.equal(wakeup, true, `${name}: gate blocks, wake-up does not`);
    for (const pot of [credit, cap]) {
      assert.equal(gateWindow([...w, pot], { now: T0 }) !== null, gate, `${name} + ${pot.group}: Gate`);
      assert.equal(stillBlocked([...w, pot], { now: T0 }), wakeup, `${name} + ${pot.group}: wake-up`);
    }
  }
});

test("chooseWait: a credit window does not beat the message's reset hint, the CLI's credit proof does", () => {
  const hint = T0 + 40 * 60_000;
  // The endpoint rounds/lags (97 % < 98), the CLI says "resets 7:40pm" — and extra usage is empty.
  const w = [
    { id: "session", group: GROUPS.SESSION, label: "session", scope: "", percent: 97, resetsAt: hint, reached: false, provider: "claude" },
    { id: "extra_usage", group: GROUPS.CREDITS, label: GROUPS.CREDITS, scope: "", percent: 100, resetsAt: null, reached: true, provider: "claude" },
  ];
  const r = chooseWait({ windows: w, now: T0, hintResetAt: hint, grace: 30_000 });
  assert.equal(r.ok, true, `formerly "credits" — the prompt was gone: ${JSON.stringify(r)}`);
  assert.equal(r.resumeAt, hint + 30_000);
  // If the CLI itself says "out of credits", it stays the refusal — no circle start -> credit empty -> parking.
  assert.equal(chooseWait({ windows: w, now: T0, hintResetAt: hint, creditsHint: true }).reason, "credits");
  // Without a hint and without proof: probe — the time window is there, only below the mark. The refusal from the window alone
  // exists only without any time window.
  assert.equal(chooseWait({ windows: w, now: T0 }).reason, "unknown");
  assert.equal(chooseWait({ windows: [w[1]], now: T0 }).reason, "credits");
});

test("chooseWait: a valid time block without a date probes — a past reset is then no basis for waiting", () => {
  const w = [
    { id: "weekly_all", group: GROUPS.WEEKLY, label: "weekly", scope: "", percent: 100, resetsAt: null, reached: true, provider: "claude" },
    { id: "session", group: GROUPS.SESSION, label: "session", scope: "", percent: 100, resetsAt: T0 - 60_000, reached: false, provider: "claude" },
    { id: "extra_usage", group: GROUPS.CREDITS, label: GROUPS.CREDITS, scope: "", percent: 100, resetsAt: null, reached: true, provider: "claude" },
  ];
  assert.equal(stillBlocked(w, { now: T0 }), true, "precondition: the week blocks");
  const r = chooseWait({ windows: w, now: T0 });
  // Not: ok with "now + minimum wait" from the past session reset — at the wake-up every 20 s, without a counter.
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown");
  assert.equal(r.window?.group, GROUPS.WEEKLY, "and it names the time block, not the pot");
});

test("nextProbing: one sequence for all paths — 5, 10, 20, 30, 45, 60, 60 minutes", () => {
  assert.equal(typeof limitsModule.nextProbing, "function", "the ONE rule is missing");
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 23].map((n) => limitsModule.nextProbing(n) / 60_000), [5, 10, 20, 30, 45, 60, 60, 60]);
});

test("chooseWait: a permanently empty extra usage does not make a time-limit hit without a readable reset a refusal — it probes", () => {
  // The account carries `extra_usage {is_enabled:false, disabled_reason:"out_of_credits"}` PERMANENTLY. The CLI reports a TIME
  // limit without a readable reset, the endpoint still shows the window below 98 % after the hit (account/usage.js
  // fetchUsageLimits) — chooseWait must not make "credits" of it (log line "does not come back by itself", cancelAutoContinue,
  // the job gone; a subagent (runs/agents.js agentLimitChoice) would not wait).
  const now = Date.parse("2026-10-04T17:40:44Z");
  const timeWindow = { five_hour: { utilization: 96, resets_at: "2026-10-04T22:39:59Z" }, seven_day: { utilization: 85, resets_at: "2026-10-07T00:00:00Z" } };
  const withPot = claudeWindows({ ...timeWindow, extra_usage: { is_enabled: false, disabled_reason: "out_of_credits" } });
  const withoutPot = claudeWindows(timeWindow);
  assert.ok(withPot.some((w) => w.group === GROUPS.CREDITS), "precondition: the credit window is there");
  for (const text of ["5-hour limit reached", "You've hit your session limit", "Claude usage limit reached."]) {
    const hit = detectLimitHit({ stderr: text, now });
    assert.equal(hit.hit, true, `precondition: ${text}`);
    assert.equal(hit.credits, false, `precondition: no credit word in "${text}"`);
    assert.equal(hit.resetAt, null, `precondition: no readable reset in "${text}"`);
    const including = chooseWait({ windows: withPot, now, hintResetAt: hit.resetAt, creditsHint: hit.credits });
    const without = chooseWait({ windows: withoutPot, now, hintResetAt: hit.resetAt, creditsHint: hit.credits });
    assert.equal(including.reason, "unknown", `"${text}": the pot makes no refusal of the time limit — ${JSON.stringify(including.reason)}`);
    assert.equal(including.reason, without.reason, `"${text}": the same answer as without a pot`);
  }
  // If the message itself says credit, it stays the refusal (the proof) — also with time windows.
  const proof = detectLimitHit({ stderr: "You're out of usage credits", now });
  assert.equal(proof.credits, true, "precondition: the CLI's credit proof");
  assert.equal(chooseWait({ windows: withPot, now, hintResetAt: proof.resetAt, creditsHint: proof.credits }).reason, "credits");
  // Entirely without a time window there is nothing to wait for: the refusal from the window alone.
  const onlyPot = withPot.filter((w) => w.group === GROUPS.CREDITS);
  assert.equal(chooseWait({ windows: onlyPot, now }).reason, "credits");
});

test("gateWaitTime: a gate row waits as long as the GATE holds — not until the latest reset of all time blocks", () => {
  assert.equal(typeof limitsModule.gateWaitTime, "function", "the gate row's waiting time has no place");
  const now = Date.parse("2026-10-04T17:40:44Z");
  const sessionReset = Date.parse("2026-10-04T18:40:00Z");
  const weekReset = Date.parse("2026-10-07T00:00:00Z");
  const w = claudeWindows({
    five_hour: { utilization: 99.5, resets_at: new Date(sessionReset).toISOString() },
    seven_day: { utilization: 98.5, resets_at: new Date(weekReset).toISOString() },
    extra_usage: { is_enabled: false, disabled_reason: "out_of_credits" },
  });
  assert.equal(gateWindow(w, { now })?.group, GROUPS.SESSION, "precondition: the gate holds on the session");
  const g = limitsModule.gateWaitTime({ windows: w, now, grace: 30_000 });
  assert.equal(g.ok, true);
  assert.equal(g.window?.group, GROUPS.SESSION);
  assert.equal(g.resumeAt, sessionReset + 30_000, `the gate row waits until the session reset, not ${new Date(g.resumeAt).toISOString()}`);
  // The LIMIT row keeps waiting for the time block (98 %): a run that just failed would otherwise stand at the week.
  assert.equal(chooseWait({ windows: w, now, grace: 30_000 }).resumeAt, weekReset + 30_000);
  // After the session reset the gate is free — and a gate row asked then has nothing to wait for.
  const afterwards = sessionReset + 60_000;
  assert.equal(gateWindow(w, { now: afterwards }), null);
  assert.equal(limitsModule.gateWaitTime({ windows: w, now: afterwards }).window, null);
  // The gate's model cut applies here too: a full Fable weekly window does not hold a Sonnet chat.
  const fable = { id: "weekly_fable", group: GROUPS.WEEKLY, label: "weekly:Fable", scope: "Fable", percent: 100, resetsAt: weekReset, reached: false, provider: "claude" };
  assert.equal(limitsModule.gateWaitTime({ windows: [...w, fable], model: "claude-sonnet-4-6", now, grace: 30_000 }).resumeAt, sessionReset + 30_000);
  assert.equal(limitsModule.gateWaitTime({ windows: [...w, fable], model: "claude-fable-5-1", now, grace: 30_000 }).resumeAt, weekReset + 30_000);
});

test("gate row: block and waiting time come from the SAME windows — over a matrix of states", () => {
  const inHour = T0 + 3600_000;
  const inDays = T0 + 3 * 86_400_000;
  const window = (group, percent, resetsAt, extra = {}) => ({ id: group, group, label: group, scope: "", percent, resetsAt, reached: false, provider: "claude", ...extra });
  const credit = { id: "extra_usage", group: GROUPS.CREDITS, label: GROUPS.CREDITS, scope: "", percent: 100, resetsAt: null, reached: true, provider: "claude" };
  const lagen = {
    "session 99.5 + week 98.5": [window(GROUPS.SESSION, 99.5, inHour), window(GROUPS.WEEKLY, 98.5, inDays)],
    "session 100 + week 100": [window(GROUPS.SESSION, 100, inHour), window(GROUPS.WEEKLY, 100, inDays)],
    "session 98.5 + week 99": [window(GROUPS.SESSION, 98.5, inHour), window(GROUPS.WEEKLY, 99, inDays)],
    "session 100 no reset + week 99": [window(GROUPS.SESSION, 100, null), window(GROUPS.WEEKLY, 99, inDays)],
    "session 100 no reset": [window(GROUPS.SESSION, 100, null)],
    "session 99 (reset past) + week 98.5": [window(GROUPS.SESSION, 99, T0 - 60_000), window(GROUPS.WEEKLY, 98.5, inDays)],
  };
  for (const [name, raw] of Object.entries(lagen)) {
    for (const w of [raw, [...raw, credit]]) {
      const lock = gateWindow(w, { now: T0 });
      if (!lock) continue;
      const g = limitsModule.gateWaitTime({ windows: w, now: T0, grace: 30_000 });
      // If the gate names a dated window, the row waits exactly until its reset; otherwise it probes.
      if (typeof lock.resetsAt === "number" && lock.resetsAt > 0) {
        assert.equal(g.ok, true, `${name}: ${JSON.stringify(g.reason)}`);
        assert.equal(g.window, lock, `${name}: the waiting time names another window than the block`);
        assert.equal(g.resumeAt, lock.resetsAt + 30_000, name);
      } else {
        assert.equal(g.reason, "unknown", name);
      }
    }
  }
});

// ── Claude caps ────────────────────────────────
// Since 2.1.284 (measured in the 2.1.296 binary, latin1 search) the Claude CLI knows the caps of additional usage as their own
// template: `at(name, suffix)` = "You've hit your ${name}${suffix}" with name ∈ monthly spend limit · org's monthly spend limit ·
// individual spend limit · channel's monthly spend limit · team's shared budget · individual usage limit · org's monthly usage
// limit · channel's monthly usage limit, followed by " · raise it at …", " · ask your admin to raise it at …" and — when the
// plan's window comes back — " · your <window> resets <time>" (function `Vw`); plus the model-choice sentences ("You've
// hit your monthly spend limit. Switch to another model …“, „You've hit your team's shared budget. /model to switch
// models.", function `sao`) and "Your org is out of usage · add funds to continue". Each is a limit and a credit case —
// unless the wording names a reset: then the plan's window comes back and the run waits for it. Counter-check: against the
// old state both tests are red.
const CAP_NOW = new Date(2026, 9, 10, 12, 0, 0).getTime();
test("Claude caps: spend cap and shared team budget (2.1.284+) are a limit and a credit case — both apostrophes", () => {
  for (const text of [
    "You've hit your monthly spend limit.",
    "You’ve hit your monthly spend limit.",
    "You've hit your monthly spend limit. Switch to another model, or manage usage credits at https://claude.ai/settings/usage, to continue.",
    "You've hit your channel's monthly spend limit. Switch to another model to continue.",
    "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage",
    "You've hit your org's monthly spend limit · ask your admin to raise it at https://claude.ai/admin-settings/usage",
    "You've hit your individual spend limit · visit https://claude.ai/admin-settings/usage to raise it",
    "You've hit your team's shared budget. Switch to another model to continue.",
    "You’ve hit your team’s shared budget. Run /usage-credits to raise it and keep using Opus 5.5 or switch models to continue this chat.",
    "You've hit your team's shared budget. /model to switch models.",
    "You've hit your team's shared budget · ask your admin to raise it at https://claude.ai/admin-settings/usage",
    "You've hit your org's monthly usage limit",
    "Your org is out of usage · add funds to continue",
    "Your org is out of usage · contact your admin",
  ]) {
    const h = detectLimitHit({ stderr: text, now: CAP_NOW });
    assert.equal(h.hit, true, `not recognized: ${text}`);
    assert.equal(h.credits, true, `not a credit case: ${text}`);
    assert.equal(chooseWait({ windows: [], now: CAP_NOW, hintResetAt: h.resetAt, creditsHint: h.credits }).reason, "credits", text);
  }
  // Neighbors that are NO cap: the settings dialogs of the same binary.
  for (const text of ["Set your monthly spend limit to $50", "This spend limit goes into effect immediately.", "Monthly limit updated to $50"]) {
    assert.equal(detectLimitHit({ stderr: text, now: CAP_NOW }).hit, false, `wrongly recognized: ${text}`);
  }
});

test("Claude cap with a reset in the wording (\"· your session limit resets 5:40pm\"): the plan's window comes back — the run waits for it", () => {
  const at1740 = new Date(2026, 9, 10, 17, 40, 0).getTime();
  for (const text of [
    "You've hit your monthly spend limit · your session limit resets 5:40pm (Europe/Berlin)",
    "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage · your session limit resets 5:40pm (Europe/Berlin)",
    "You've hit your team's shared budget · ask your admin to raise it at https://claude.ai/admin-settings/usage · your session limit resets 5:40pm (Europe/Berlin)",
    "You've hit your individual usage limit · resets 5:40pm (Europe/Berlin)",
    // the window name since Claude 2.1.312
    "You've hit your monthly spend limit · your 5-hour limit resets 5:40pm (Europe/Berlin)",
    "You've hit your team's shared budget · ask your admin to raise it at https://claude.ai/admin-settings/usage · your 5-hour limit resets 5:40pm (Europe/Berlin)",
  ]) {
    const h = detectLimitHit({ stderr: text, now: CAP_NOW });
    assert.equal(h.hit, true, `not recognized: ${text}`);
    assert.equal(h.resetAt, at1740, `Reset: ${text}`);
    assert.equal(h.credits, false, `gave up despite reset: ${text}`);
    const w = chooseWait({ windows: [], now: CAP_NOW, hintResetAt: h.resetAt, creditsHint: h.credits, grace: 0 });
    assert.deepEqual([w.reason, w.resumeAt], ["reset", at1740], text);
  }
});

// /api/oauth/usage answered only 429 for over an hour — the server named `retry-after: 735`, cbase asked again after a fixed 90 s
// and so held the block open itself. Counter-check: with the old line (`+ 90_000` fixed) the first case yields 90 s instead of 735 s.
test("usage endpoint: after 429 Retry-After applies, bounded to 90 s up to 30 min", () => {
  assert.equal(usageBackoffMs("735", T0), 735_000);
  assert.equal(usageBackoffMs(new Date(T0 + 600_000).toUTCString(), T0), 600_000);
  assert.equal(usageBackoffMs("5", T0), 90_000);
  assert.equal(usageBackoffMs("86400", T0), 30 * 60_000);
  assert.equal(usageBackoffMs(null, T0), 90_000);
  assert.equal(usageBackoffMs("nonsense", T0), 90_000);
});
