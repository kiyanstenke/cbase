// Opt-in and approval card of a dynamic workflow. A leaf: read by run.js (start and ruling).
//
// TWO WAYS WITHOUT A MODE SWITCH. The chat's ultracode mode opens every start. Besides that:
//   - the KEYWORD: if an input the human typed in THIS turn carries "ultracode", the agent may start in this turn.
//     Only the ONE reading of the human input is consulted (runs/human-input.js) — across bundles and injection;
//     channel, schedule, event and completion notice never count (a workflow result containing the word does not open
//     the next turn).
//   - the APPROVAL CARD: without opt-in the tool returns at once with "waiting for approval", and the chat shows a card
//     with name, description and phases from `meta`. It is modelled on the question (runs/ask.js: non-blocking, the
//     history is the source), NOT on tool approvals — those hold the tool call and appear in /api/runs/active.
//
// The card has roles of its OWN (one role for two kinds is a bug): `workflow_approval` (the card, JSON
// `{ requestId, name, description, phases, at, graph? }` — `graph` = `{ runId, step }` of the graph step it was
// created in) and `workflow_approval_ruling` (the ruling, JSON `{ requestId, decision: "accepted"|"rejected", runId?,
// taskId?, at }`). A card is open as long as the history holds no ruling for its requestId — it survives reload and
// restart and keeps no turn open. What the start needs (script, args, call block, the human's request) lives next to it
// in a file in the chat's output location; the card itself carries only what the human sees. Live, the same two shapes
// travel as harness events (nested under `card` and `ruling`, like `workflow_marker`). Read by web
// lib/workflow-approval.ts and iOS Chat/WorkflowApproval.swift.
//
// The keyword detector follows the behaviour of the pinned Claude version — when the pin moves, it is re-measured:
// Reference-Version: 2.1.322
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import * as store from "../store.js";
import * as wf from "../workflows.js";
import { humanInput } from "../runs/human-input.js";
import { workflowFileToRead, workflowScripts } from "../runs/outputs.js";
import { readFromRuntimeFolder, writeInRuntimeFolder } from "../runs/runtime-write.js";
import { sse } from "../runtime/sse.js";

export const APPROVAL_ROLE = "workflow_approval";
export const RULING_ROLE = "workflow_approval_ruling";
export const APPROVAL_EVENT = "workflow_approval";
export const RULING_EVENT = "workflow_approval_decided";

// ── The keyword (1:1 like Claude Code) ───────────────────────────────────────────────────────────────────────────
// Carried over from the binary of the pinned version (the function behind `workflow_keyword_request` with its bracket
// table): whole word (`\b…\b`), any case; an input that starts with "/" never counts (`/effort ultracode`,
// `/ultracode`); not inside quotes, brackets, backticks or INSIDE a tag (`<ultracode>`) — a tag before and after
// (`<x>ultracode</x>`) masks only itself, the word in between counts; not directly next to "/", "\", "-", not before
// "?", not before "." followed by a word character.
const BRACKETS = { "`": "`", '"': '"', "<": ">", "{": "}", "[": "]", "(": ")", "'": "'" };
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const wordCharacter = (c) => Boolean(c) && WORD_CHARACTER.test(c);

/** Does this (human-typed) text carry the keyword "ultracode"? */
export function carriesKeyword(text) {
  const e = typeof text === "string" ? text : "";
  if (!/ultracode/i.test(e) || e.startsWith("/")) return false;
  // The masked spans: quotes, brackets, tags — an open span without an end masks nothing (as in the baseline).
  const spans = [];
  let open = null;
  let start = 0;
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if (open) {
      if (open === "[" && c === "[") { start = i; continue; }
      if (c !== BRACKETS[open]) continue;
      if (open === "'" && wordCharacter(e[i + 1])) continue; // an apostrophe inside a word ("don't") does not close
      spans.push([start, i + 1]);
      open = null;
    } else if ((c === "<" && i + 1 < e.length && /[a-zA-Z/]/.test(e[i + 1])) || (c === "'" && !wordCharacter(e[i - 1])) || (c !== "<" && c !== "'" && c in BRACKETS)) {
      open = c;
      start = i;
    }
  }
  for (const m of e.matchAll(/\bultracode\b/gi)) {
    const from = m.index;
    const until = from + m[0].length;
    if (spans.some(([a, b]) => from >= a && from < b)) continue;
    const before = e[from - 1];
    const to = e[until];
    if (before === "/" || before === "\\" || before === "-") continue;
    if (to === "/" || to === "\\" || to === "-" || to === "?") continue;
    if (to === "." && wordCharacter(e[until + 1])) continue;
    return true;
  }
  return false;
}

/** Did the human type the keyword into the running turn of this chat? Without a turn: no. */
export function keywordInTurn(chatId) {
  const inputs = humanInput(chatId);
  return Array.isArray(inputs) && inputs.some(carriesKeyword);
}

// ── Opt-in in the graph ─────────────────────────────────────────────────────────────────────────────────────────
// Graph steps run in ordinary coding chats. The ultracode mode from a graph run's run settings arrives through the
// chat (workflows/driver.js carries it over). The second way is the NODE TEXT: if it holds the keyword, EXACTLY this
// step may start. The node text is not human input of the turn but a source of its own — read with the SAME detector
// (`carriesKeyword`), so "/ultracode" and "\"ultracode\"" do not open there either. The text is read as the author
// wrote it (not rendered: a variable that inserts "ultracode" at runtime is foreign text).

/** The step of this chat's open graph run: `{ runId, step, node }`, `null` = no graph run open. */
export function graphStep(chatId) {
  const run = store.getWorkflowRun(chatId);
  if (!store.workflowOpen(run)) return null;
  return { runId: run.id, step: run.step || 0, node: String(run.cursor?.at || "") };
}

/** Does the node the chat's open graph run stands at carry the keyword in its text? */
export function nodeOpens(chatId) {
  const run = store.getWorkflowRun(chatId);
  if (!store.workflowOpen(run) || !run.cursor?.at) return false;
  const def = store.getWorkflow(run.workflowId);
  if (!def) return false;
  const node = wf.currentNode(wf.normalizeGraph(def.graph), run.cursor);
  return carriesKeyword(node?.text);
}

// ── The card ─────────────────────────────────────────────────────────────────────────────────────────────────────
const REQUEST_PATTERN = /^[0-9a-f-]{36}$/;
const jobFile = (chatId, requestId) => path.join(workflowScripts(chatId), "approvals", `${requestId}.json`);
// Read and removed with a fallback to the old location (runs/outputs.js workflowFileToRead): after a project switch
// the file only moves along at the start of the next turn — a ruling before that would not find it (410).
const jobFileExisting = (chatId, requestId) => workflowFileToRead(chatId, path.join("approvals", `${requestId}.json`));
const rowRead = (text) => { try { return JSON.parse(text); } catch { return null; } };

/**
 * Create the card: the job into its file, the card into the history, live into the chat.
 * @returns {{ requestId: string|null, card: Object|null }} — both `null` when the job's location leads out of the
 *   runtime folder (see below)
 */
export function createCard(chatId, { script, meta, args, callId, request, resumeOf = "", budget = null }) {
  const requestId = crypto.randomUUID();
  const file = jobFile(chatId, requestId);
  const content = JSON.stringify({ script, ...(args === undefined ? {} : { args }), callId: String(callId || ""), request: request ?? null, ...(resumeOf ? { resumeOf } : {}),
    // The budget of the turn that produced the card: the ruling comes later, the pot stays the turn's.
    ...(budget?.total ? { budget: { total: budget.total, turnId: budget.turnId || "" } } : {}) });
  // Inside the runtime folder through the descriptor (runs/runtime-write.js): a symlink
  // `outputs/<chat>/workflows → /somewhere` would otherwise place the job outside. If the path leads out, nothing is
  // created — no file, no card, no event — and the answer is `{ requestId: null, card: null }` (the start reports 409).
  try {
    if (!writeInRuntimeFolder(file, content)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  } catch (e) {
    if (e?.code !== "EOUTSIDE" && e?.code !== "ENOFILE") throw e;
    console.warn(`[dynworkflow] card job not stored — ${e.message}`);
    return { requestId: null, card: null };
  }
  const card = {
    requestId,
    name: String(meta?.name || "workflow"),
    description: String(meta?.description || ""),
    phases: (Array.isArray(meta?.phases) ? meta.phases : []).map((p) => ({ title: String(p.title), ...(p.detail ? { detail: String(p.detail) } : {}) })),
    at: Date.now(),
  };
  // The graph step it is created in (like `run.graph` in run.js): a step only holds at ITS card (openCard). A card
  // from a human message, an earlier or cancelled run, or a fork carries no marker or a foreign one.
  const step = graphStep(chatId);
  if (step) card.graph = { runId: step.runId, step: step.step };
  store.addMessage(chatId, APPROVAL_ROLE, JSON.stringify(card), card.at);
  try { sse(chatId, { type: "harness", subtype: APPROVAL_EVENT, card }); } catch { /* no run state */ }
  return { requestId, card };
}

/**
 * The card for a requestId from the history: `null` = no such card, otherwise `{ card, ruling }` (`ruling` null =
 * open).
 */
export function readCard(chatId, requestId) {
  if (!REQUEST_PATTERN.test(String(requestId || ""))) return null;
  let card = null;
  let ruling = null;
  for (const r of store.listMessages(chatId)) {
    if (r.role !== APPROVAL_ROLE && r.role !== RULING_ROLE) continue;
    const z = rowRead(r.text);
    if (z?.requestId !== requestId) continue;
    if (r.role === APPROVAL_ROLE) card = z;
    else if (!ruling) ruling = z; // the FIRST ruling counts
  }
  return card ? { card, ruling } : null;
}

/**
 * The oldest OPEN card of the graph step this chat stands at NOW (`{ requestId, name, description, phases }`), or
 * `null` — also without an open graph run. Read by the graph's hold points (workflows/gates.js, channels/delivery.js)
 * — they ask the question role and would not see the card role otherwise — and by the run view of a background run
 * (it shows what the human approves, hence `description` and `phases`). Bound to run AND step number (the `graph`
 * marker from createCard): a card that stayed open from before the run, comes from a cancelled run or arrived with a
 * fork holds no step — it stays in the chat and is decided there.
 */
export function openCard(chatId) {
  const step = graphStep(chatId);
  if (!step) return null;
  const cards = new Map();
  const decided = new Set();
  for (const r of store.listMessages(chatId)) {
    if (r.role !== APPROVAL_ROLE && r.role !== RULING_ROLE) continue;
    const z = rowRead(r.text);
    if (!z?.requestId) continue;
    if (r.role === APPROVAL_ROLE) {
      if (z.graph?.runId !== step.runId || z.graph?.step !== step.step) continue;
      if (!cards.has(z.requestId)) cards.set(z.requestId, z);
    } else decided.add(z.requestId);
  }
  for (const [requestId, k] of cards) {
    if (decided.has(requestId)) continue;
    return { requestId, name: String(k.name || "workflow"), description: String(k.description || ""), phases: Array.isArray(k.phases) ? k.phases : [] };
  }
  return null;
}

/** The job behind a card (script, args, call block, request) — `null` when the file is missing. Inside the runtime
 *  folder through the descriptor (runs/runtime-write.js readFromRuntimeFolder): a symlink `approvals/<id>.json →
 *  <foreign JSON>` (say, the job of a card in another chat) would otherwise be started as this job, and a FIFO would
 *  stall the server at the ruling — both now count as "missing". */
export function readJob(chatId, requestId) {
  try {
    const file = jobFileExisting(chatId, requestId);
    const text = readFromRuntimeFolder(file, "utf8");
    return JSON.parse(text === null ? fs.readFileSync(file, "utf8") : text);
  } catch { return null; }
}

/** Write the ruling into the history (once — the caller asked `readCard` in the same synchronous step). */
export function writeRuling(chatId, ruling) {
  const row = { ...ruling, at: Date.now() };
  store.addMessage(chatId, RULING_ROLE, JSON.stringify(row), row.at);
  try { fs.rmSync(jobFileExisting(chatId, ruling.requestId), { force: true }); } catch { /* stays behind */ }
  try { sse(chatId, { type: "harness", subtype: RULING_EVENT, ruling: row }); } catch { /* no run state */ }
  return row;
}
