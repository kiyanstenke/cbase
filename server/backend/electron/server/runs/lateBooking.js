// The late booking after a crash. A main turn books its consumption only at its end (runs/booking.js bookTurn), a subagent at the
// end of each turn (runs/agents.js bookConsumption). If the process dies in between (OOM, crash, a deploy without idle), the
// consumption lived only in memory — the work was paid for, the usage never showed it. The CLIs write it themselves, though:
// Claude one row per response in `projects/<slug>/<session>.jsonl` (message.usage, `timestamp`), Codex one token_count row per
// model call in the rollout (`last_token_usage`, `timestamp`). From that the restart books what was added since the last
// booked state:
//   • interrupted main turns — the `active_runs` row still stands, `session`/`provider`/`model` were recorded by
//     rememberTurnSession at the init event; counted from `started_at` (every doRun resets it, an already booked attempt lies before it);
//   • subagents still carried as `running` — from `booked_until` (the last booking, store/subagents.js subagentBooked),
//     else from their start (a session copied from a fork carries older rows this agent never consumed).
// NOT a PARKED subagent: its remainder is in the image (`open`) and is booked at its end (agent-runtime.js) — or, if it is not
// resumed, when it is orphaned (runs/agents.js reportOrphaned → bookOpenImage).
// NOT booked late: the loop engine (OpenRouter — no session file; the responses carried their amounts, but the sum lay in memory)
// and the agents of a dynamic workflow (own core, own journal).
// Booked as a subscription row (tally form, cache separate, consumption.js subscriptionBooking) — both CLIs are subscriptions.
//
// Called in server.js startServer SYNCHRONOUSLY BEFORE `listen` (a restart hook after `listen` would run 2.5 s later, and a turn in
// that window resets `started_at`: the crashed turn would stay unbooked). So it lies before "agent-orphaned" (which sets the
// subagents to `orphaned`, after which they would be in no list) and before every path that starts turns. A chat already
// running in THIS process is no leftover (same rule as runs/resume.js).

import fs from "node:fs";
import * as store from "../store.js";
import { running } from "./state.js";
import { subscriptionBooking } from "../providers/connectors/consumption.js";
import { codexConsumptionSince } from "../providers/connectors/codex.js";
import { sessionHomes } from "./session-location.js";
import { sessionTraces } from "./session-transfer.js";
import { readFromRuntimeFolder } from "./runtime-write.js";

// Late booking reads no session file larger than this (an agent writes in a project's runtime folder — a sparse file of gigabytes
// would stall the start). Above it: no late booking and a log line.
export const SESSION_READ_MAX = 64 * 1024 * 1024;

const count = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

function readSession(path) {
  try {
    // In a project's runtime folder only via the descriptor (FIFO, link — runs/runtime-write.js); otherwise null ⇒ B.
    const t = readFromRuntimeFolder(path, "utf8", { maxBytes: SESSION_READ_MAX });
    if (t !== null) return t;
    const st = fs.statSync(path);
    if (!st.isFile() || st.size > SESSION_READ_MAX) return null;
    return fs.readFileSync(path, "utf8");
  } catch (e) {
    if (e?.code === "ETOOLARGE") console.warn(`[usage] session file too large for the late booking: ${path}`);
    return null;
  }
}

/**
 * The consumption of a Claude session SINCE `sinceMs` from its session file: per response (`message.id`) the input ONCE (the CLI
 * writes one row per content block, each with the same usage) and the largest output; rows without `timestamp` do not count.
 * If the session lies in several homes (a copy after a transfer), the most recently written one counts. → tally form `{ input (fresh),
 * output, cached (read + write), cacheRead, cacheWrite, untilMs }` or null.
 */
export function claudeConsumptionSince(session, sinceMs, dirs = sessionHomes().claude) {
  if (!session || !Number.isFinite(sinceMs)) return null;
  const files = sessionTraces(session, { claude: dirs }).filter((s) => s.kind === "claude" && s.path.endsWith(".jsonl"))
    .map((s) => { try { return { path: s.path, m: fs.lstatSync(s.path).mtimeMs }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.m - a.m);
  const text = files[0] ? readSession(files[0].path) : null;
  if (!text) return null;
  const byKey = new Map();
  let seq = 0;
  for (const row of text.split("\n")) {
    seq++;
    if (!row.includes('"assistant"') || !row.includes('"usage"')) continue;
    let obj; try { obj = JSON.parse(row); } catch { continue; }
    if (obj?.type !== "assistant") continue;
    const t = Date.parse(String(obj.timestamp || ""));
    const u = obj.message?.usage;
    if (!u || !Number.isFinite(t) || t < sinceMs) continue;
    const id = String(obj.message?.id || `row-${seq}`);
    const existing = byKey.get(id);
    if (existing) { existing.output = Math.max(existing.output, count(u.output_tokens)); existing.t = Math.max(existing.t, t); continue; }
    byKey.set(id, { input: count(u.input_tokens), read: count(u.cache_read_input_tokens), write: count(u.cache_creation_input_tokens), output: count(u.output_tokens), t });
  }
  const s = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, untilMs: 0 };
  for (const v of byKey.values()) {
    s.input += v.input; s.output += v.output; s.cacheRead += v.read; s.cacheWrite += v.write; s.untilMs = Math.max(s.untilMs, v.t);
  }
  if (!s.input && !s.output && !s.cacheRead && !s.cacheWrite) return null;
  return { ...s, cached: s.cacheRead + s.cacheWrite };
}

/** The consumption of a session since `sinceMs` in tally form — Claude from the session file, Codex from the rollout; otherwise null. */
export function consumptionSince(provider, session, sinceMs) {
  if (provider === "claude") return claudeConsumptionSince(session, sinceMs);
  if (provider === "codex") {
    // Codex: `input` FULL, `cached` = read (codex.js) — in tally form `input` is fresh; Codex writes no cache.
    const v = codexConsumptionSince(session, sinceMs);
    if (!v) return null;
    return { input: Math.max(0, v.input - v.cached), output: v.output, cached: v.cached, cacheRead: v.cached, cacheWrite: 0, untilMs: v.untilMs };
  }
  return null; // loop engine: no session file (see header)
}

/**
 * The late booking (see header). Never throws. `now` and `consumption` are seams for the guards. Returns for tests `{ turns, agents }` —
 * how many rows were booked.
 */
export function lateBookingRestartGrace({ now = Date.now(), consumption = consumptionSince } = {}) {
  let turns = 0, agents = 0;
  let runs = [];
  try { runs = store.listActiveRuns(); } catch { runs = []; }
  for (const r of runs) {
    if (!r.session || !r.provider || running.has(r.chatId)) continue;
    try {
      const v = consumption(r.provider, r.session, Number(r.startedAt) || 0);
      if (!v) continue;
      store.addUsageEvent({ chatId: r.chatId, provider: r.provider, model: r.model || "", ...subscriptionBooking(v), kind: "main", secs: 0, at: v.untilMs || null });
      // Booked: the row names no session any more — the resumed run reports its own, a second restart books nothing twice.
      store.setActiveRunSession(r.chatId, { session: "", provider: "", model: "" });
      turns++;
    } catch (e) { console.error(`[usage] late booking of the turn ${r.chatId} failed:`, e?.message || e); }
  }
  let agentsList = [];
  try { agentsList = store.runningSubagents(); } catch { agentsList = []; }
  for (const a of agentsList) {
    if (a.state !== "running" || !a.sessionId) continue; // parked: its remainder is in the image (see header)
    const since = Number(a.bookedUntil) || Number(a.startedAt) || 0;
    if (!since) continue;
    try {
      const v = consumption(a.provider, a.sessionId, since);
      if (!v) continue;
      store.addUsageEvent({ chatId: a.chatId, provider: a.provider, model: a.model || "", agentId: a.agentId, ...subscriptionBooking(v), kind: "sub", secs: 0, at: v.untilMs || null });
      store.subagentBooked(a.chatId, a.agentId, Math.max(now, v.untilMs || 0));
      agents++;
    } catch (e) { console.error(`[usage] late booking of the subagent ${a.agentId} failed:`, e?.message || e); }
  }
  if (turns || agents) console.log(`[usage] booked late after the restart: ${turns} turn(s), ${agents} subagent(s)`);
  return { turns, agents };
}
