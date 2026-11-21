// Auto-archive: chats in which no message was written for X days are archived automatically. This file holds the setting
// (GLOBAL — one per server, not per workspace), its validation for the route (`settings/routes.js`, GET/PUT
// /api/chat-auto-archive) and the cycle that the tick in `server.js` triggers hourly (`CBASE_AUTO_ARCHIVE_MS`) and that a PUT
// which enables it or changes the days triggers once right after its response. Archiving goes through the ONE path
// (`./archive.js`) with `reason: "auto"`.
//
// What does NOT happen: nothing is deleted, no folder is archived, no notification, and a chat with open work — including an
// open ask, and on the automatic path an open terminal of the chat rail — stays and is asked again on the next tick.
//
// How the cycle runs:
//   · NEVER in the handler. Per candidate `openWork` reads the history (`openAskOf`); run synchronously before the PUT's
//     response, the first enable over a long backlog would stall the server for everyone. Each cycle starts in the next
//     `setImmediate` (the PUT has answered by then) and works in CHUNKS (`AUTO_ARCHIVE_CHUNK`, 25 candidates), yielding the
//     event loop in between. Within one candidate there is NO await between check and write: `store.autoArchiveCandidate`
//     (fresh: still old, not pinned, still active) and `chatArchive` (open work, write, event) run in one step.
//   · ONE at a time. A trigger during a running cycle (tick, PUT) does NOT run beside it; it is remembered and runs ONCE
//     afterwards (any number of triggers ⇒ one follow-up). Skipping would be wrong: a PUT's trigger carries a NEW setting that
//     is promised to apply at once. Between two chunks the running cycle re-reads the setting; if it changed (off, other
//     days) it aborts — it would otherwise keep archiving with a limit nobody wants; the follow-up takes the new one.
//   · A candidate whose check or write THROWS costs only itself: log line with the chat id, entry in `error`, the cycle
//     goes on.
//   · Events stay per chat (`chat_archive` with `chatIds: [id]`, `reason: "auto"`) — the clients bundle the reload.

import * as store from "../store.js";
import { T } from "../i18n.js";
import { archivable } from "./genus.js";
import { chatArchive } from "./archive.js";

// The key in `app_settings`, JSON `{"enabled": boolean, "days": integer}`.
export const AUTO_ARCHIVE_SETTING = "chat_auto_archive";
// Off by default, preset 30 days, allowed 1–365 whole days.
export const AUTO_ARCHIVE_DAYS_MIN = 1;
export const AUTO_ARCHIVE_DAYS_MAX = 365;
const PRESET = Object.freeze({ enabled: false, days: 30 });
const DAY_MS = 86_400_000;

// The tick interval, read at server start (like the other ticks). Default hourly.
export const autoArchiveTickMs = () => Number(process.env.CBASE_AUTO_ARCHIVE_MS) || 3_600_000;

const daysValid = (t) => Number.isInteger(t) && t >= AUTO_ARCHIVE_DAYS_MIN && t <= AUTO_ARCHIVE_DAYS_MAX;

/**
 * The setting `{ enabled, days }`. Nothing stored ⇒ `{ enabled: false, days: 30 }`. An unreadable or invalid stored value
 * (edited by hand in the DB, a future field) counts as the preset — OFF is the safe direction: an automatism that takes
 * chats out of the lists runs only on a clear instruction. The route writes only valid values.
 */
export function autoArchiveSetting() {
  const raw = store.getSetting(AUTO_ARCHIVE_SETTING, "");
  if (!raw) return { ...PRESET };
  let o = null;
  try { o = JSON.parse(raw); } catch { o = null; }
  if (o && typeof o === "object" && typeof o.enabled === "boolean" && daysValid(o.days)) return { enabled: o.enabled, days: o.days };
  console.error(`[auto-archive] stored setting unreadable (${JSON.stringify(raw).slice(0, 80)}) — treated as off`);
  return { ...PRESET };
}

/**
 * Validate and store the setting from a PUT body. BOTH fields are required — a missing field is not an instruction —,
 * `enabled` boolean, `days` a whole NUMBER from 1 to 365 (no text "30", no 1.5). If the PUT enables the archive or changes
 * the days of an enabled one, it triggers a cycle — which starts in the next `setImmediate`, AFTER the response (see
 * header), and applies the setting just stored.
 * `{ ok: true, value: { enabled, days }, cycle }` (cycle: the promise of the triggered cycle — the route does not wait for
 * it, tests do — or null if none was triggered) or `{ ok: false, error }` (wording for the 400, nothing stored).
 */
export function setAutoArchive(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  if (b.enabled === undefined || b.enabled === null) return { ok: false, error: T("„enabled“ is missing") };
  if (typeof b.enabled !== "boolean") return { ok: false, error: T("„enabled“ must be true or false") };
  if (b.days === undefined || b.days === null) return { ok: false, error: T("„days“ is missing") };
  if (!daysValid(b.days)) {
    return { ok: false, error: T`„days“ must be a whole number from ${AUTO_ARCHIVE_DAYS_MIN} to ${AUTO_ARCHIVE_DAYS_MAX}` };
  }
  const old = autoArchiveSetting();
  const value = { enabled: b.enabled, days: b.days };
  store.setSetting(AUTO_ARCHIVE_SETTING, JSON.stringify(value));
  let cycle = null;
  if (value.enabled && (!old.enabled || old.days !== value.days)) {
    // A failing cycle does not cost the setting: it is stored, the next tick tries again.
    cycle = autoArchiveCycle();
    cycle.catch((e) => console.error("[auto-archive] cycle after enabling:", e?.message || e));
  }
  return { ok: true, value, cycle };
}

// Chunk size: this many candidates per step, then the cycle yields the event loop. A candidate costs one read of the
// history (`openAskOf`) and at most one write; 25 keep a step short.
export const AUTO_ARCHIVE_CHUNK = 25;
const nextTransaction = () => new Promise((r) => setImmediate(r));

// State of the ONE chain (see header), module-wide like the tick in server.js — one per process.
let chain = null;      // the promise of the running cycle (up to and including its follow-up), else null
let afterRun = null;   // the options of a trigger that arrived during the chain — it runs once afterwards
let halt = false;  // set at server end: the running cycle aborts at the next chunk

/**
 * Trigger a cycle: tick, PUT and tests call THIS function. If one is running, none starts beside it — the trigger is
 * remembered and runs once afterwards, and the promise of the running chain is returned (it resolves with the result of
 * its LAST cycle, i.e. the follow-up). Otherwise the cycle starts in the next `setImmediate`.
 * Options (tests only): `now` (ms), `chunk` (candidates per step).
 * Result `{ enabled, days, archived: [chatId], skipped: [{ chatId, open: [reason] }], error: [{ chatId, error }],
 * aborted }` — `aborted`: null, "setting" (it changed between two chunks) or "halted" (server end).
 * Disabled, a cycle does nothing. Otherwise per candidate (`store.autoArchiveCandidates`: active, not pinned, has a
 * message, last activity older than `days` days) the ONE archive path with `reason: "auto"`; open work holds it back and
 * it stays until the next tick.
 */
export function autoArchiveCycle(opts = {}) {
  if (chain) { afterRun = opts; return chain; }
  chain = cycleChain(opts);
  return chain;
}

/**
 * Halt the running cycle (server.js, on the server's "close"): it aborts at the next chunk and a remembered follow-up is
 * dropped. A cycle of an ended server would otherwise keep writing after the next step — in the test bench into the
 * database of the NEXT server (the same reason the tick hangs on the server's lifetime).
 */
export function haltAutoArchive() {
  if (!chain) return;
  halt = true;
  afterRun = null;
}

async function cycleChain(opts) {
  // Only in the next step: the PUT has answered by then, and `chain` is set before anything happens (a short cycle would
  // otherwise end before the assignment in autoArchiveCycle, and `chain` would point at a resolved promise forever).
  await nextTransaction();
  try {
    let r = await oneCycle(opts);
    while (afterRun) {
      const o = afterRun;
      afterRun = null;
      halt = false; // a trigger AFTER the halt already belongs to the next server
      r = await oneCycle(o);
    }
    return r;
  } finally {
    // Synchronously after the last check of `afterRun` — no trigger can fall in between and get lost.
    chain = null;
    afterRun = null;
    halt = false;
  }
}

async function oneCycle({ now = Date.now(), chunk = AUTO_ARCHIVE_CHUNK } = {}) {
  const e = autoArchiveSetting();
  const archived = [];
  const skipped = [];
  const error = [];
  const result = (aborted = null) => ({ enabled: e.enabled, days: e.days, archived, skipped, error, aborted });
  if (halt) return result("halted");
  if (!e.enabled) return result();
  const limit = now - e.days * DAY_MS;
  const candidates = store.autoArchiveCandidates(limit);
  const turn = Number.isInteger(chunk) && chunk > 0 ? chunk : AUTO_ARCHIVE_CHUNK;
  let aborted = null;
  for (let i = 0; i < candidates.length; i++) {
    if (i > 0 && i % turn === 0) {
      await nextTransaction();
      if (halt) { aborted = "halted"; break; }
      const nun = autoArchiveSetting();
      if (nun.enabled !== e.enabled || nun.days !== e.days) { aborted = "setting"; break; }
    }
    const id = candidates[i].id;
    // From here to the end of the candidate no await: check and write in one step.
    try {
      // Fresh: between the list and this step the chat may have received a message, been pinned, or been archived by hand
      // and restored. `archivable` asks the genus once more — the SQL pre-filter is a shortcut, not the rule.
      const c = store.autoArchiveCandidate(id, limit);
      if (!c || !archivable(c)) continue;
      const r = chatArchive(id, { reason: "auto" });
      if (r.archived) archived.push(id);
      else if (r.open.length) skipped.push({ chatId: id, open: r.open.map((o) => o.reason) });
    } catch (err) {
      const text = String(err?.message || err);
      error.push({ chatId: id, error: text });
      console.error(`[auto-archive] ${id}: check or archive failed — the cycle goes on:`, text);
    }
  }
  if (archived.length || skipped.length || error.length || aborted) {
    console.log(`[auto-archive] ${archived.length} chat(s) archived (no message for ${e.days} day(s))`
      + (skipped.length ? `, ${skipped.length} skipped with open work` : "")
      + (error.length ? `, ${error.length} failed` : "")
      + (aborted ? ` — aborted (${aborted === "setting" ? "setting changed" : "server ending"})` : ""));
  }
  return result(aborted);
}
