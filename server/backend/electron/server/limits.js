// Usage limits of Claude and Codex — PURE (no network, no DB, no processes).
//
// Task: from what a failed run leaves behind (result text, stderr, events) and from the provider's known limit state, derive
// WHETHER a usage limit was the cause and WHEN it resets. The server (runs/auto-continue.js, runs/limit-gate.js) only adds the
// waiting and resuming.
//
// Why a module of its own: the decision "which window blocks and for how long" is the actual logic of this feature and must be
// testable without a real limit — a limit cannot be produced on demand.
//
// The limit kinds and their wordings were measured against the installed binaries (`strings` over the executables, not from memory):
//   Claude: /api/oauth/usage returns `limits[]` with kind session | weekly_all | weekly_scoped (scope.model.display_name), plus the
//     legacy fields five_hour / seven_day / seven_day_opus / seven_day_sonnet and `extra_usage`. The CLI names them
//     five_hour="session limit", seven_day="weekly limit", seven_day_opus="Opus limit", seven_day_sonnet="Sonnet limit".
//     `extra_usage` carries { is_enabled, monthly_limit, used_credits, utilization, currency, disabled_reason }; amounts in CENTS (the
//     CLI's formatter divides by 100, except for JPY/KRW/VND). This endpoint has NO field `spend_limit_reached` (it exists only on an
//     org route; see creditStatus()).
//   Claude 2.1.280+: UI hints "Usage limit reached · wrapping up", "… · brief included wrap-up, then usage credits", "· limit resets
//     1:09pm", and "You've hit your session limit · resets 5:40pm (Europe/Berlin)" (also weekly/Opus/Sonnet; template
//     `You've hit your ${window}${reset}`, the reset formatted with toLocaleTimeString "en-US") — see namedLimit. NOT detected:
//     "<model> now uses usage credits · the prompt to confirm went unanswered".
//   Claude 2.1.284+: the extra-usage caps ("You've hit your monthly spend limit …", "… team's shared budget …", org/channel/individual,
//     "Your org is out of usage · …") — a limit, and a credit case unless the wording names a reset (see CLAUDE_CAP).
//   Claude 2.1.312+: the 5-hour window is called "5-hour limit" instead of "session limit" ("You've hit your 5-hour limit · resets
//     5:40pm (Europe/Berlin)", cap form "… · your 5-hour limit resets 5:40pm"). No pattern here hangs on the word "session" (namedLimit
//     takes any word before "limit", the reset follows "resets"); both wordings stay detected. Hints without a match stay without:
//     "Usage limit has reset · Press enter to continue", "A 5-hour limit reset isn't available right now.", "Approaching your 5-hour
//     usage limit …". Guard: limits.test.js.
//   Codex 0.155.0+: ALL seven templates "You’ve hit your usage limit …" carry a TYPOGRAPHIC apostrophe (U+2019) — the pattern with a
//     straight ' matched none, and a Codex run at the limit ended as an error instead of parking. Both apostrophes are read (Claude still
//     writes the straight one). `insufficient_quota` reads "Quota exceeded. Check your plan and billing details." — a limit, and a CREDIT
//     case (see CREDIT_PATTERNS; only this sentence or the code, not every quota). The plan templates (Plus, Pro, Free/Go) merely OFFER
//     credits and an upgrade — they are the time window and wait for their reset (OFFERING_PATTERNS). The reset reads "… or try again at
//     1:08 AM." or, on another day, "Try again at Oct 11th, 2026 1:08 AM." (`format_retry_timestamp`, CLI local time) — both are read by
//     clockTimeReset(). "Your workspace is out of credits …", the two spend-cap sentences ("You hit your spend cap …") and the
//     rate_limit form are read as well.
//   Codex structure: `RateLimitSnapshot { limit_id, limit_name, primary, secondary, credits, individual_limit, spend_control_reached,
//     plan_type, rate_limit_reached_type }` with `RateLimitWindow { used_percent, window_minutes, resets_at }`; rate_limit_reached_type
//     is one of primary | secondary | credits | spend_control_reached — it says directly WHICH kind hit. `CreditsSnapshot { has_credits,
//     unlimited, balance }`: has_credits says whether the account HAS a credit pot, not whether it is empty (see codexWindows()).

// Limits of automatic continuing (here so server and tests see the same values).
export const MAX_CONTINUES = 12; // continuations per chat before giving up
export const MAX_PROBES = 24;    // look-ups when the reset is unknown

// Groups both providers are mapped to.
export const GROUPS = Object.freeze({
  SESSION: "session", // Claude 5-hour window · Codex primary
  WEEKLY: "weekly",   // Claude 7-day window (also model-scoped) · Codex secondary
  CREDITS: "credits", // credit/extra usage used up — does NOT recover by itself
  SPEND: "spend",     // spend cap reached — likewise no time window
});

// TWO thresholds that mean different things and therefore stay side by side:
//
// EXHAUSTED_PERCENT (98) means "wait, nothing gets through any more": an attempt failed at the limit, the run is parked. Not 100,
// because the endpoint rounds and a run that just failed occasionally shows 99.
const EXHAUSTED_PERCENT = 98;

// START_GATE_PERCENT (99) means "do not start anything new": the window is as good as full, the next turn would run beyond the
// window — that is, against the credit. One step above 98 so that a nearly filled window does not lock already. Effective only if the
// user switched the credit gate on; see mayStartTurn().
export const START_GATE_PERCENT = 99;

// Wait a little after the reset — the provider's time calculation is not exact to the second, and a run that starts a second too
// early burns the attempt. Never start immediately (protects against a loop when a clock is wrong).
//
// Both values are read from the environment on EVERY CALL, not frozen at import — this rule lives here, the other knobs in the tree
// point to it. Reason: ten tests run through this path and each waited 45 s of real wall clock — 64 % of every gate test phase. A
// `const` would have silently measured the test at the production value. With no environment set the behavior is unchanged.
const envMs = (name, fallback) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
};
export const defaultGraceMs = () => envMs("CBASE_LIMIT_GRACE_MS", 45_000);
const minWaitMs = () => envMs("CBASE_LIMIT_MIN_WAIT_MS", 20_000);
// Nobody waits longer than the long window plus a reserve — then something else is broken.
export const MAX_WAIT_MS = 8 * 24 * 60 * 60 * 1000;

// ── Detection ───────────────────────────────────────────────────────────────
// The extra-usage caps of the Claude CLI (since 2.1.284): the template `at(name, suffix)` = "You've hit your ${name}${suffix}" with
// name ∈ monthly spend limit · org's monthly spend limit · individual spend limit · channel's monthly spend limit · team's shared
// budget · individual usage limit · org's/channel's monthly usage limit (suffix " · raise it at …", " · ask your admin to raise it at …"
// and, when the plan's window recovers, " · your <window> resets <time>") and the model-choice sentences ("You've hit your monthly
// spend limit. Switch to another model …", "You've hit your team's shared budget. /model to switch models."). A limit — and a credit
// case unless the wording names a reset (isCreditCase). Deliberately with a qualifier: "You've hit your usage limit" alone is Codex's
// time window.
const CLAUDE_CAP = /\byou['’]?ve hit your (?:(?:(?:org|channel)['’]s )?monthly (?:spend|usage) limit|individual (?:spend|usage) limit|spend limit|team['’]s shared budget)\b/i;
// Wordings that PROVE a usage limit. Only unambiguous phrasings; a bare "429" is deliberately not included (it also appears in URLs and
// foreign output) — it counts only together with a limit word, see RATE_PAIR.
const LIMIT_PATTERNS = [
  // Claude 2.1.259 (measured) + Anthropic API
  /usage limit reached/i,          // "Usage limit reached · continuing automatically at 12:40am"
  /usage credit limit reached/i,   // "Fast mode disabled · usage credit limit reached"
  // "You've reached your usage limit" (Codex), "you have reached your weekly usage limit" (Claude).
  // The "(?<!not )" is no decoration: a negation with the same wording would otherwise have parked.
  /(?<!not )reached your (?:[\w.\-]+ ){0,3}usage limit/i,
  /rate_limit_error/,
  /\brate[\s_-]?limit(?:ed|s)?\b/i,
  /too many requests/i,
  // Codex 0.151.0 (measured) — since 0.155.0 with a typographic apostrophe (U+2019, see header): "You’ve hit …".
  /you['’]?ve hit your usage limit/i,
  // Codex `QuotaExceeded` (OpenAI `insufficient_quota`) since 0.155.0: "Quota exceeded. Check your plan and billing details." — and every
  // other exhausted quota of a provider ("Quota exceeded for quota metric …"). Whether it is a credit case is decided by
  // CREDIT_PATTERNS. NOT the file-system message of EDQUOT ("Disk quota exceeded" on Linux, "Disc quota exceeded" on macOS): a full
  // disk quota is no usage limit, and a run dying of it must not park. Plus the same case in the wording of the OpenAI API
  // (third-party provider via a preset).
  /(?<!\bdis[ck] )\bquota exceeded\b/i,
  /\bexceeded your current quota\b/i,
  // "You're out of usage credits" (Claude), "Your workspace is out of credits" (Codex): that is a limit AND a credit case — without
  // this line it was neither, because `credits` is only read after a LIMIT_PATTERN has matched.
  /\bout of (?:usage )?credits\b/i,
  /UsageLimitReached/,
  /UsageLimitExceeded/i,           // error type of the app-server response
  /QuotaExceeded/,
  /credits[_ ]?depleted/i,         // CreditsDepleted, workspace_owner_credits_depleted
  /exceeded retry limit, last status: 429/i,
  // Codex `WorkspaceOwnerUsageLimitReached`/`WorkspaceMemberUsageLimitReached` (error.rs 0.153.1 and 0.162.1): "You hit your spend cap
  // set in your workspace. …" / "… set by the owner of your workspace. …" — no pattern matched this once: the run ended as an error,
  // without a row. A cap, see CREDIT_PATTERNS.
  /\bhit your spend cap\b/i,
  // The extra-usage caps of the Claude CLI (since 2.1.284), see CLAUDE_CAP.
  CLAUDE_CAP,
  /\byour org is out of usage\b/i,
];
// "429" counts only with a companion word — and the companion word only as a WORD: without a boundary, "rate" matched in "migrated",
// "generated", "separate" and "limit" in "unlimited"; a stderr with a line number 429 and such a word sufficed for "limit, reset unknown".
// The boundary is a LETTER before or after, not `\b`: an error code like `insufficient_quota` or `x_rate_limit` (underscore) still counts.
// A camelCase joint is a boundary too: a lowercase letter before a capital. With the first version (flag i, "no letter before") the
// failure reasons of Google-style providers that carry the word IN the name — "429 userRateLimitExceeded", "HTTP 429
// dailyLimitExceeded" — fell through, and such a run no longer parked but ended as an error. The joint needs upper and lower case,
// hence no flag i: the words are spelled in both forms per letter (`bothForms`). "migrated", "unlimited", "UNLIMITED" and "LIMITATION"
// stay without a joint — no companion word.
const bothForms = (word) => word.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
const JOINT_BEFORE = "(?:(?<![A-Za-z])|(?<=[a-z])(?=[A-Z]))";
const JOINT_AFTER = "(?:(?![A-Za-z])|(?<=[a-z])(?=[A-Z]))";
const COMPANION_WORD = new RegExp(`${JOINT_BEFORE}(?:${bothForms("rate")}(?:[\\s_-]?${bothForms("limit")}[A-Za-z]*)?`
  + `|${bothForms("limit")}(?:${bothForms("s")}|${bothForms("ed")})?|${bothForms("quota")}[A-Za-z]*`
  + `|${bothForms("too")}[\\s_-]?${bothForms("many")})${JOINT_AFTER}`);
const RATE_PAIR = [/\b429\b/, COMPANION_WORD];

// A NAMED window at its limit: "Fable limit reached", "Sonnet limit exceeded", "5-hour limit reached", "spend limit reached (daily;
// resets …)".
//
// The name is deliberately open. A fixed list (formerly session|weekly|opus|sonnet) goes stale with every model — Fable, Sol, Astra and
// the next are not in it, and an unrecognized limit means the run dies instead of waiting. So that harmless sentences still do not
// trigger, a deny list sits beside it. It is NOT guessed: it is exactly the other "… limit reached" messages found in the same
// binaries (Claude 2.1.259 and Codex 0.151.0) that have nothing to do with the usage quota.
const NO_QUOTA = new Set([
  // Claude 2.1.259: "Context limit reached", "Budget limit reached ($…)", "Concurrency Limit
  // reached", "Concurrent export limit reached", "Concurrent subagent limit reached",
  // "Subagent nesting limit reached (depth …)", "watch limit reached", "trigger limit reached",
  // "account device limit reached", "events because eventCountLimit reached"
  "context", "budget", "concurrency", "concurrent", "subagent", "export", "nesting", "depth",
  "watch", "trigger", "device", "event", "eventcount", "character", "token",
  // Codex 0.151.0: "retry limit reached", "memory limit reached", "recursion limit reached",
  // "{size limit reached}", "JIT stack limit reached", "agent thread limit reached",
  // "Agent depth limit reached", "Shadow stream limit reached", "OS file watch limit reached",
  // "Responses websocket connection limit reached"
  "retry", "memory", "recursion", "size", "stack", "thread", "agent", "connection", "stream",
  "shadow", "file", "websocket", "channel", "history",
]);
// Plus the template of the Claude CLI since 2.1.273: "You've hit your session limit · resets 5:40pm (Europe/Berlin)" — the window
// name stands BEFORE "limit", without "reached". Exactly ONE word in between: "You've hit your monthly spend limit" (a cap — detected
// via CLAUDE_CAP) and "You've hit your limit" do not match here; same deny list.
function namedLimit(text) {
  for (const re of [/\b([A-Za-z0-9][\w.\-]{1,24})\s+limit\s+(?:reached|exceeded)\b/gi, /\byou['’]?ve hit your ([A-Za-z0-9][\w.\-]{1,24}) limit\b/gi]) {
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (!NO_QUOTA.has(m[1].toLowerCase())) return m[0];
    }
  }
  return "";
}

// Credit/cap instead of a time window — so there is nothing to wait for.
const CREDIT_PATTERNS = [
  // Claude: "Your org is out of usage · add funds to continue" / "· contact your admin".
  /\byour org is out of usage\b/i,
  /credits[_ ]?depleted/i,
  // Claude "You're out of usage credits", Codex "Your workspace is out of credits"
  /\bout of (?:usage )?credits\b/i,
  /add credits to continue/i,
  /credit balance (?:is )?too low/i,
  /usage credit limit reached/i,
  /spend(?:ing)? (?:cap|limit) (?:reached|exceeded)/i,
  // Codex: "You hit your spend cap set in your workspace …" (see LIMIT_PATTERNS) — a cap, it does not recover.
  /\bhit your spend cap\b/i,
  /service_spend_limit_reached/,
  /spend_control_reached/,
  // OpenAI `insufficient_quota`: Codex since 0.155.0 "Quota exceeded. Check your plan and billing details." (`QuotaExceeded` in error.rs,
  // verbatim), the API itself "You exceeded your current quota, please check your plan and billing details." with the code
  // `insufficient_quota` in the body. That is the billing pot, not a time window — Codex itself treats it as final (`retry_delay` ⇒ None,
  // unlike the 429 of the rate_limit form). Deliberately ONLY these two forms: Gemini also writes the sentence "… please check your plan
  // and billing details" for an exhausted per-minute or daily quota ("… Please retry in 31s."), and that recovers by itself; likewise
  // "Quota exceeded for quota metric … per minute".
  /\bQuota exceeded\. Check your plan and billing details\b/,
  /\binsufficient_quota\b/,
];
// OFFERS instead of a finding: "purchase more credits", "Upgrade to Plus/Pro/Max". In Codex' plan templates of "You’ve hit your usage
// limit. …" (Plus, Pro, Free/Go — error.rs 0.162.1) they stand BESIDE the account's time window and the reset ("… or try again at Oct
// 12th, 2026 9:15 PM."): a way to continue at once, not a used-up credit. They were once in CREDIT_PATTERNS — chooseWait reads the credit
// hint from the text BEFORE the reset, and auto-continue gave up at every Plus, Pro and Free limit instead of waking at the reset. They
// therefore count as a credit case only where the time-window template is NOT present.
const OFFERING_PATTERNS = [/purchase (?:more )?credits/i, /upgrade to (?:plus|pro|max)/i];
const TIME_WINDOW_TEMPLATE = /you['’]?ve hit your usage limit/i;
// A Claude cap (CLAUDE_CAP) is a credit case as long as its wording names NO reset; if it names one (`resetAt` read), the plan's window or
// the extra-usage pot recovers there, and the run waits for it.
const isCreditCase = (text, resetAt = null) => {
  if (CREDIT_PATTERNS.some((re) => re.test(text))) return true;
  if (CLAUDE_CAP.test(text)) return !resetAt;
  return OFFERING_PATTERNS.some((re) => re.test(text)) && !TIME_WINDOW_TEMPLATE.test(text);
};

// At the Fable limit the CLI switches the model on its own and keeps running:
//   "Fable limit reached · continuing on <model> uses usage credits, …"  (2.1.259, measured)
// That is NOT a failure — the run goes on, just on another model and against the credit. It is not prevented (two layers doing the
// same would be worse than one), but it must not happen secretly either: the caller writes a history line from it. Pure and
// without side effects, so the line comes from the same wording the detection reads.
const MODEL_SWITCH = /\b([\w.\-]{2,24})\s+limit\s+reached\b[^\n]{0,12}?\bcontinuing on\s+([^\n,.·]{2,32}?)(?=\s+uses\b|\s*[,.·]|\s*$)/i;
export function detectModelSwitch(input = {}) {
  const text = typeof input === "string" ? input : collectFailureText(input);
  const m = MODEL_SWITCH.exec(text || "");
  if (!m) return null;
  return { limit: m[1], model: m[2].trim() };
}
// Model-scoped limit ("… for gpt-5.6-sol. Switch to another model now"). The sentence period is not part of the model name — without
// the lookahead "gpt-5.6-sol." stuck.
const MODEL_SCOPED = /usage limit for ([\w.\-]+?)\.?(?=[\s,;:)]|$)/i;

// A time of day that has already passed means TOMORROW — but only if it is clearly past. Reason: the asymmetry of the two errors:
// wrongly adding a day costs 24 hours of standstill, wrongly staying on today costs a failed attempt the caller immediately
// recognizes as a limit again and re-parks. The CLI writes the time to the minute (seconds are dropped), so a reset just printed lies up
// to 59 s "in the past" — five minutes of tolerance cover that with margin.
const RESET_CLOCK_TIME_TOLERANCE_MS = 5 * 60_000;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// The MOST COMMON spelling of the Claude CLI (formatter `Iu`): within 24 h a plain time of day, beyond that month and day before it;
// minutes are dropped at the full hour, AM/PM is lowercase without a space, the time zone can follow in parentheses. As rendered:
//   "resets 1:09pm (Europe/Berlin)"       "resets 12:40am (Europe/Berlin)"   "resets 2pm"
//   "Usage limit reached · continuing automatically at 12:40am (Europe/Berlin)"
//   "resets Sep 12, 3pm"                  "resets Sep 12, 11:09am"           "resets Sep 12 at 3pm"
//   "resets Oct 14, 2027, 11:09am"
// (Comma or "at" between date and time depends on the ICU version of the Node the CLI runs under — both separators are read.)
//
// ASSUMPTION, explicitly: the CLI writes LOCAL time without a zone in the time value; the zone in parentheses is display only and is NOT
// evaluated. Calculation is in the process's zone. That holds because CLI and server run in the same container (and with the local
// server in the same user account) — if the CLI were in another zone, the instant would be off by the zone offset.
// Codex (`retry_suffix`/`format_retry_timestamp` in error.rs, 0.153.1 and 0.162.1) writes "… or try again at 1:08 AM.", without an offer
// before it "… Try again at 1:08 AM." (capital) and on another day "Try again at Oct 11th, 2026 1:08 AM." The pattern must read both the
// capital "Try" (hence flag i) and the "at" BEFORE the date — otherwise the reset stays unknown and the run probes instead of waking at the reset.
const RESET_CLOCK_TIME = /\b(?:resets?|available again|try again|continuing(?:\s+automatically)?)\b[\s,]*(?:(?:(?:on|at)\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?)?[\s,]*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\b\.?/i;
function clockTimeReset(text, now) {
  const m = RESET_CLOCK_TIME.exec(text);
  if (!m) return null;
  const [, monthName, tagRaw, yearRaw, hourRaw, minuteRaw, half] = m;
  const minute = minuteRaw ? Number(minuteRaw) : 0;
  if (minute > 59) return null;
  const hourRawN = Number(hourRaw);
  if (hourRawN < 1 || hourRawN > 12) return null; // 12-hour clock; anything else is no match
  const hour = (hourRawN % 12) + (half.toLowerCase() === "p" ? 12 : 0);
  const nowMs = new Date(now);
  if (monthName) {
    const month = MONTHS[monthName.slice(0, 3).toLowerCase()];
    if (month == null) return null;
    const tag = Number(tagRaw);
    if (tag < 1 || tag > 31) return null;
    // Without a year the current year applies. A year change is deliberately NOT guessed: an instant shifted by a year would lie far
    // beyond MAX_WAIT_MS and thus be a refusal instead of a wait — the rare New Year's case rather ends in a short failed attempt.
    const year = yearRaw ? Number(yearRaw) : nowMs.getFullYear();
    const d = new Date(year, month, tag, hour, minute, 0, 0);
    const t = d.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const today = new Date(nowMs.getFullYear(), nowMs.getMonth(), nowMs.getDate(), hour, minute, 0, 0);
  let t = today.getTime();
  if (!Number.isFinite(t)) return null;
  // Already past ⇒ tomorrow: the next CALENDAR DAY, not 24 h later — on the day of a time change the day has 23 or 25 hours, and "+24 h"
  // missed a reset after midnight by an hour.
  if (t < now - RESET_CLOCK_TIME_TOLERANCE_MS) t = new Date(nowMs.getFullYear(), nowMs.getMonth(), nowMs.getDate() + 1, hour, minute, 0, 0).getTime();
  return t;
}

// Reset hints IN the text (second-best source when the usage endpoint is unreachable):
//   · legacy format of the Claude CLI: "usage limit reached|1782000000" (Unix seconds)
//   · ISO timestamp: "resets at 2026-07-30T18:20:00Z"
//   · relative: "try again in 3 hours 20 minutes" / "resets in 45m"
//   · time of day: "resets 12:40am (Europe/Berlin)" / "resets Sep 12, 3pm" — see clockTimeReset()
// The order is that of precision: the time of day comes LAST so that it does not take the digits from an ISO stamp or a relative value.
function resetFromText(text, now) {
  const epoch = /usage limit reached\|(\d{10,13})\b/i.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    return n > 1e12 ? n : n * 1000; // seconds or milliseconds
  }
  // The trailing "UTC" belongs to the instant but stands outside the ISO pattern — without the second group Date.parse would read
  // "2026-08-08 00:00 UTC" as LOCAL time (two hours off in this machine's zone).
  const iso = /(?:resets?|reset at|resets at|available again)[^0-9]{0,16}(\d{4}-\d{2}-\d{2}[T ][\d:]{5,8}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)(\s*UTC)?/i.exec(text);
  if (iso) {
    const raw = iso[1].replace(" ", "T");
    const withZone = iso[2] && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? `${raw}Z` : raw;
    const t = Date.parse(withZone);
    if (Number.isFinite(t)) return t;
  }
  const rel = /(?:try again|retry|resets?|available again)\s+in\s+((?:\d+\s*[hms](?:ours?|inutes?|econds?)?\s*)+)/i.exec(text);
  if (rel) {
    let ms = 0;
    for (const [, num, unit] of rel[1].matchAll(/(\d+)\s*([hms])/gi)) {
      const n = Number(num);
      ms += unit.toLowerCase() === "h" ? n * 3600_000 : unit.toLowerCase() === "m" ? n * 60_000 : n * 1000;
    }
    if (ms > 0) return now + ms;
  }
  return clockTimeReset(text, now);
}

// Collect the text of a failed run. Events count too because Codex delivers the error as a `turn.failed`/error item and Claude sends it
// along in the result event — not only on stderr.
export function collectFailureText({ resultText = "", stderr = "", events = [] } = {}) {
  const parts = [];
  if (resultText) parts.push(String(resultText));
  if (stderr) parts.push(String(stderr));
  for (const e of events || []) {
    if (!e) continue;
    if (typeof e === "string") { parts.push(e); continue; }
    // Only the fields in which error texts stand — not the whole event tree (it contains user text and might mention "rate limit"
    // harmlessly).
    for (const v of [e.error, e.message, e.result, e.text, e.detail, e?.error?.message, e?.item?.error, e?.item?.text]) {
      if (typeof v === "string" && v) parts.push(v);
    }
  }
  return parts.join("\n");
}

// → { hit, credits, model, resetAt, evidence }
export function detectLimitHit(input = {}) {
  const now = Number(input.now) || Date.now();
  const text = collectFailureText(input);
  if (!text) return { hit: false, credits: false, model: "", resetAt: null, evidence: "" };
  let evidence = "";
  for (const re of LIMIT_PATTERNS) {
    const m = re.exec(text);
    if (m) { evidence = m[0]; break; }
  }
  if (!evidence) evidence = namedLimit(text);
  if (!evidence && RATE_PAIR.every((re) => re.test(text))) evidence = "429";
  if (!evidence) return { hit: false, credits: false, model: "", resetAt: null, evidence: "" };
  const resetAt = resetFromText(text, now);
  return {
    hit: true,
    credits: isCreditCase(text, resetAt),
    model: MODEL_SCOPED.exec(text)?.[1] || "",
    resetAt,
    evidence: evidence.slice(0, 120),
  };
}

// ── Normalizing windows ─────────────────────────────────────────────────────
const ms = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000; // Codex delivers Unix SECONDS
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
const pct = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function windowsFromClaudeList(list) {
  const out = [];
  for (const l of list) {
    if (!l || typeof l !== "object") continue;
    const group = l.group === "weekly" ? GROUPS.WEEKLY : l.group === "session" ? GROUPS.SESSION : (String(l.kind || "").startsWith("weekly") ? GROUPS.WEEKLY : GROUPS.SESSION);
    const scope = l.scope?.model?.display_name || l.scope?.model?.id || "";
    out.push({
      id: String(l.kind || group),
      group,
      // Language-neutral identifier; the UI translates.
      label: scope ? `${group}:${scope}` : group,
      scope,
      percent: pct(l.percent),
      resetsAt: ms(l.resets_at),
      reached: false,
      provider: "claude",
    });
  }
  return out;
}

// Exactly the three disabled_reason values at which the credit no longer carries. The list is not guessed: the CLI itself checks the
// same three (Claude 2.1.259, measured).
const CREDIT_BLOCKED = new Set(["out_of_credits", "org_spend_cap_reached", "org_level_disabled_until"]);
// Currencies without decimals — the same set the CLI's money formatter keeps.
const ZERO_DECIMAL_CURRENCY = new Set(["JPY", "KRW", "VND"]);

// Credit state for DISPLAY (usage view in web and iOS). Pure, without network, without format — the UI does the labeling.
//
// The real fields of /api/oauth/usage are is_enabled, monthly_limit, used_credits, utilization, currency, disabled_reason; it has no
// `extra_usage.spend_limit_reached` (that exists only on an org route).
//
// Amounts come in CENTS. `limit`/`consumed` are the amounts in the currency unit — the conversion lives HERE and not in two clients,
// because it does not apply for JPY/KRW/VND and a hard-coded "/100" there would be off by a factor of 100.
//
// If `extra_usage` is missing altogether, the answer is `null` and not "no credit": empty is not unknown, and an invented zero would
// stand in the display like a measurement.
export function creditStatus(usage) {
  const e = usage && typeof usage === "object" ? usage.extra_usage : null;
  if (!e || typeof e !== "object") return null;
  const currency = String(e.currency || "USD").toUpperCase();
  const teiler = ZERO_DECIMAL_CURRENCY.has(currency) ? 1 : 100;
  const limitCent = typeof e.monthly_limit === "number" ? e.monthly_limit : null;
  const consumedCent = typeof e.used_credits === "number" ? e.used_credits : null;
  // The same calculation as the CLI: reported utilization, else consumed/cap; a cap of 0 counts as full (a credit set to 0 carries
  // nothing). WITHOUT a known cap the utilization stays empty — "unlimited" and "cap unknown" are not 100 %, and an invented number
  // would stand in the display like a measurement.
  let percent = pct(e.utilization);
  if (percent == null && consumedCent != null && limitCent != null) {
    percent = limitCent > 0 ? Math.max(0, Math.min(100, (consumedCent / limitCent) * 100)) : 100;
  }
  const reason = typeof e.disabled_reason === "string" ? e.disabled_reason : "";
  return {
    active: e.is_enabled === true,
    // ONLY an explicit null means "unlimited"; a missing field means unknown.
    unlimited: e.monthly_limit === null,
    limitCent,
    consumedCent,
    limit: limitCent == null ? null : limitCent / teiler,
    consumed: consumedCent == null ? null : consumedCent / teiler,
    currency,
    percent,
    reason,
    blocked: CREDIT_BLOCKED.has(reason),
  };
}

// Credit as a WINDOW (for ring, blockingWindow and chooseWait) — only when it really no longer carries. A credit cap is money, not a
// time window: the limit is therefore 100 and not EXHAUSTED_PERCENT, and there is no reset.
function creditWindow(usage) {
  const g = creditStatus(usage);
  if (!g) return null;
  const window = (group) => ({ id: "extra_usage", group, label: group, scope: "", percent: 100, resetsAt: null, reached: true, provider: "claude" });
  if (g.reason === "out_of_credits") return window(GROUPS.CREDITS);
  if (g.blocked) return window(GROUPS.SPEND); // org_spend_cap_reached · org_level_disabled_until
  if (g.active && !g.unlimited && g.limitCent != null && typeof g.percent === "number" && g.percent >= 100) {
    return window(GROUPS.SPEND); // the individual monthly cap is full
  }
  return null;
}

// Takes either the RAW response of /api/oauth/usage or the reduced form cbase caches ({ fiveHour, sevenDay }). Both occur: the cache in
// app_settings is the reduced form, a fresh fetch the raw one.
export function claudeWindows(usage) {
  if (!usage || typeof usage !== "object") return [];
  // The credit window applies in BOTH forms — the reduced cache form is fed by the same response.
  const credit = creditWindow(usage);
  if (Array.isArray(usage.limits) && usage.limits.length) {
    const out = windowsFromClaudeList(usage.limits);
    if (credit) out.push(credit);
    return out;
  }
  const out = [];
  const add = (raw, group, id, scope = "") => {
    if (!raw || typeof raw !== "object") return;
    const percent = pct(raw.utilization ?? raw.used_percentage ?? raw.percent);
    const resetsAt = ms(raw.resetsAt ?? raw.resets_at);
    if (percent == null && resetsAt == null) return;
    out.push({ id, group, label: scope ? `${group}:${scope}` : group, scope, percent, resetsAt, reached: false, provider: "claude" });
  };
  add(usage.fiveHour ?? usage.five_hour, GROUPS.SESSION, "session");
  add(usage.sevenDay ?? usage.seven_day, GROUPS.WEEKLY, "weekly_all");
  add(usage.seven_day_opus, GROUPS.WEEKLY, "weekly_opus", "Opus");
  add(usage.seven_day_sonnet, GROUPS.WEEKLY, "weekly_sonnet", "Sonnet");
  if (credit) out.push(credit);
  return out;
}

// Takes either the RAW rate_limits snapshot from the rollout file or the reduced form of codexUsage() ({ primary, secondary } with
// usedPercent/windowMinutes/resetsAt).
export function codexWindows(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const reached = String(snapshot.rate_limit_reached_type || snapshot.reachedType || "");
  const out = [];
  const add = (raw, key) => {
    if (!raw || typeof raw !== "object") return;
    const percent = pct(raw.used_percent ?? raw.usedPercent);
    const resetsAt = ms(raw.resets_at ?? raw.resetsAt);
    const minutes = Number(raw.window_minutes ?? raw.windowMinutes) || 0;
    if (percent == null && resetsAt == null) return;
    // Codex does not name the windows, it only gives their length: up to a day it is the short one ("primary"), beyond that the long
    // one ("secondary").
    const group = key === "secondary" || minutes > 24 * 60 ? GROUPS.WEEKLY : GROUPS.SESSION;
    out.push({ id: key, group, label: group, scope: "", percent, resetsAt, minutes, reached: reached === key, provider: "codex" });
  };
  add(snapshot.primary, "primary");
  add(snapshot.secondary, "secondary");
  // `has_credits: false` means "this account has no credit pot at all" — NOT "the credit is used up". Reading it that way turned an
  // account without a pot into an exhausted window: blockingWindow { percent: 100, group: "credits", reached: true } and chooseWait
  // { ok: false, reason: "credits" } — auto-continue could NEVER wait for Codex on such an account.
  //
  // Credit is used up only if Codex says so itself (rate_limit_reached_type "credits") or an EXISTING pot (has_credits true) is empty
  // (balance <= 0). If the state is missing it stays unknown — and unknown is not empty.
  const credits = snapshot.credits;
  const pot = credits && typeof credits === "object" && credits.unlimited !== true;
  const potEmpty = !!pot && credits.has_credits === true
    && typeof credits.balance === "number" && credits.balance <= 0;
  if (reached === "credits" || potEmpty) out.push({ id: "credits", group: GROUPS.CREDITS, label: GROUPS.CREDITS, scope: "", percent: 100, resetsAt: null, reached: true, provider: "codex" });
  if (reached === "spend_control_reached" || reached === "spend" || snapshot.spend_control_reached === true) {
    out.push({ id: "spend", group: GROUPS.SPEND, label: GROUPS.SPEND, scope: "", percent: 100, resetsAt: null, reached: true, provider: "codex" });
  }
  return out;
}

// ── Determining the wait ────────────────────────────────────────────────────
// A window is exhausted when the provider says so itself (Codex: rate_limit_reached_type) or the percentage is at its limit.
export const isExhausted = (w) => !!w && (w.reached === true || (typeof w.percent === "number" && w.percent >= EXHAUSTED_PERCENT));

// ── Display: WHICH window belongs in the usage ring? ────────────────────────
// One rule for all providers and all clients (desktop, mobile, settings).
//
// The ring shows the SESSION WINDOW: for Claude the 5 hours across ALL models (`limits[].kind = "session"` or the legacy field
// `five_hour`), for Codex the short window. That is the number one plans one's day by. A model-scoped limit (say "Fable 100 %")
// explicitly does NOT belong in the ring — it says nothing about the remaining session capacity, and as the ring value it once stood at
// 100 % for days although 98 % of the window was free. What currently blocks is told by `blockingWindow()` (tooltip + settings).
//
// If the session window fails entirely (no percentage, no reset), the strictest known window steps in — better a named substitute
// value than a vanished ring (an exhausted window often brings no percentage, Codex then writes `primary: null`).
export function ringWindow(windows = []) {
  const known = windows.filter((w) => w && (typeof w.percent === "number" || isExhausted(w)));
  if (!known.length) return null;
  const session = known.find((w) => (w.group || GROUPS.SESSION) === GROUPS.SESSION && !w.scope);
  const pick = session || blockingWindow(known) || known.reduce((a, b) => ((b.percent ?? -1) > (a.percent ?? -1) ? b : a));
  // Exhausted without a percentage (Codex at the limit, credit/cap) → show 100, not "—".
  return { ...pick, percent: typeof pick.percent === "number" ? pick.percent : 100 };
}

// Which window is at its limit right now? With several, the one with the LATEST reset, since it holds the longest (same rule as
// chooseWait). That is the extra information beside the ring: "5h free, but the Fable weekly limit stands" — and the source of the
// extra bar in settings, where model-scoped limits would otherwise not appear at all.
export function blockingWindow(windows = []) {
  const blocked = windows.filter(isExhausted);
  if (!blocked.length) return null;
  const dated = blocked.filter((w) => typeof w.resetsAt === "number" && w.resetsAt > 0);
  return dated.length ? dated.reduce((a, b) => (b.resetsAt > a.resetsAt ? b : a)) : blocked[0];
}

// Window in the form the clients render (timestamps as ISO — the HTTP responses carry reset instants everywhere as ISO strings).
function payload(w) {
  if (!w) return null;
  return {
    percent: Math.max(0, Math.min(100, Math.round(typeof w.percent === "number" ? w.percent : 100))),
    resetsAt: typeof w.resetsAt === "number" && w.resetsAt > 0 ? new Date(w.resetsAt).toISOString() : null,
    group: w.group || GROUPS.SESSION,
    scope: w.scope || "",
    windowMinutes: typeof w.minutes === "number" && w.minutes > 0 ? w.minutes : null,
    reached: isExhausted(w),
  };
}
export const ringPayload = (windows = []) => payload(ringWindow(windows));
export const blockingPayload = (windows = []) => payload(blockingWindow(windows));

// ── Start gate: may a NEW turn start? ───────────────────────────────────────
// The credit gate is a global setting (Settings → Usage). When it is on, cbase starts no new turn from START_GATE_PERCENT (99) on but
// parks as with the time limit.
//
// What the gate REALLY does, and what the label must therefore say: it prevents the START of a turn, not the credit consumption of a
// RUNNING one. Whether credit is consumed beyond the window is decided by the provider's server and communicated only in the response
// headers of the model request; there is no flag, no environment variable and no configuration file for it. The hard lock sits in the
// account (extra usage or monthly spend limit) — the UI points to that.

// Does a window belong to the chat's model? A window without `scope` applies to all models. A model-scoped one carries as `scope` the
// DISPLAY NAME from /api/oauth/usage ("Fable", "Opus", "Sonnet" — `scope.model.id` is null there), the chat a catalog id
// ("claude-fable-5-1", "claude-opus-4-8"). So word parts are compared: every word of the display name must occur in the id. "Fable"
// matches "claude-fable-5-1" and "fable"; a fictitious "Opus 4.8" would match "claude-opus-4-8" but not "claude-opus-5". An id form with a
// provider prefix ("claude::claude-fable-5-1") reads the same. When in doubt — empty model, unknown form — the answer is "does not
// belong": the gate then does not stand on a foreign window (see gateWindow, point 3).
const modelWords = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
export function windowAppliesForModel(w, model = "") {
  if (!w?.scope) return true;
  const chat = modelWords(model);
  if (!chat.length) return false;
  const words = modelWords(w.scope);
  return words.length > 0 && words.every((t) => chat.includes(t));
}
// The windows that count at all for a chat with this model — ONE place for gate, wait time and wake check. Without it only gateWindow
// cut away the foreign model windows; `chooseWait` and `stillBlocked` calculated with all, and a Sonnet chat the gate held at its
// session window got Fable's weekly reset as its resume time — six days for a window the gate had just discarded as "does not belong".
export const windowForModel = (windows = [], model = "") => (windows || []).filter((w) => w && windowAppliesForModel(w, model));

// Does a window still say something about the FUTURE? An exhausted window whose reset has passed is a number from earlier: the
// provider has not rolled it yet, or the cache carries the old state. It is no lock — the same rule for the start gate as for the wake
// check (stillBlocked). Without it the gate held every window ≥ 99 % as a lock, chooseWait found the reset in the past and set the row
// to "now + minimum wait" — a new gate row and a notice every 20 seconds, without a cap, as long as the provider did not roll the window.
const windowStillValid = (w, now) => !(typeof w.resetsAt === "number" && w.resetsAt > 0) || w.resetsAt > now;

// Four kinds stay out — all the cuts stand HERE and not at the caller, so that execution side and display give the same answer:
// gateWindow() is also the source of the window the card at the chat names.
//
// 1. Codex. It has no query endpoint; its value comes from the session file of the last run and is structurally stale — a gate on it
//    parked for no reason or too late.
// 2. Credit and spend caps (GROUPS.CREDITS, GROUPS.SPEND). The gate asks "would the next turn run beyond the window and thus against
//    the credit?" — an empty pot does not answer that, it only says "no credit flows here any more". A turn in a fresh 5-hour window
//    costs none, and exactly that one the gate used to stop: at 3 % session and used-up extra usage EVERY turn parked, and the wait row
//    promised a reset a credit pot does not have.
// 3. Model-scoped windows of ANOTHER model (identifier `scope`, the same ringWindow excludes for the same reason). A full Fable weekly
//    limit says nothing about a Sonnet chat; without this cut it parked every chat of every model for up to seven days. Without a model
//    a model-scoped window counts as NOT belonging: a chat without a model runs the default, and that is not the model that has a
//    window of its own — when in doubt the turn starts instead of standing on a foreign window.
// 4. Windows whose reset has passed (windowStillValid): a number from earlier, no statement about the next turn — see there.
//
// THE ONE RULE for waiting and not starting: waiting and not starting stand only on TIME LOCKS — windows of the groups session/weekly
// (isTimeWindow), at the threshold of the asking side (atTheMarker: the gate 99, wake check and wait time 98), reset not passed
// (windowStillValid). Credit and spend caps are NEVER a time lock; they alone are the refusal "does not recover by itself" of a failed
// start without a time reference (chooseWait, reason "credits"). Gate (gateCandidates), wake check (stillBlocked → timeLocks) and wait
// time (chooseWait) read the same three predicates. Otherwise stillBlocked counted a credit window without a reset as a valid lock —
// forever —, and on an account with empty extra usage (`disabled_reason: "out_of_credits"`, a PERMANENT account state) no parked row ever
// continued by itself: the wake timer saw "session 4 %, credit 100 %" at the reset, probed 10/20/30/45/60 min and dropped the job after 24
// looks ("gave-up"), while the gate would have started the same turn without hesitation. Guard: limits.test.js "gate and wake timer give
// the same answer" and credit-wake-check.test.js (the incident with a real server).
export const isTimeWindow = (w) => !!w && w.group !== GROUPS.CREDITS && w.group !== GROUPS.SPEND;
const atTheMarker = (w, threshold) => w.reached === true || (typeof w.percent === "number" && w.percent >= threshold);
// The time locks among the windows — exhausted from `threshold`, reset not passed. The windows are already cut to the chat
// (windowForModel at the caller); the gate cuts itself (gateCandidates).
export const timeLocks = (windows = [], { now = Date.now(), threshold = EXHAUSTED_PERCENT } = {}) =>
  (windows || []).filter((w) => isTimeWindow(w) && atTheMarker(w, threshold) && windowStillValid(w, now));
// The windows that concern the gate at all (cuts 1–3) — BEFORE the time question (cut 4).
const gateCandidates = (windows = [], model = "") => (windows || []).filter((w) => w && w.provider !== "codex"
  && isTimeWindow(w)
  && windowAppliesForModel(w, model)
  && atTheMarker(w, START_GATE_PERCENT));
// Does the gate stand on a number from earlier? A locking window whose reset has passed is no answer but a reason to ask the provider
// FRESH (runs/limit-gate.js creditGateStatus otherwise reads from the 60-second cache). Only a fresh measurement with the same picture
// means "the provider has not rolled the window yet" — and then cut 4 applies.
export const gateWindowStale = (windows = [], { model = "", now = Date.now() } = {}) =>
  gateCandidates(windows, model).some((w) => !windowStillValid(w, now));
// The locks of the GATE (cuts 1–4): the windows that hold a new turn of this model now. gateWindow picks the naming one from them, and
// ONLY from them gateWaitTime computes how long a gate row waits.
export const gateLocks = (windows = [], { model = "", now = Date.now() } = {}) =>
  gateCandidates(windows, model).filter((w) => windowStillValid(w, now));
export function gateWindow(windows = [], { model = "", now = Date.now() } = {}) {
  const candidates = gateLocks(windows, { model, now });
  if (!candidates.length) return null;
  // With several, as with blockingWindow and chooseWait, the one with the LATEST reset applies.
  const dated = candidates.filter((w) => typeof w.resetsAt === "number" && w.resetsAt > 0);
  return dated.length ? dated.reduce((a, b) => (b.resetsAt > a.resetsAt ? b : a)) : candidates[0];
}
export const gatePayload = (windows = [], opts = {}) => payload(gateWindow(windows, opts));

// → { ok, reason, window }
//   reason "off"          gate switched off — cbase does not interfere
//   reason "free"         gate on, no window at the mark
//   reason "overruled"    the human pressed "Start anyway (costs credit)"; that applies to EXACTLY this one turn, remembering is the caller's job
//   reason "credit-gate"  the turn does not start and is parked as with the time limit
//
// The gate applies to ALL runs: also to typed messages, so the human makes the decision explicitly instead of implicitly by typing. For
// automatic runs the caller reads the value before the start; for typed messages it takes the WARM cache and forces no network call — a
// fetch before every message made the chat sluggish.
//
// `model` is the chat's model (catalog id); it decides whether a model-scoped window concerns this turn at all (gateWindow, point 3).
// Without it only the windows across all models count.
export function mayStartTurn({ windows = [], gateOn = false, overruled = false, model = "", now = Date.now() } = {}) {
  if (!gateOn) return { ok: true, reason: "off", window: null };
  const window = gateWindow(windows, { model, now });
  if (!window) return { ok: true, reason: "free", window: null };
  if (overruled) return { ok: true, reason: "overruled", window };
  return { ok: false, reason: "credit-gate", window };
}

// THE one wording with which a model call intercepted at the gate fails.
//
// The gate checks not only in doRun but at the spawn layer — a oneshot too (verdict, title, compaction, filing chain) can get stuck on
// it, and it then throws an error with EXACTLY this text. The text is built so the existing detection reads it as a limit without a
// new pattern: "Usage limit reached" matches LIMIT_PATTERNS, and "resets at <ISO>" is the form from which resetFromText reads the
// instant back to the millisecond — the caller that catches the error (filing chain, parkJudge, compactChatContext) thus lands on the
// same parking path as with a real CLI limit, without knowing the gate case separately. The reset part is omitted if the window knows
// none; the caller then probes as with "reset unknown".
//
// No credit word in the text: the gate stands only on time windows (gateWindow cuts credit and caps away), and "credits" in the
// wording would make detectLimitHit wrongly conclude a credit case — then nobody would wait for the reset that is named here.
//
// If the window is missing (theoretically — mayStartTurn always returns one on ok:false), the same fallback group applies as at the
// caller in runs/limit-gate.js (GROUPS.SESSION), so both sides write the same sentence.
export function gateLimitText(window) {
  const w = window && typeof window === "object" ? window : {};
  const label = String(w.label || w.group || GROUPS.SESSION);
  const percent = Math.round(typeof w.percent === "number" && Number.isFinite(w.percent) ? w.percent : 100);
  const resetsAt = typeof w.resetsAt === "number" && w.resetsAt > 0 ? new Date(w.resetsAt).toISOString() : "";
  return `Usage limit reached — credit gate: ${label} ${percent} %${resetsAt ? ` · resets at ${resetsAt}` : ""}`;
}

// Which window holds the run up, and when may it continue?
//
// IMPORTANT: if several windows are exhausted (typically 5-hour AND week), the LATEST reset applies. With the earliest the run would
// start at the 5-hour boundary, fail at once at the weekly limit and burn the attempt.
//
// DATED windows first, credit afterward — the order is no matter of style. Credit is the pot BEYOND the time windows: a fresh window
// runs without credit, a full credit or spend cap does not block it. With the credit check BEFORE the dated windows, a full monthly cap
// made EVERY 5-hour limit unwaitable: instead of "continue at 19:40" came "does not recover by itself", the run ended as an error and
// the prompt was gone. The refusal "credits" therefore applies only if NO dated exhausted window is present — then there really is
// nothing to wait for.
//
// The same predicates as gate and wake check (see timeLocks): DATED is only a time lock with an UPCOMING reset — a past reset is a number
// from earlier and no basis for waiting (otherwise the wake timer planned "now + minimum wait", without a counter, as long as another
// window held the lock: a 20-s loop in new form). And a credit/cap WINDOW no longer beats the reset hint of the message: the order is
// dated → credit hint of the message → reset hint → time lock without reset (probe) → credit/cap window → unknown. Otherwise a
// permanently empty extra usage turned every limit hit whose window the endpoint did not show at ≥ 98 % into "does not recover by itself"
// — including a dropped prompt.
//
// And without a hint a credit/cap WINDOW decides the refusal only if there is NO time window at all: a pot is an account state, not a
// cause. Empty extra usage (`is_enabled:false`, `out_of_credits`) cannot have caused a limit hit — the CLI named a TIME limit ("5-hour
// limit reached"), and the endpoint shows the window below 98 % for a while after a hit (account/usage.js, fetchUsageLimits). If a time
// window is present, the answer is "unknown" — probe, as the same situation without a pot. The proof that the pot really carried comes
// from the message alone (`creditsHint`: "out of usage credits", Codex "out of credits").
export function chooseWait({
  windows = [], now = Date.now(), hintResetAt = null, creditsHint = false,
  grace = defaultGraceMs(), maxWaitMs = MAX_WAIT_MS,
} = {}) {
  const blocking = windows.filter(isExhausted);
  const time = timeLocks(windows, { now });
  const dated = time.filter((w) => typeof w.resetsAt === "number" && w.resetsAt > 0);
  // Exhausted time windows whose reset has passed: a number from earlier. They carry only if NO valid time lock is present — a run that
  // just failed at the limit while the endpoint has not rolled the window yet then waits the minimum wait. If a valid lock without a date
  // holds the row, they are NO basis for waiting: at the wake timer that meant "now + 20 s" without a counter, endlessly.
  const past = time.length ? [] : blocking.filter((w) => isTimeWindow(w) && typeof w.resetsAt === "number" && w.resetsAt > 0);
  let base = null, window = null;
  if (dated.length || past.length) {
    // latest reset wins (see above)
    window = (dated.length ? dated : past).reduce((a, b) => (b.resetsAt > a.resetsAt ? b : a));
    base = window.resetsAt;
  } else {
    // Credit/caps do not recover by themselves → nothing to wait for. The credit HINT of the message (the CLI itself says "out of
    // credits") applies before its reset hint; a credit WINDOW only if there is no time reference at all — not even a time window below
    // the mark (see above).
    const noRecovery = blocking.find((w) => !isTimeWindow(w)) || null;
    if (creditsHint) return { ok: false, reason: "credits", window: noRecovery, resumeAt: null, windows: blocking };
    if (typeof hintResetAt === "number" && hintResetAt > 0) {
      base = hintResetAt; // from the error message
    } else if (noRecovery && !windows.some(isTimeWindow)) {
      return { ok: false, reason: "credits", window: noRecovery, resumeAt: null, windows: blocking };
    } else {
      // The limit is certain, the reset unknown → the caller probes with backoff.
      return { ok: false, reason: "unknown", window: time[0] || null, resumeAt: null, windows: blocking };
    }
  }
  const resumeAt = Math.max(base + grace, now + minWaitMs());
  if (resumeAt - now > maxWaitMs) return { ok: false, reason: "too-long", window, resumeAt, windows: blocking };
  return { ok: true, reason: "reset", window, resumeAt, windows: blocking };
}

// How long does a GATE row wait? Exactly as long as the gate holds — chooseWait over the gate locks alone (gateLocks: threshold 99, model
// cut, no Codex, reset not passed). WHETHER a gate row waits was asked of the gate, but HOW LONG of chooseWait over all time locks from
// 98 % with the latest reset. Session 99.5 % (reset in 1 h) and week 98.5 % (reset in 3 days): the gate held only on the session and
// would have started the turn after its reset, the row slept until the week, and the strip named a time days ahead. Description side =
// execution side: wait time and lock come from the SAME windows. Callers: creditGateHolds (turn), maybeAutoContinue with `gate`
// (oneshot) and the wake timer of a gate row (runs/limit-gate.js waitTimeFor). A limit row keeps waiting by chooseWait — it waits for
// the time lock.
export function gateWaitTime({ windows = [], model = "", now = Date.now(), hintResetAt = null, grace, maxWaitMs } = {}) {
  return chooseWait({ windows: gateLocks(windows, { model, now }), now, hintResetAt, grace, maxWaitMs });
}

// Reset unknown: look again in growing steps whether the limit still stands. Deliberately coarse — a look at the usage endpoint costs
// nothing, a burned run does.
const PROBE_STEPS_MS = [5, 10, 20, 30, 45, 60].map((m) => m * 60_000);
export function probeDelayMs(attempt = 0) {
  const i = Math.max(0, Math.min(PROBE_STEPS_MS.length - 1, attempt));
  return PROBE_STEPS_MS[i];
}
// The interval to the NEXT look, from the number of probes already made (`probes` BEFORE incrementing) — ONE rule for all three places
// (parking at the limit, parking at the gate, wake check). Otherwise each path counted differently (timer `probes + 1`, parking
// `probes`, gate fixed 0): depending on the path the 5- or the 10-minute step was missing.
export const nextProbing = (probes = 0) => probeDelayMs(Math.max(0, Number(probes) || 0));

// Does the limit STILL stand when continuing? (Checked before restarting a run so that a reset instant that is too early does not
// immediately produce the next failed attempt.) Only time locks (timeLocks): a credit or cap window has no reset and would otherwise hold
// every row forever that the gate would long since let start.
export function stillBlocked(windows = [], { now = Date.now() } = {}) {
  return timeLocks(windows, { now }).length > 0;
}
