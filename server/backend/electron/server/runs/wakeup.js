// The owner of the wakeups per CHAT (model: runs/monitors.js).
//
// A wakeup (cbase_wakeup) belongs to the CHAT, not the turn, as in Claude Code: the turn ends normally after setting
// it, the chat is free (not "running", not `busy`), and at the wake time this owner delivers the continuation through
// the ONE wake path (`delivery`, runs/queue.js deliverUserPrompt with cause "wakeup", silent — no user row): if the
// chat is idle, a turn of its own; if one is running, it is queued and goes into its process at the `result` or as a
// follow-up run (never into the middle of the turn).
//
// At most ONE per chat — a new one replaces the old. It is set only from a turn (route `POST …/wakeup`, the run check
// is there), cancelled also without one: by the agent (`stop: true`, no hint — it knows) or by the human via the card
// under Background Tasks (`POST …/wakeup/stop` with `from: "human"` — a silent hint to the next turn, as with a
// monitor). Archiving and deleting take it along silently (`closeWakeup`).
//
// Restart: unlike a monitor a wakeup can be resumed — it is only a time and a text. The inventory is in
// `<data>/wakeup-open.json`; `loadWakeup` reads it synchronously BEFORE `listen` (otherwise a wakeup set in the first
// seconds would overwrite the file together with the rows not yet loaded), the restart hook "wakeup-restart-grace"
// sets the clocks and delivers overdue ones at once (with the sentence that it is late). So it survives a deploy.
//
// busy: a waiting wakeup is NOT a running chat — it counts neither in `busy` nor in `open` (`/api/runs/active`; it
// waits for a clock and survives the swap), but stands there as its own field `wakeup`. It holds the gateway's idle
// reaper via the occurrence wakeup: `GET /api/schedules/next` (scheduled/routes.js) names the earliest wakeup next to
// the scheduled jobs — the gateway keeps a container with an occurrence in the next ten minutes and starts a sleeping
// one two minutes before.
//
// Import rules: neither the runs core (do-run, queue, …) nor agents.js — the display attaches via `observeWakeup`
// (agents.js reportBackground), the delivery comes via `setWakeupDelivery` (server.js). No cycle.
import fs from "node:fs";
import path from "node:path";
import * as store from "../store.js";
import { DIRS } from "../app-state.js";
import { T } from "../i18n.js";
import { depositHint } from "./hints.js";
import { NATIVE_WAKEUP_MAX_S } from "./state.js";
import { WAKEUP_AFTER_SETTING } from "../../mcp/wakeup-rule.js";

const perChat = new Map(); // chatId -> { chatId, at, prompt, reason, providedAt, timer, daten }
const observer = new Set(); // fn(chatId)
// The delivery: `(chatId, text) => result of deliverUserPrompt` — set in server.js (runs/queue.js must not be imported here).
let delivery = null;
export function setWakeupDelivery(fn) { delivery = typeof fn === "function" ? fn : null; }

/** A subscriber (agents.js: display). Returns the unsubscribe function. */
export function observeWakeup(fn) {
  observer.add(fn);
  return () => observer.delete(fn);
}
function report(chatId) {
  for (const fn of [...observer]) {
    try { fn(chatId); } catch (e) { console.error("[wakeup] observer:", chatId, e?.message || e); }
  }
}

// ── The inventory for the restart ──────────────────────────────────────────────────────────────────────────────────
const inventoryFile = () => (DIRS?.data ? path.join(DIRS.data, "wakeup-open.json") : null);
function readInventory() {
  const f = inventoryFile();
  if (!f) return [];
  try { const j = JSON.parse(fs.readFileSync(f, "utf8")); return Array.isArray(j) ? j : []; } catch { return []; }
}
function refreshInventory() {
  const f = inventoryFile();
  if (!f) return;
  // Only the wakeups of THIS data folder: in tests several servers run one after another in one process.
  const data = DIRS?.data || "";
  const rows = [...perChat.values()].filter((e) => e.data === data)
    .map((e) => ({ chatId: e.chatId, at: e.at, prompt: e.prompt, reason: e.reason, providedAt: e.providedAt }));
  try {
    if (!rows.length) { fs.rmSync(f, { force: true }); return; }
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows));
    fs.renameSync(tmp, f);
  } catch (e) { console.error("[wakeup] inventory not written:", e?.message || e); }
}

// ── Rows for display and gate ──────────────────────────────────────────────────────────────────────────────────────
const row = (e) => ({ chatId: e.chatId, at: e.at, prompt: e.prompt, reason: e.reason, providedAt: e.providedAt });

/** The wakeup of a chat or `null` (process state, never "unknown"). */
export function wakeupOf(chatId) {
  const e = perChat.get(chatId);
  return e ? row(e) : null;
}
/** All set wakeups (`/api/runs/active` field `wakeup`). */
export const allWakeups = () => [...perChat.values()].map(row);
/** The earliest wake time across all chats, 0 = none (the gateway's occurrence wakeup, scheduled/routes.js). */
export function nextWakeup() {
  let at = 0;
  for (const e of perChat.values()) if (!at || e.at < at) at = e.at;
  return at;
}

/** The text the woken turn begins with — the same wording as the injection in do-run.js. */
export function wakeText({ prompt = "", at = 0 } = {}, now = Date.now()) {
  const core = String(prompt || "").trim()
    ? `[Scheduled continuation]\n${String(prompt).trim()}`
    : "[Scheduled continuation — the deadline you set has passed. Carry on.]";
  // A wakeup whose time passed during a restart arrives late — the agent should know (its waiting time is off).
  if (at && now - at > 60_000) {
    const atIso = new Date(at).toISOString();
    return `${core}\n\n${T`(Late: it was due at ${atIso} — the server restarted in between.)`}`;
  }
  return core;
}

function placeClock(e) {
  if (e.timer) clearTimeout(e.timer);
  e.timer = setTimeout(() => { e.timer = null; fire(e); }, Math.min(Math.max(0, e.at - Date.now()), 2 ** 31 - 1));
  e.timer.unref?.();
}

function remove(e) {
  if (perChat.get(e.chatId) !== e) return false;
  if (e.timer) { clearTimeout(e.timer); e.timer = null; }
  perChat.delete(e.chatId);
  refreshInventory();
  return true;
}

// The wake time has come: remove the entry (the display disappears BEFORE the turn), then deliver via the wake path.
function fire(e) {
  if (!remove(e)) return false;
  report(e.chatId);
  if (!delivery) { console.error(`[wakeup] ${e.chatId}: no delivery attached — the wakeup is lost`); return false; }
  try {
    const r = delivery(e.chatId, wakeText(e));
    if (r && r.ok === false) console.warn(`[wakeup] ${e.chatId}: not delivered — ${r.error || JSON.stringify(r)}`);
    return Boolean(r?.ok);
  } catch (err) {
    console.error("[wakeup] delivery:", e.chatId, err?.message || err);
    return false;
  }
}

/**
 * Set a wakeup (route `POST …/wakeup`, only from a turn). Replaces a set one. Throws on an invalid time.
 * @returns {{ ok: true, wakeupAt: number, at: string, replaced: boolean, note: string }}
 */
export function setWakeup(chatId, args = {}) {
  if (!chatId) throw new Error("No chat for the wakeup.");
  const secs = Number(args.delaySeconds);
  if (!Number.isFinite(secs) || secs <= 0) throw new Error("delaySeconds is missing or invalid (seconds > 0).");
  const at = Date.now() + Math.min(Math.round(secs), NATIVE_WAKEUP_MAX_S) * 1000;
  const old = perChat.get(chatId);
  if (old?.timer) clearTimeout(old.timer);
  const e = { chatId, at, prompt: String(args.prompt || ""), reason: String(args.reason || "").slice(0, 300), providedAt: Date.now(), timer: null, data: DIRS?.data || "" };
  perChat.set(chatId, e);
  placeClock(e);
  refreshInventory();
  report(chatId);
  return { ok: true, wakeupAt: at, at: new Date(at).toISOString(), replaced: Boolean(old), note: WAKEUP_AFTER_SETTING };
}

/**
 * Cancel a chat's wakeup — also without a turn. `through`: "agent" (cbase_wakeup stop=true, no hint) | "human" (card
 * under Background Tasks: a silent hint to the next turn).
 * @returns {{ ok: true, cancelled: boolean }}
 */
export function stopWakeup(chatId, { through = "agent" } = {}) {
  const e = perChat.get(chatId);
  if (!e || !remove(e)) return { ok: true, cancelled: false };
  if (through === "human") {
    const clock = new Date(e.at).toISOString();
    depositHint(chatId, T`The human stopped your wakeup for ${clock}${e.prompt.trim() ? T` ("${e.prompt.trim().slice(0, 200)}")` : ""} — this chat will not be woken.`, { source: "wakeup" });
  }
  report(chatId);
  return { ok: true, cancelled: true };
}

/** Archiving, deleting: take the wakeup silently (no hint, no delivery). → true if there was one. */
export function closeWakeup(chatId) {
  const e = perChat.get(chatId);
  if (!e || !remove(e)) return false;
  report(chatId);
  return true;
}

/** Test seam: fire a chat's wakeup NOW as if its time had come. → delivered? */
export function wakeupNow(chatId) {
  const e = perChat.get(chatId);
  return e ? fire(e) : false;
}

/** Synchronously before `listen` (server.js): the inventory of the last server run into memory — without clocks yet. → count. */
export function loadWakeup() {
  const data = DIRS?.data || "";
  let n = 0;
  for (const z of readInventory()) {
    const chatId = String(z?.chatId || "");
    const at = Number(z?.at);
    if (!chatId || !Number.isFinite(at) || at <= 0 || perChat.has(chatId)) continue;
    perChat.set(chatId, { chatId, at, prompt: String(z.prompt || ""), reason: String(z.reason || ""), providedAt: Number(z.providedAt) || 0, timer: null, data });
    n++;
  }
  return n;
}

/** Restart hook "wakeup-restart-grace": set the loaded wakeups; deliver overdue ones at once, drop wakeups of deleted
 *  or archived chats. → number set or delivered. */
export function wakeupRestartGrace() {
  const data = DIRS?.data || "";
  let n = 0;
  for (const e of [...perChat.values()]) {
    if (e.data !== data || e.timer) continue;
    let chat = null;
    try { chat = store.getChat(e.chatId); } catch { /* deleted */ }
    if (!chat || chat.archivedAt) { remove(e); continue; }
    if (e.at <= Date.now()) fire(e);
    else placeClock(e);
    n++;
  }
  refreshInventory();
  if (n) console.log(`[wakeup] ${n} wakeup(s) taken over from the last server run`);
  return n;
}

/** The server run ends: stop the clocks WITHOUT emptying the inventory — the next run sets them anew. Only the
 *  wakeups of this data folder (in tests several servers run in one process). */
export function wakeupAtServerEnd() {
  const data = DIRS?.data || "";
  for (const e of [...perChat.values()]) {
    if (e.data !== data) continue;
    if (e.timer) clearTimeout(e.timer);
    perChat.delete(e.chatId);
  }
}
