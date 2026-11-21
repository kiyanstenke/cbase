// The two usage settings: auto-continue (toggle A) and credit gate (toggle B) — settings, timers, limit windows
// (limitWindowsFor), detection of the switch to credits, creditGateStatus, the gate verdict (gateVerdict,
// gateVerdictHook — at the spawn layer), the wait row (WAIT_ROW_RANG, parkOrQueue), creditGateHolds.
// Next to it projectLockHolds: the lock per project at the turn, asked in doRun BEFORE the credit gate — the same
// wait row (parkOrQueue), its own reason "project" or "serverEnd". And clearAwayGateWithoutTurn: what a turn gives
// back that does not get past both.

import crypto from "node:crypto";
import { codexRateLimitSnapshot, codexUsage, providerForChat } from "../providers/index.js";
import * as limits from "../limits.js";
import * as store from "../store.js";
import { T, clockText as clockTextValue } from "../i18n.js";
import { defaultModelFor } from "../account/providers.js";
import { enqueueRunInput } from "./queue.js";
import { fetchUsageLimits, usageInMemory } from "../account/usage.js";
import { emitAutoContinue, limitLine, limitNotification, clearAwayRunRow, scheduleAutoContinue, drainQueue } from "./auto-continue.js";
import { CAUSES, abortedRuns, running } from "./state.js";
import { withoutTransition, projectCheckBackMs, startLock } from "./project-lock.js";
import { fireHooks } from "./hooks.js";
import { broadcast, sse } from "../runtime/sse.js";
import { releaseTurn } from "./instance.js";


// ── Auto-continue at the usage limit ─────────────────────────────────────────
// If a run fails because the subscription limit is hit (Claude: 5-hour/weekly window, also per model; Codex:
// primary/secondary/credits), the run is NOT filed as an error but parked and started again exactly when the limit
// has reset. The decision "which window blocks, when is it free" is in the pure module limits.js.
const AUTO_CONTINUE_SETTING = "auto_continue"; // "0" switches off (default: on)
const autoContinueEnabled = () => store.getSetting(AUTO_CONTINUE_SETTING, "1") !== "0";
// Credit gate: a global setting, default OFF. If on, cbase starts no new turn from limits.START_GATE_PERCENT but
// parks as at the time limit.
const CREDIT_GATE_SETTING = "credit_gate"; // "1" switches on (default: off)
const creditGateOn = () => store.getSetting(CREDIT_GATE_SETTING, "0") === "1";
// The threshold is in limits.js (START_GATE_PERCENT), not here — TWO thresholds mean different things and so both
// need ONE source:
//   98 (EXHAUSTED_PERCENT) means "wait, nothing gets through anymore": an attempt failed, the run is parked. Not
//      100 because the endpoint rounds.
//   99 (START_GATE_PERCENT) means "start nothing new": one step higher so a barely filled window does not lock yet.
// How old the measured usage value may be at most for the gate to PARK on it. fetchUsageLimits passes the last cache
// through without limit on a network error or 429; without an age check the gate would park on yesterday's value.
// The clients' poll keeps the cache warm every 45 s — five minutes are generous and still clearly "current".
const CREDIT_GATE_MAX_AGE_MS = 5 * 60_000;
// The one-time release "start anyway" is NOT a state but an argument of the start it releases: fireAutoContinueInner
// passes `overruled` to exactly the one doRun it starts itself. A set consumed at the NEXT arbitrary gate check could
// be left behind on an abort path and release a foreign turn hours later.
//
// Turn release (an ARGUMENT, not a set): the gate decides at the turn start; what the turn then triggers as model
// work says so to the start gate explicitly — `runOnce(…, { approval: true })` for the turn's own trailers (title,
// curator), `overruled: true` for the verdict chain that a "start anyway" released. With a Set<chatId> entered in
// doRun and removed in its finally, the microtask order would decide WHICH post-turn verdict still ran under it. A
// rule that depends on an `await` is none. Subagents need neither: they run through runChat, which knows no start
// gate — they are part of the turn that starts them.
//
// Chats whose running turn was released by "start anyway (costs credit)". The marker only RESTRICTS: it keeps the
// queue from being injected into this process (deliverUserPrompt, doRun at the `result`) — a queued task is a NEW
// turn and gets its own gate decision instead of running along under the one turn's release. Entered after the gate
// is passed, removed in the run's finally; a marker left behind could at most prevent an injection, never release a
// turn.
const runOverruled = new Set(); // chatIds
const autoContinueTimers = new Map(); // chatId → Timeout
// Who is being executed right now. fireAutoContinue waits for the provider's limit state (await), and in that gap
// the row is still due and the chat not yet in `running` — without this lock the 60 s tick would start the same
// parked run a second time.
const autoContinueFiring = new Set();
// Due rows are also checked regularly: a setTimeout over hours is not reliable (sleep, time jumps), and after a
// restart there is none yet.
//
// The tick is adjustable: a row that meets a RUNNING chat when woken is moved on by exactly one tick (see
// `auto-continue.js`) — in a test that would mean waiting 60 s to check one second of facts. In production it stays
// one minute; the gate sets 2 s, as for `CBASE_LIMIT_GRACE_MS`/`_MIN_WAIT_MS`.
//
// Read LAZILY, not when the module loads: a test sets its environment at the file head, and otherwise whether the
// import comes before or after decides the value.
const autoContinueSweepMs = () => Number(process.env.CBASE_SWEEP_MS) || 60_000;

function clearAutoContinueTimer(chatId) {
  const t = autoContinueTimers.get(chatId);
  if (t) { clearTimeout(t); autoContinueTimers.delete(chatId); }
}

// Language-neutral window group → text for display and history.
function limitGroupText(group, label = "") {
  const scope = String(label || "").includes(":") ? String(label).split(":").slice(1).join(":") : "";
  const base = group === limits.GROUPS.SESSION ? T("5-hour limit")
    : group === limits.GROUPS.WEEKLY ? T("weekly limit")
    : group === limits.GROUPS.CREDITS ? T("usage credits")
    : group === limits.GROUPS.SPEND ? T("spend cap")
    : T("usage limit");
  return scope ? `${base} (${scope})` : base;
}
// The time of day of the server texts (history rows, notification/push, wait sentence) in the HUMAN's zone — i18n.js
// clockText, fallback described there. In the process's zone the user container would say UTC.
const clockText = (ts) => clockTextValue(ts);

// Fetch the provider's limit windows. Claude: the usage endpoint (fresh, not from the 60 s cache). Codex: the
// rate_limits snapshot from the thread's rollout file — purely local. Third-party providers (loop engine) have no
// such source; then it stays with what the error message gives (reset hint) or with probing.
//
// Only the windows that concern the CHAT (limits.windowForModel): a model-specific window of another model says
// nothing about a Sonnet chat. Both callers (maybeAutoContinue, fireAutoContinueInner) get the windows here, so the
// cut applies at ONE place.
// Does the lock of a parked row still hold at the timer? → the locking window or null. A gate row (`gateRow`) asks
// the GATE — limits.gateWindow with the same model creditGateHolds takes —, every other row the time locks
// (limits.timeLocks ≙ stillBlocked). Credits and spend cap lock in neither.
function lockingWindow({ gateRow = false, chat = null, providerId = "", windows = [], now = Date.now() } = {}) {
  if (gateRow) return limits.gateWindow(windows, { model: chat?.model || defaultModelFor(providerId), now });
  const z = limits.timeLocks(windows, { now });
  return z.length ? z.reduce((a, b) => ((b.resetsAt || 0) > (a.resetsAt || 0) ? b : a)) : null;
}
// Is the gate free for a parked gate row EARLIER than at its reset (account switch)? The gate parks until the reset
// of the window it held — if the human switches the account in the meantime (or the window empties otherwise), the
// row would still wait until the OLD account's reset, up to seven days, unless someone pressed "try now". Asked
// without a network call (account/usage.js usageInMemory) and only via a measurement made AFTER the row was last
// written (`since` = `updatedAt`): an older one is the one it was parked on, and every timer that reschedules the row
// moves `updatedAt` — so the same measurement wakes the same row at most once. The measurement is evaluated at ITS
// time, not now: otherwise every window whose reset has passed meanwhile would be "free", and the normal reset would
// start before the grace time, labelled as an account switch — the timer wakes the normal reset at `dueAt`, the
// caller keeps the two apart. The question itself is the timer's (lockingWindow with `gateRow`, the chat's model);
// it asks again before the start, freshly measured (limitWindowsFor). Claude only — the gate does not judge for
// other providers. Applies ONLY to turn rows: a parked verdict or compaction ran with a model of its own
// (`gate.model`) that the row does not carry — for those the caller asks gateFreeForAllByMeasurement.
function gateFreeByMeasurement({ chat = null, providerId = "", since = 0 } = {}) {
  if (providerId !== "claude") return false;
  const usage = usageInMemory();
  const measuredAt = Number(usage?.at) || 0;
  if (!measuredAt || measuredAt <= since) return false;
  const windows = limits.windowForModel(limits.claudeWindows(usage), chat?.model || defaultModelFor(providerId));
  return !lockingWindow({ gateRow: true, chat, providerId, windows, now: measuredAt });
}
// The stricter question for everything whose model no row carries (workflow agents at the gate, outer-loop runs at
// the gate, parked verdicts and compactions): does the gate hold for NO model anymore (no time lock at the gate
// threshold, model-specific windows included)? Then everyone woken starts, nobody parks again from the same
// measurement. Evaluated at its time as above. → the measurement time or 0.
function gateFreeForAllByMeasurement({ since = 0 } = {}) {
  const usage = usageInMemory();
  const measuredAt = Number(usage?.at) || 0;
  if (!measuredAt || measuredAt <= since) return 0;
  return limits.timeLocks(limits.claudeWindows(usage), { now: measuredAt, threshold: limits.START_GATE_PERCENT }).length ? 0 : measuredAt;
}
// …and until when? From THE SAME question: a gate row waits as long as the gate holds (limits.gateWaitTime, the same
// model as above), every other until the end of the time locks (limits.chooseWait) — otherwise a gate row would be
// rescheduled until the weekly reset the gate never waited for. `model`: the model the gate judged on if it is not
// the chat's (an intercepted oneshot, `err.gate.model`); `hintResetAt`: the reset from its message.
function waitTimeFor({ gateRow = false, chat = null, providerId = "", windows = [], now = Date.now(), model, hintResetAt = null } = {}) {
  if (!gateRow) return limits.chooseWait({ windows, now, hintResetAt });
  const gateModel = typeof model === "string" ? model : (chat?.model || defaultModelFor(providerId));
  return limits.gateWaitTime({ windows, model: gateModel, now, hintResetAt });
}

async function limitWindowsFor(providerId, chat, { force = true } = {}) {
  const model = chat?.model || defaultModelFor(providerId);
  try {
    if (providerId === "codex") {
      const snap = codexRateLimitSnapshot({ threadId: chat?.claudeSessionId || "" });
      if (snap) return limits.windowForModel(limits.codexWindows(snap), model);
      // Fallback only via the homes of the user container: a project home counts only with the rollout of its own thread (above).
      const u = codexUsage("", { projectHomes: false });
      return u?.connected ? limits.windowForModel(limits.codexWindows(u), model) : [];
    }
    if (providerId === "claude") return limits.windowForModel(limits.claudeWindows(await fetchUsageLimits({ force })), model);
  } catch (e) { console.error("[limit] windows not readable:", e?.message || e); }
  return [];
}

// ── The provider switches by itself: make it visible, do not prevent it ──
// Two DIFFERENT facts, so two detections — and neither twice:
//
//   1. MODEL SWITCH ("Fable limit reached · continuing on Opus 5 …"): the run continues on another model. It is
//      detected in limits.js (`detectModelSwitch`), where the wording stands next to all other limit patterns.
//   2. BILLING SWITCH ("You're now using usage credits", "Now using extra usage", …): the same model, but against
//      the credits from now on. These sentences are ONLY here because limits.js does not keep them and they carry no
//      limit decision — they are pure information.
//
// The wordings are READ FROM THE BINARY of the installed CLI, not guessed. Nothing is prevented — only made visible.
const CREDIT_SWITCH_PATTERN = [
  /\bYou'?re now using (?:usage credits|extra usage|your usage allocation)\b/i,
  /\bNow using (?:usage credits|extra usage|your usage allocation)\b/i,
  /\bis now using usage credits instead of your plan limits\b/i,
  /\bnow uses usage credits\b/i,
];
// The WHOLE line around a match, capped. Not from the match on: "claude-fable-5-1 is now using usage credits"
// matches only at "now" — cut from there the sentence would lose exactly the model it is about.
const wordingAround = (text, index) => text.slice(text.lastIndexOf("\n", index) + 1).split("\n")[0].trim().slice(0, 220);
// → the CLI's wording or "".
function detectCreditSwitch(text) {
  const t = String(text || "");
  if (!t) return "";
  for (const re of CREDIT_SWITCH_PATTERN) {
    const m = re.exec(t);
    if (m) return wordingAround(t, m.index);
  }
  return "";
}

// ── Credit gate: do not even begin ───────────────────────────────────────────
// What the gate REALLY does and what not: it prevents the START of a turn. Whether a turn already RUNNING beyond
// the time window consumes credits is decided by the provider's server — there is no flag, no environment variable
// and no config file for it (`DISABLE_EXTRA_USAGE_COMMAND` only switches off the slash command). The hard lock is in
// the account (switch off extra usage, monthly spend limit). The setting's label says exactly that and points there.
//
// Applies to ALL runs: also to a typed message — then the chat shows the button "start anyway". Also to derived
// model calls: `runOnce` in providers/index.js asks the hook `gateVerdictHook` BEFORE the connector (installed in
// startServer). A oneshot the gate intercepts fails with `limits.gateLimitText(window)`; the wording is built so that
// the callers' existing limit detection (parkJudge, compactChatContext) reads it like a limit of the CLI — there is
// no special gate path.
//
// The value ALWAYS comes from the 60-second cache (`force: false`). A forced network call before every typed message
// would make the chat sluggish (8 s timeout, 429 locks 90 s) — and the cache is warm anyway through the clients'
// 45-second poll.
// The usage state for the gate. Claude only: Codex has no query endpoint, its value comes from the session file of
// the LAST run and is structurally stale — a gate on it would park without reason or too late.
//
// Ask FRESH once if the cache shows a number from earlier: a locking window whose reset has already passed is either
// the old cache (up to 60 s) or a provider that has not rolled yet — only a fresh fetch tells them apart. After that
// the same rule as in the wake check applies: a window with a past reset does not lock. Otherwise the gate would
// park anew every 20 s, each time with a gate row and a notification, without a cap.
async function creditGateStatus(providerId, { model = "" } = {}) {
  if (providerId !== "claude") return null;
  try {
    let usage = await fetchUsageLimits({ force: false });
    let window = limits.claudeWindows(usage);
    if (limits.gateWindowStale(window, { model })) {
      usage = await fetchUsageLimits({ force: true });
      window = limits.claudeWindows(usage);
    }
    const measuredAt = Number(usage?.at) || 0;
    return { window, measuredAt, ageMs: measuredAt ? Date.now() - measuredAt : Infinity };
  } catch (e) {
    console.error("[credit-gate] usage not readable:", e?.message || e);
    return null;
  }
}

// The ONE verdict of the gate — for both callers: `creditGateHolds` (turn ⇒ park) and `gateVerdictHook` (oneshot ⇒
// throw). The order of the questions is intentional:
//
//   1. Gate on? Provider Claude (creditGateStatus does not even ask otherwise)? Measurement readable?
//   2. limits.mayStartTurn — WITH the model: a model-specific window says nothing about a chat on another model.
//   3. "overruled" and "stale" (stale measurement) are ok:true but carry window and percent so the turn caller can
//      write the row that records the decision in the history.
//
// Whether a call belongs to a turn whose gate has already decided is said by the CALLER (`approval`, see
// gateVerdictHook) — not by a set the chat happens to be in or not.
//
// → { ok:true, reason } · { ok:true, reason:"overruled"|"stale", window, percent }
//   · { ok:false, reason:"credit-gate", window, percent, windows }
//   `windows` are the windows of THIS chat (limits.windowForModel): the turn caller computes the wait time from
//   them — with all windows it would take the reset of a foreign model.
async function gateVerdict({ providerId, chatId = "", model = "", overruled = false } = {}) {
  const gateOn = creditGateOn();
  if (!gateOn) return { ok: true, reason: "off" };
  const state = await creditGateStatus(providerId, { model });
  if (!state) return { ok: true, reason: "unknown" };
  const verdict = limits.mayStartTurn({ windows: state.window, gateOn, overruled, model });
  if (verdict.ok && verdict.reason !== "overruled") return { ok: true, reason: verdict.reason };
  const window = verdict.window;
  const percent = Math.round(typeof window?.percent === "number" ? window.percent : 100);
  if (verdict.reason === "overruled") return { ok: true, reason: "overruled", window, percent };
  // Stale measurement: START. A chat standing still without reason costs more than one turn too many.
  if (state.ageMs > CREDIT_GATE_MAX_AGE_MS) return { ok: true, reason: "stale", window, percent, ageMs: state.ageMs };
  return { ok: false, reason: "credit-gate", window, percent, windows: limits.windowForModel(state.window, model) };
}

// The hook for `runOnce` (providers/index.js, `setStartGate`). An intercepted oneshot gets the canonical wording
// from limits.js that every limit detection reads — the hook knows no more and need not: parking is the caller's
// business (parkJudge, compactChatContext), title and curator fail silently.
//
// Two markers of the caller, both an ARGUMENT of the start, never a state:
//   `approval`  — this oneshot is a trailer of the turn whose gate has already decided (title and curator at the
//                 turn end: they describe the turn that ran and start nothing). doRun passes it, nobody else.
//   `overruled` — the human pressed "start anyway (costs credit)" for THIS verdict or this compaction;
//                 fireAutoContinueInner passes it on to the verdict chain (resumeJudge → gate → switch → list), and
//                 the chain ends at the next turn, which asks its gate itself again.
// Everything else — target verdict, workflow gate and switch after a turn, compaction between two turns — asks here
// itself. That is the promise of toggle B: "no new model work — no turn, no verdict".
//
// Subagents (`cbase_agent`, `Task` of the loop engine) run through runChat, not runOnce — their CORE asks this hook
// before every start anyway (runs/agents.js → providers/index.js, `purpose: "agent"`), with the subagent's provider.
// "Start anyway" of the parent turn comes along as `overruled` — as long as that turn runs, not beyond.
//
// An error in the check itself lets the call through: the gate is a cost brake, not a safeguard — a oneshot failing
// on a read error of the usage cache would be an outage without a benefit.
async function gateVerdictHook({ provider, model = "", chatId = "", purpose = "oneshot", approval = false, overruled = false } = {}) {
  if (approval === true) return { ok: true };
  const what = purpose === "agent" ? "Subagent" : "Oneshot";
  let u;
  try { u = await gateVerdict({ providerId: provider, chatId, model, overruled: overruled === true }); }
  catch (e) { console.error(`[credit-gate] start gate (${what}):`, e?.message || e); return { ok: true }; }
  if (u.ok) return { ok: true };
  console.log(`[credit-gate] ${what}${chatId ? ` (${chatId})` : ""}: ${u.window?.label || u.window?.group || "?"} at ${u.percent} % — not started`);
  return { ok: false, window: u.window, percent: u.percent, text: limits.gateLimitText(u.window) };
}

// ── The wait row belongs to its kind ─────────────────────────────────────────
// `run` > `judge` > `compact`: a waiting TURN carries the user's task, a waiting verdict the re-entry of a workflow,
// a waiting compaction only the catching up of the summary. A lower kind never displaces a higher one — otherwise a
// /compact failed at the limit would overwrite a parked verdict with its re-entry (the node would run a second time).
const WAIT_ROW_RANG = { run: 3, judge: 2, compact: 1 };
const waitRowRang = (kind) => WAIT_ROW_RANG[kind || "run"] || 0;
// May a row of kind `kind` replace the existing `prev` (same kind: yes)?
const rowMayWrite = (prev, kind) => !prev || waitRowRang(kind) >= waitRowRang(prev.kind);

// Short form of a prompt for the queue strip (`display`).
const promptShort = (s) => String(s || "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 120) || "";

// Write the wait row — or queue the task behind the existing one.
//
// ONE place for both writers (`creditGateHolds`, `maybeAutoContinue`), because the rule would otherwise drift apart
// at two places — a gate writing the row unconditionally would let every second parked cause delete the first one's
// prompt without it ever having run.
//
//   · A higher-ranking row is already there ⇒ write nothing, false.
//   · `run` over `run`, and this run is NOT the row's continuation ⇒ "parked is like running": the prompt goes into
//     the queue as an entry and runs when the parked continuation is through. `silent`, because its row is already
//     in the history (the caller wrote it before the start). The row stays untouched — WITH its attempt counter,
//     which caps the circling against MAX_CONTINUES. false.
//   · Otherwise write, true. `resumption` says: this run IS the row's turn (fireAutoContinueInner started it) — then
//     parking again is a resetting of the same row, not a second task, and the counter goes on (ON CONFLICT leaves
//     it).
// `inputs`: the inputs of the intercepted turn. An occurrence (scheduled/run.js) travels in the entry as what it was
// — specified cause "schedule", `human`, announcement and the marker `scheduledRun` of its run; without them the run
// would not see its new entry, and the occurrence's human input would be lost.
function parkOrQueue(chat, row, { resumption = false, cause = "user", inputs = [] } = {}) {
  const prev = store.getPendingResume(chat.id);
  const kind = row.kind || "run";
  if (!rowMayWrite(prev, kind)) {
    console.log(`[limit] ${chat.id}: ${kind} does not wait — the parked row (${prev.kind || "run"}) has priority.`);
    return false;
  }
  if (prev && (prev.kind || "run") === "run" && kind === "run" && !resumption) {
    const occurrence = cause === "schedule" ? (inputs || []).find((e) => Number.isInteger(e?.scheduledRun) && e.scheduledRun > 0) : null;
    const entry = {
      id: crypto.randomUUID(), prompt: row.prompt || "", display: promptShort(row.prompt),
      attachments: row.attachments || [], cause: CAUSES.has(cause) ? cause : "user", silent: true,
      ...(occurrence ? { causeSpecified: "schedule", human: occurrence.text || "", scheduledRun: occurrence.scheduledRun, ...(occurrence.announcement ? { announcement: occurrence.announcement } : {}) } : {}),
    };
    const position = enqueueRunInput(chat.id, entry);
    console.log(`[limit] ${chat.id}: task queued behind the parked continuation (position ${position}).`);
    return false;
  }
  store.setPendingResume(chat.id, row);
  return true;
}

// true = the start is intercepted, the caller must NOT go on.
//
// `overruled`: the human pressed "start anyway (costs credit)" — for EXACTLY this start; fireAutoContinueInner
// passes it only to the doRun it starts itself. `resumption`: this run is the wait row's turn (see parkOrQueue).
//
// The wait row does NOT go to the clients from here: at this moment the chat is still in `running` (the check
// deliberately runs behind `running.add`), and autoContinueView is silent for a running chat. doRun removes the chat
// and then sends row and run end.
async function creditGateHolds(chat, prompt, { goalDepth = 0, attachments = null, cause = "user", overruled = false, resumption = false, inputs = [] } = {}) {
  const providerId = providerForChat(chat);
  // The same model doRun passes to the connector further down — the gate should judge the turn about to run, not
  // the default.
  const model = chat.model || defaultModelFor(providerId);
  // `chatId` goes along: a resume retry (doRun calls itself with `noResume`) belongs to the turn that already
  // passed the gate and is not asked a second time.
  const u = await gateVerdict({ providerId, chatId: chat.id, model, overruled });
  if (u.ok && u.reason !== "overruled" && u.reason !== "stale") return false;

  const window = u.window;
  const group = window?.group || limits.GROUPS.SESSION;
  const label = window?.label || group;
  const percent = u.percent;
  const common = { group, label, limitText: limitGroupText(group, label), percent, gate: true };

  // The human pressed "start anyway". It starts — and the history says that this one turn deliberately ran beyond
  // the window. Without the row nothing would remain of the decision, and nobody could later say where the
  // consumption came from.
  if (u.reason === "overruled") {
    limitLine(chat.id, { kind: "gate-free", ...common, text: T`Started anyway: ${common.limitText} is at ${percent} % — this turn may spend usage credits.` });
    return false;
  }

  // Stale measurement: START, and say in the history what the decision rested on — the row is what makes the
  // difference between "the gate decided" and "the gate did not know" visible at all.
  if (u.reason === "stale") {
    const min = Number.isFinite(u.ageMs) ? Math.round(u.ageMs / 60_000) : 0;
    limitLine(chat.id, { kind: "gate-stale", ...common, text: T`Credit gate: the utilisation reading is ${min ? T`${min} minutes old` : T("undated")} — starting rather than parking on a stale number.` });
    return false;
  }
  // Stopped DURING the await above: the human pressed "stop", the route answered `ok:true`, and the abort marker
  // stands (state.js stopRun — there is no child yet). A stopped turn does NOT park: parked it would run in full at
  // the reset, and neither the row "continuing at …" nor the notification belong to a task the human just aborted.
  // The same rule as in the abort branch of doRun — a continuation takes its run row along, a workflow stops at the
  // step, a schedule run ends (the same hooks as there). Nothing is queued behind a foreign run row.
  // clearAwayGateWithoutTurn clears the marker; the queue also drains there, as after every stopped turn. Only if
  // the gate HOLDS: if the turn passes it, it starts, and the marker kills it at spawn as intended.
  if (abortedRuns.has(chat.id)) {
    if (resumption) { try { clearAwayRunRow(chat.id); } catch { /* the row is information, the abort stands */ } }
    fireHooks("afterRunFailed", { chat, code: 0, aborted: true });
    fireHooks("beforeRunBroadcast", { chat, error: "", resultText: "", parked: false, cause, aborted: true, inputs });
    console.log(`[credit-gate] ${chat.id}: stopped in the gate — no parking, no turn`);
    return true;
  }
  // No branch for "auto-continue off": gate wait rows are self-supporting — switching the gate on IS the consent
  // to continue at the reset; fireAutoContinueInner wakes them independently of toggle A. Starting here instead
  // would make toggle B silently ineffective.

  const now = Date.now();
  // It waits as long as THE GATE holds — from the same windows on which it just locked (limits.gateWaitTime, the
  // same model). chooseWait would take the latest reset of all time locks from 98 % — a week at 98.5 % would hold the
  // row until the weekly reset although the gate was free again after the session.
  const wait = limits.gateWaitTime({ windows: u.windows, model, now });
  // No known reset: still do NOT start (exactly that is the gate's job) but check back in growing steps — the same
  // probing mechanics as at the time limit. The step is the number of probes the row already had (ON CONFLICT keeps
  // `probes`): a gate that parks an existing row anew (the timer started its turn, the gate holds again) would
  // otherwise begin at five minutes again.
  const prior = store.getPendingResume(chat.id);
  const dueAt = wait.ok ? wait.resumeAt : now + limits.nextProbing(prior?.probes || 0);
  const written = parkOrQueue(chat, {
    kind: "run", payload: cause !== "user" ? { cause } : null,
    prompt: prompt || "", goalDepth, attachments,
    provider: providerId, limitGroup: group, limitLabel: label,
    // A reason of its own next to "reset" and "probe": only so web and iOS can show the button "start anyway (costs
    // credit)" instead of "try now" — the wait row is the only information they have about this state.
    reason: "credit", evidence: `${percent}%`,
    resetsAt: window?.resetsAt || 0, dueAt,
    // OPEN, not "running": a verdict about a cap or review answer is parked WHILE the run is on `waiting`. The
    // marker is computed and persisted here: once wrong, wrong forever. The notion is defined ONCE in
    // store/workflows.js.
    workflow: store.workflowOpenFor(chat.id),
    now,
  }, { resumption, cause, inputs });
  // Queued instead of written: the row in front runs its continuation, this task after it. No history row of its
  // own — the queue's `message_queue` event already says it.
  if (!written) {
    console.log(`[credit-gate] ${chat.id}: ${label} at ${percent} % — start intercepted, task waits behind the parked continuation`);
    return true;
  }
  // Reset unknown: this first look IS a probe and is counted (limits.nextProbing) — otherwise the timer would take
  // the 5-minute step a second time.
  if (!wait.ok) store.reschedulePendingResume(chat.id, { dueAt, probe: true, now });
  const row = store.getPendingResume(chat.id);
  scheduleAutoContinue(row, { now });
  const text = T`Credit gate: ${common.limitText} is at ${percent} % — not starting a new turn. Continuing ${wait.ok ? T`at ${clockText(dueAt)}` : T("as soon as the window frees up")}.`;
  limitLine(chat.id, { kind: "gate", ...common, waitFor: "run", reason: "credit", resetsAt: row.resetsAt || null, dueAt: row.dueAt, text });
  limitNotification(chat, { parking: true, text });
  console.log(`[credit-gate] ${chat.id}: ${label} at ${percent} % — start intercepted, continuation ${new Date(dueAt).toISOString()}`);
  return true;
}

// ── The lock per project at the turn ───────────────────────────────────────────────────────────────────────────
// true = the start is intercepted, the caller must NOT go on — the same return as creditGateHolds, so every caller
// of doRun treats a locked turn like one parked at the gate. Asked in doRun BEFORE the credit gate, in the same
// expression: locked means "not started", and the gate would have judged a turn that does not begin. SYNCHRONOUS —
// there must be no `await` between `running.add` and this check.
//
// The domain side judges (projectbox/idle.js projectLock, via runs/project-lock.js):
//   wait   The chat's wait row (`parkOrQueue`, "parked is like running") with reason "project" (the instance is
//          working: start, creation, recreation, relocation, or a relocation holds the lock) or "serverEnd" (the
//          process ends, the turn runs in the next). If a run row is already there (at the limit, at the gate), the
//          task is queued behind it and the row NOT touched — the lock replaces no limit wait row, it only holds its
//          start (runs/auto-continue.js fireAutoContinueInner). The transition to ready sets the timer
//          (projectbox/idle.js); `dueAt` is only the check-back in case it fails to come — for "serverEnd" NOW: the
//          sweeper of the next process takes the row.
//   error  The instance of a relocated project is in the error state: the start ends visibly AT ONCE — a message of
//          the role `hint` ("project container not ready: <reason>", sent live) and `run_aborted` (only the end of
//          waiting in the clients, without text — see endVisible); the user's message stays, repeating means sending
//          again. A workflow step fails (hook "afterRunFailed"), a schedule run ends with the reason
//          ("beforeRunBroadcast"), a wait row whose turn this was falls, and the next queue entry runs (and ends the
//          same way) — otherwise the queues of all chats of the project would stand forever without a display.
// `parentSince`: the beginning of the work this turn belongs to — only the graph driver passes it (start time of its
// run, workflows/driver.js); the layout lock lets through the next step of a run that began before the job.
function projectLockHolds(chat, prompt, { goalDepth = 0, attachments = null, cause = "user", resumption = false, parentSince = null, inputs = [] } = {}) {
  const u = startLock(chat.id, "turn", { parentSince });
  if (!u) return false;
  // The start ends VISIBLY (error, or the wait row could not be written) — the message stays, repeating means
  // sending again, and the queue goes on.
  // The text stands ONCE in the open chat: the hint row itself goes out live; `run_error` with the same text on top
  // would show it twice (hint and error bubble). The client still needs the end of waiting (`busy` from sending):
  // `run_aborted` ends it in web and iOS without a row of its own — without `run_started` there is no runtime
  // summary. If the row could not be written (the database does not answer — the case this abort is built for),
  // `run_error` carries the text: otherwise nobody would see the reason.
  const endVisible = (text) => {
    let stands = false;
    try { store.addMessage(chat.id, "hint", text); stands = true; } catch (e) { console.error("[project] hint:", e?.message || e); }
    sse(chat.id, stands ? { type: "harness", subtype: "run_aborted", reason: "project" } : { type: "harness", subtype: "run_error", stderr: text });
    if (resumption) { try { clearAwayRunRow(chat.id); } catch { /* the row is information, the abort stands */ } }
    fireHooks("afterRunFailed", { chat, code: "project", aborted: false });
    fireHooks("beforeRunBroadcast", { chat, error: text.slice(0, 300), resultText: "", parked: false, cause, aborted: false, inputs });
    // The queue goes on — started by clearAwayGateWithoutTurn, which doRun calls right after: ONE place for holding,
    // throw and stop (a drain here as well would start a second entry next to it).
    console.log(`[project] ${chat.id}: turn not started — ${text}`);
    return true;
  };
  if (u.kind === "error") return endVisible(String(u.text || "").trim() || T("Project container not ready."));
  const now = Date.now();
  const serverEnd = u.reason === "serverEnd";
  // "Unreadable" is woken by no transition: checked back at the sweeper's tick instead of after the lock's cap.
  const checkBack = withoutTransition(u) ? autoContinueSweepMs() : projectCheckBackMs();
  let written;
  try {
    written = parkOrQueue(chat, {
      kind: "run", payload: cause !== "user" ? { cause } : null,
      prompt: prompt || "", goalDepth, attachments,
      provider: providerForChat(chat), limitGroup: "", limitLabel: "",
      reason: serverEnd ? "serverEnd" : "project", evidence: String(u.state || u.reason || ""),
      resetsAt: 0, dueAt: serverEnd ? now : now + checkBack,
      // OPEN, not "running" — the same notion as at the credit gate (see there).
      workflow: store.workflowOpenFor(chat.id),
      now,
    }, { resumption, cause, inputs });
  } catch (e) {
    // Not even the wait row could be written (the database does not answer). Without this catch the throw would fly
    // out of the head of doRun, and the chat would stand in `running` forever.
    const situation = String(u.text || "").trim() || T("The start waits.");
    return endVisible(T`${situation} The waiting entry could not be written (${e?.message || e}) — please send again.`);
  }
  if (!written) {
    console.log(`[project] ${chat.id}: task waits behind the parked continuation (${u.reason || u.state || "lock"})`);
    return true;
  }
  // No timer at the server end: this process ends, and its sweeper would take the row only to hold it again.
  // Caught: the row STANDS — a throw when re-reading would otherwise fly out of the head of doRun before
  // `running.delete`, and the chat would stand in `running` until the restart. Without a timer the sweeper takes it.
  if (!serverEnd) {
    try { scheduleAutoContinue(store.getPendingResume(chat.id), { now }); }
    catch (e) { console.error(`[project] ${chat.id}: wait row written, timer not set — the sweeper takes it:`, e?.message || e); }
  }
  // ONE row in the history per wait row — not again when the continuation itself holds again.
  if (!resumption && u.text) { try { store.addMessage(chat.id, "hint", String(u.text)); } catch { /* information, no contract */ } }
  console.log(`[project] ${chat.id}: turn waiting (${u.reason || u.state || "lock"})`);
  return true;
}

// If a turn in doRun does not get past the two gates in front (projectLockHolds, creditGateHolds) — held OR thrown
// —, it gives back what it carried until then. A throw in the gate (a foreign database lock beyond busy_timeout, an
// I/O error when writing the wait row — the gate lies BEFORE the try of doRun) would otherwise leave `running`, the
// turn marker and the running chat standing in all clients: "busy" until the restart, every message only queued,
// the deploy's idle gate waiting for it. And a stop DURING the gate await (fetchUsageLimits) sets the abort marker
// that nobody clears on this path (no child, no finally) — it would kill the NEXT run of the chat at spawn. A turn
// that does not begin takes its marker along; if it passes the gate, the marker stays and kills exactly it, as
// intended. A turn stopped in the gate is not parked at all — creditGateHolds asks that after its await.
// `thrown` + `resumption`: a continuation whose gate THROWS takes its run row along (it stood 6 h ahead,
// fireAutoContinueInner) — BEFORE reporting the row and before the drain below, which would otherwise take it for
// "parked".
// At the end the queue drains (every window without a turn that ends lets it drain): an entry queued behind the
// continuation's row or during the gate await had nobody on this path — the run end does not happen here. drainQueue
// asks every lock itself: if the turn parks (a run row stands), the queue stays behind it; after a throw, the error
// state of the project lock and a stop it runs.
// A THROW is a run end like the error state of the project lock: "beforeRunBroadcast" with the wording (`error`),
// `cause` and `inputs` of the turn — otherwise an occurrence whose gate threw would stay open forever. Held (wait
// row, queued) is no end: nothing fires there.
function clearAwayGateWithoutTurn(chat, { thrown = false, resumption = false, cause = "user", inputs = [], error = "" } = {}) {
  running.delete(chat.id);
  releaseTurn(chat.id, { ran: false });
  abortedRuns.delete(chat.id);
  if (thrown && resumption) { try { clearAwayRunRow(chat.id); } catch { /* the row is information, the throw stands */ } }
  if (thrown) fireHooks("beforeRunBroadcast", { chat, error: String(error || T("Start failed")).slice(0, 300), resultText: "", parked: false, cause, aborted: false, inputs });
  // A parked run is persisted by its WAIT ROW, not by active_runs. doRun writes its row only behind the gate — but
  // a predecessor may have left one: resumeInterruptedWork starts exactly the runs from active_runs, and if the
  // restart runs into the gate, the row would stay and be started a second time next to the wait row's continuation
  // at the next start.
  try { store.clearActiveRun(chat.id); } catch {}
  // Only AFTER removing it, to the clients: autoContinueView is silent for a running chat. Plus the run end in the
  // same form as in the finally of doRun (without push): the client set `busy` when sending, and without this event
  // the spinner would turn forever.
  // Caught: exactly in the case the lock's visible abort is built for (the database does not answer), re-reading the
  // wait row would already throw — and the run end below would drop out: chat list and other devices would show the
  // chat running until a reload.
  try { emitAutoContinue(chat.id, store.getPendingResume(chat.id)); }
  catch (e) { console.error(`[run] ${chat.id}: wait row not readable — run end reported anyway:`, e?.message || e); }
  broadcast({
    type: "run", chatId: chat.id, running: false, answered: false,
    title: chat.title || T("Answer ready"),
    workspaceId: chat.workspaceId || "", projectId: chat.projectId || "",
    push: false,
  });
  try { drainQueue(chat.id); } catch (e) { console.error(`[run] ${chat.id}: queue after the gate:`, e?.message || e); }
}

export { AUTO_CONTINUE_SETTING, CREDIT_GATE_SETTING, autoContinueEnabled, autoContinueFiring, autoContinueSweepMs, autoContinueTimers, clearAutoContinueTimer, clockText, gateFreeByMeasurement, gateFreeForAllByMeasurement, clearAwayGateWithoutTurn, gateVerdictHook, creditGateOn, creditGateHolds, detectCreditSwitch, runOverruled, limitGroupText, limitWindowsFor, parkOrQueue, projectLockHolds, lockingWindow, waitTimeFor, wordingAround, rowMayWrite };
