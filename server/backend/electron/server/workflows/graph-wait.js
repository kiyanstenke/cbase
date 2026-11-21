// What a graph workflow run is waiting for. A leaf: read by the run view (graph-start.js graphRunView, field `wait`)
// and by the observer (graph-background.js: a NEW wait is reported, an ended one is settled). It lives here and not in
// graph-background.js, where it would close a cycle (graph-background reads the run view from graph-start).
//
// waitDetail(row, run)  `null` when the run is not waiting for the human, otherwise
//   `{ kind, question, nodeId, step, requestId?, questions?, tool?, input?, dynName?, dynDescription?, dynPhases?,
//      round?, cap? }` — the shape both clients read (web/src/lib/graph-runs.ts GraphWait, iOS Chat/GraphRuns.swift).
//   `kind`:
//     question      a question node (`waiting` without pending — driver.js, node.type "ask")
//     cap           the round cap (`round` = rounds run, `cap` = allowed)
//     review        a review node (`round`)
//     done          the completion check holds (`round`)
//     stopped       halted (stop in the middle of a step)
//     agent_ask     the question card of a step (`requestId`, `questions` — the card's questions, raw)
//     dyn_approval  the approval card of a dynamic workflow inside the step (`requestId`, `dynName`, …)
//     permission    an open permission request in the run chat while the run is `running` (`requestId`, `tool`,
//                   `input` ≤ 2,000) — the view then says "waiting" although the run is running.
//   `question` is `run.question` (for a permission a sentence of its own: the run has no question then).
// instanceOf(wait, run)   the identifier of ONE wait — kind plus card (`requestId`) or node, step and round: a second
//   cap at the same node is a new wait, the same wait after each event is not.

import * as store from "../store.js";
import * as wf from "../workflows.js";
import { T } from "../i18n.js";
import { openAskOf } from "../runs/ask.js";
import { pendingPermissions } from "../runs/approvals.js";
import { openCard } from "../dynworkflows/approval.js";

// How much of a tool's input the view carries (the card truncates once more).
const INPUT_MAX = 2_000;
const WAIT_KINDS = new Set(["cap", "review", "done", "stopped", "agent_ask", "dyn_approval"]);

const inputText = (input) => {
  let s = "";
  try { s = typeof input === "string" ? input : JSON.stringify(input ?? {}); } catch { s = String(input ?? ""); }
  return s.length > INPUT_MAX ? `${s.slice(0, INPUT_MAX - 1)}…` : s;
};

// The oldest open permission request of the chat (main run or one of its agents — the wait is for the human).
function openPermission(chatId) {
  let old = null;
  for (const p of pendingPermissions.values()) {
    if (p.chatId !== chatId) continue;
    if (!old || (p.at || 0) < (old.at || 0)) old = p;
  }
  return old;
}

function waitDetail(z, run) {
  if (!z || !run || z.status !== "started" || run.id !== z.runId || !store.workflowOpen(run)) return null;
  const runChatId = z.childChatId || z.chatId;
  const base = { nodeId: run.nodeId || "", step: Number(run.step) || 0 };
  if (run.status === "waiting") {
    const pending = wf.pendingOf(run.cursor);
    const kind = pending?.kind || "question";
    if (kind !== "question" && !WAIT_KINDS.has(kind)) return null;
    const w = { kind, question: String(run.question || ""), ...base };
    if (kind === "cap") Object.assign(w, { round: Number(pending.count) || 0, cap: Number(pending.cap) || 0 });
    if (kind === "review") w.round = Number(pending.round) || 1;
    if (kind === "done") w.round = Number(pending.count) || 0;
    if (kind === "agent_ask") {
      const ask = openAskOf(runChatId);
      w.requestId = String(pending.requestId || ask?.requestId || "");
      w.questions = ask && ask.requestId === w.requestId ? ask.questions : [];
    }
    if (kind === "dyn_approval") {
      const card = openCard(runChatId);
      w.requestId = String(pending.requestId || card?.requestId || "");
      const matches = card && card.requestId === w.requestId;
      Object.assign(w, { dynName: matches ? card.name : "", dynDescription: matches ? card.description : "", dynPhases: matches ? card.phases : [] });
    }
    return w;
  }
  const p = openPermission(runChatId);
  if (!p) return null;
  const tool = String(p.toolName || "");
  return {
    kind: "permission", ...base, requestId: String(p.requestId || ""), tool, input: inputText(p.input),
    question: T`May ${tool || T("the tool")} run?`,
  };
}

function instanceOf(w, run) {
  if (!w) return "";
  if (w.requestId) return `${w.kind}:${w.requestId}`;
  return `${w.kind}:${w.nodeId}:${w.step}:${w.round ?? ""}:${run?.id || ""}`;
}

export { instanceOf, waitDetail };
