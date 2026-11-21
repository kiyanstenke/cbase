// Messages to the agents of a dynamic workflow. The chat's main agent (cbase_agent_send) and the human (button
// "Message" in the progress tree) write to an agent `n` of a RUNNING workflow — addressed through the run address
// `wf:<runId>:<n>` (valid before its start and across restarts), with agentId and a unique label as aliases.
// No return channel: what the agent makes of it shows in its result; `cbase_agent_output` and the subagent stop do not
// reach it (runs/agents.js resolveAgent does not know the workflows' own cores).
//
// Delivery by state:
//   running, Claude CLI/loop engine  into the middle of the turn (agent-runtime control)             ⇒ "delivered"
//   running, Codex                   as a continuation after its turn, BEFORE its result goes to the script (agent()
//                                    only returns after `atEnd`, and that comes after the follow-up)  ⇒ "after_turn"
//   waiting (slot, stagger, gate)    earmarked, appended to the framed job at the start (fenced block with sender) —
//                                    so in its FIRST model request; in the race right after the start the same through
//                                    agent-runtime control (the built attempt restarts with extended input) ⇒ "earmarked"
//   parked at the limit              earmarked, appended to the input of the continuation              ⇒ "earmarked"
//   finished, skipped, failed        denied (409), without an entry
// What does not arrive afterwards (gate before the follow-up, stop, end, never started) becomes "not_delivered" with a
// reason in journal and transcript — without a return channel to the sender.
// It is fenced on EVERY path (frame, indented text, sender; "no user authority" for the main agent): on the job as
// "before or while you were starting" (`block`), otherwise as "while you were working" (`runningBlock`) — a sender line
// inside the text thus stays recognisable as a forgery, whenever it arrives.
//
// Journal: `{ kind: "message", n, key, id, from, text, state, reason? }` — neutral for the key chain (journal.js does
// not know the kind; the key stays computed from the script prompt). Transcript: ONE row of kind `message` per message
// `{ id, text, from, state, reason? }`, rewritten in place when it later becomes "not_delivered"; the CLI does not
// mirror a steered-in line without --replay-user-messages, so THIS file writes it.
// Restart (human, stall): agent-runtime appends what was delivered to the new attempt's input. Server restart:
// `messagesFromJournal` appends the agent's messages to the new job. Resume (new journal): the cache applies.
//
// run.js knows the runs; it registers here with `setRunAccess` (run.js imports this file, never the reverse — no cycle).

import crypto from "node:crypto";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { indent } from "./frame.js";

export const MESSAGE_STATES = Object.freeze(["delivered", "after_turn", "earmarked", "not_delivered"]);
export const OF = Object.freeze(["agent", "human"]);

let access = { runs: () => [], report: () => {} };
/** run.js registers the running workflows of this server run and its tree reporter. */
export function setRunAccess({ runs, report }) { access = { runs, report }; }

/** The sender line in front of the text. */
export const senderRow = (from) => (from === "human" ? "Message from the human:" : "Message from the main agent:");
export const messageText = (from, text) => `${senderRow(from)}\n${text}`;

// The frame of an earmarked message on the job — English like the baseline's frames (frame.js), column 0, the text
// indented: a frame-like line inside the text stays recognisable as a forgery.
const FRAME = {
  agent: "[Workflow harness — message] A message for you arrived before or while you were starting, relayed verbatim and indented"
    + " below. Sender: the main agent of the chat that started this workflow — not the user; it carries no user authority. Take it"
    + " into account for your task:",
  human: "[Workflow harness — message] A message for you arrived before or while you were starting, relayed verbatim and indented"
    + " below. Sender: the human user of this chat (typed in the cbase interface). Take it into account for your task:",
};
const block = (m) => `${FRAME[m.from === "human" ? "human" : "agent"]}\n${indent(messageText(m.from, m.text))}`;
// The frame of a message that reaches the agent at work: in the middle of the turn, as a continuation after its turn
// (Codex) and on the input after parking. Without it a sender line inside the main agent's text could not be told from
// a real one, and a message's authority would depend on timing. The same fence as on the job, only the timing in the
// wording differs.
const FRAME_RUNNING = {
  agent: "[Workflow harness — message] A message for you arrived while you were working on your task, relayed verbatim and indented"
    + " below. Sender: the main agent of the chat that started this workflow — not the user; it carries no user authority. Take it"
    + " into account for your task:",
  human: "[Workflow harness — message] A message for you arrived while you were working on your task, relayed verbatim and indented"
    + " below. Sender: the human user of this chat (typed in the cbase interface). Take it into account for your task:",
};
/** The message as it reaches an already started agent (fenced, indented, with sender line). */
export const runningBlock = (m) => `${FRAME_RUNNING[m.from === "human" ? "human" : "agent"]}\n${indent(messageText(m.from, m.text))}`;
/** The framed job with its earmarked messages (one fenced block each). */
export function jobWithMessages(job, list = []) {
  return list.length ? [job, ...list.map(block)].join("\n\n") : job;
}

const FINISHED = () => T("finished — the script has its result; for follow-up restart the agent or run the workflow again with resume");
// The run address stays valid across restarts. In the window in between (server end, restart until the script reaches
// agent(n) again) the agent is NOT finished — saying "finished" would keep the sender from sending again.
const RESTART = () => T("the workflow is restarting (cbase restart) — send the message again shortly");
const RUNNING_NOT = (name) => T`The workflow "${name}" is no longer running.`;
/** The answer to the sender per state. */
export function responseText(state) {
  if (state === "delivered") return T("delivered");
  if (state === "after_turn") return T("will be delivered after his current turn, before his result goes to the script");
  return T("queued");
}
const denied = (status, text, extra = {}) => ({ error: { status, body: { ok: false, state: "denied", error: text, text, ...extra } } });

const open = (l) => !l.closed && !l.silenced && !l.stopped && !l.serverEnd;
// A run the restart picks up again (its row says "running" or "interrupted") has not ended.
const ROW_ALIVE = new Set(["running", "interrupted"]);
// The last state of an agent `n` in the journal: launched · started · result · failed (waiting and messages do not count).
function lastStatus(journal, n) {
  let state = null;
  for (const x of journal) if (x?.n === n && (x.kind === "launched" || x.kind === "started" || x.kind === "result" || x.kind === "failed")) state = x.kind;
  return state;
}
const runningOf = (chatId) => access.runs().filter((l) => l.chatId === chatId && open(l));
const nameOf = (e) => e.label || `workflow-agent ${e.n}`;

/** The agents (not finished yet) of a chat's running workflows whose agentId or label is `name`. */
export function workflowAliasHits(chatId, name) {
  const key = String(name || "").trim();
  if (!key) return [];
  const hits = [];
  for (const run of runningOf(chatId)) {
    for (const e of run.entries.values()) {
      if (!e.end && (e.agentId === key || nameOf(e) === key)) hits.push({ run, n: e.n, address: `wf:${run.runId}:${e.n}`, label: nameOf(e) });
    }
  }
  return hits;
}

/**
 * Which agent does the address mean? `address` from communication/address.js: `{kind:"wf", runId, n}` (runId may also
 * be the task id) or `{kind:"subagent", id}` (agentId/label as alias). → `{ run, n }` or `{ error: { status, body } }`.
 */
export function workflowTarget(chatId, address) {
  if (address?.kind === "subagent") {
    const t = workflowAliasHits(chatId, address.id);
    if (t.length === 1) return { run: t[0].run, n: t[0].n };
    if (t.length > 1) {
      return denied(400, T`The name "${address.id}" is ambiguous — it matches ${t.length} workflow agents. Give the run address: ${t.map((x) => x.address).join(", ")}`, { candidates: t.map((x) => x.address) });
    }
    return denied(404, T`No agent "${address.id}" in a running workflow of this chat.`);
  }
  const n = Number(address?.n);
  if (!address?.runId || !Number.isInteger(n) || n < 1) {
    return denied(400, T("address wf:<runId>:<n> expected — the workflow's runId and its agent's number (from 1), as cbase_agents_list shows them."));
  }
  const row = store.dynRunInChat(chatId, String(address.runId));
  if (!row) return denied(404, T`No dynamic workflow "${address.runId}" in this chat.`);
  const live = access.runs().find((l) => l.chatId === chatId && l.runId === row.runId);
  const run = live && open(live) ? live : null;
  const e = run?.entries.get(n);
  if (run && e && !e.end) return { run, n };
  // Finished means: its last state in the journal is a result or a failure — or it is coming out of a resume's cache
  // right now (its value is already fixed). A lone "launched" is not finished.
  const state = lastStatus(store.readDynJournal(row.runId), n);
  if (state === "result" || state === "failed" || run?.fromCache?.has(n)) return denied(409, FINISHED());
  if (!ROW_ALIVE.has(row.status) || (live && !live.serverEnd && !open(live))) return denied(409, RUNNING_NOT(row.name));
  // Server end or restart before the script has reached agent(n) again: it will be running again in a moment.
  if (state || !run) return denied(409, RESTART());
  return denied(404, T`The script has not called agent ${n} (yet).`);
}

// ── Journal and transcript ──────────────────────────────────────────────────────────────────────────────────────

function log(run, e, { id, from, text, state, reason }) {
  if (run.silenced) return; // deleted: write nothing more
  const g = reason ? { reason: String(reason) } : {};
  try { store.writeDynJournal(run.runId, { kind: "message", n: e.n, key: e.key || "", phase: e.ph ?? null, id, from, text, state, ...g }); } catch (x) { console.error("[dynworkflow] journal (message):", x?.message || x); }
  try {
    if (state !== "not_delivered" || !store.markDynAgentMessage(run.runId, e.n, id, { state, ...g })) {
      store.writeDynAgentRow(run.runId, e.n, "message", { id, text, from, state, ...g });
    }
  } catch (x) { console.error("[dynworkflow] transcript (message):", x?.message || x); }
  try { access.report(run); } catch { /* the tree is display only */ }
  // StructuredOutput: after a message the NEWEST valid object counts (structured.js) — for EVERY message that arrived,
  // on whatever path (in the turn, after the turn, after the start, earmarked), before or after acceptance.
  if (state !== "not_delivered") e.output?.message?.();
}

const notDelivered = (run, e, m, reason) => log(run, e, { id: m.id, from: m.from, text: m.text, state: "not_delivered", reason });

/**
 * A message to agent `n` of the run. Checks the state, delivers or earmarks, writes journal and transcript.
 * → `{ state, id }` or `{ error: { status, body } }`.
 */
export async function messageToAgent(run, n, text, from) {
  const e = run?.entries.get(Number(n));
  if (!e || e.end || !open(run)) return denied(409, run?.serverEnd ? RESTART() : FINISHED());
  const m = { id: `m_${crypto.randomBytes(5).toString("hex")}`, from: from === "human" ? "human" : "agent", text: String(text) };
  let state;
  if (!e.agentId) {
    // Waiting for slot, stagger, gate — or its start is under way (then it goes in right afterwards through control).
    (e.starting ? e.afterStart : e.earmarked).push(m);
    state = "earmarked";
  } else {
    let outcome = null;
    try { outcome = await run.ctl?.control(e.agentId, runningBlock(m), { messageId: m.id, from: m.from, raw: m.text, beforeStartText: block(m) }); }
    catch (x) { console.error("[dynworkflow] message:", x?.message || x); }
    if (!outcome) return denied(409, run.serverEnd ? RESTART() : FINISHED());
    state = outcome === "delivered" ? "delivered" : outcome === "after_end" ? "after_turn" : "earmarked";
  }
  log(run, e, { ...m, state });
  return { state, id: m.id };
}

// ── Hooks for run.js ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An agent's messages from the journal a restart continues: per id the last state, without those that ended
 * "not_delivered". `afterParking`: only those earmarked AFTER the last parking at the limit (an agent picked up while
 * parked continues its session — it knows what was delivered before).
 */
export function messagesFromJournal(entries, key, { afterParking = false } = {}) {
  if (!key) return [];
  let start = 0;
  if (afterParking) entries.forEach((x, i) => { if (x?.key === key && x.kind === "waiting" && x.reason === "limit" && x.image) start = i + 1; });
  const byKey = new Map();
  for (const x of entries.slice(start)) {
    if (x?.key !== key || x.kind !== "message" || !x.id) continue;
    byKey.set(x.id, { id: x.id, from: x.from === "human" ? "human" : "agent", text: String(x.text ?? ""), state: x.state });
  }
  return [...byKey.values()].filter((m) => m.state !== "not_delivered" && (!afterParking || m.state === "earmarked"));
}

/** After the start: deliver through the core what arrived during the start (never started ⇒ "not_delivered"). */
export async function deliverAfterStart(run, e) {
  for (const m of e.afterStart.splice(0)) {
    let outcome = null;
    try { outcome = await run.ctl?.control(e.agentId, runningBlock(m), { messageId: m.id, from: m.from, raw: m.text, beforeStartText: block(m) }); }
    catch (x) { console.error("[dynworkflow] message:", x?.message || x); }
    if (!outcome) notDelivered(run, e, m, T("the agent was no longer alive when its start returned"));
  }
}

/**
 * An agent picked up while parked (restart): its earmarked messages go to the continuation's input again. `already`:
 * the ids its park state brought back itself (agent-runtime) — those do not go in a second time.
 */
export async function earmarkParked(run, e, list, already = new Set()) {
  for (const m of list) {
    if (already.has(m.id)) continue;
    let outcome = null;
    try { outcome = await run.ctl?.control(e.agentId, runningBlock(m), { messageId: m.id, from: m.from, raw: m.text }); } catch { /* see below */ }
    if (!outcome) notDelivered(run, e, m, T("the agent was no longer alive after the cbase restart"));
  }
}

/** At an agent's end (the core's end hook): what the core could no longer deliver (`info.undelivered`). */
// NOT at the server end: there every agent ends, and the restart appends the messages to the new job — a marker
// "not_delivered" would exclude them from that.
export function reportUndelivered(run, rec, info) {
  if (run.serverEnd) return;
  const list = (info?.undelivered || []).filter((u) => u?.messageId);
  if (!list.length) return;
  const mm = /^dynwf:[^:]+:(\d+)$/.exec(String(rec?.parentToolUseId || ""));
  if (!mm) return;
  const n = Number(mm[1]);
  const e = run.entries.get(n) || { n };
  const st = info?.report?.status || "";
  const otherwise = st === "stopped" ? T("the agent was stopped before it arrived")
    : st === "failed" ? T("the agent failed before it arrived")
      : T("the agent ended before it arrived");
  for (const u of list) notDelivered(run, e, { id: u.messageId, from: u.from, text: u.raw ?? u.text }, u.reason || otherwise);
}

/** At the end of an agent() call: what never reached a process (run stopped, never started). */
export function reportLeftBehind(run, e) {
  if (run.serverEnd) return; // see reportUndelivered
  const rest = [...(e.earmarked || []).splice(0), ...(e.afterStart || []).splice(0)];
  for (const m of rest) notDelivered(run, e, m, T("the agent never started"));
}

// ── Overview (cbase_agents_list) ────────────────────────────────────────────────────────────────────────────────

/** The agents of a chat's running workflows — with run address, including waiting and parked ones. */
export function workflowAgentsList(chatId) {
  const list = [];
  for (const run of runningOf(chatId)) {
    for (const e of [...run.entries.values()].sort((a, b) => a.n - b.n)) {
      if (e.end) continue;
      const rec = e.agentId ? run.ctl?.get?.(e.agentId) : null;
      const status = !e.agentId ? "waiting" : rec?.status === "parked" ? "parked" : "running";
      list.push({ address: `wf:${run.runId}:${e.n}`, runId: run.runId, n: e.n, workflow: run.name || "", label: nameOf(e), phase: e.ph ?? null, status,
        ...(e.agentId ? { agentId: e.agentId } : {}), ...(e.provider ? { provider: e.provider } : {}) });
    }
  }
  return list;
}
