// The driver: beginWorkflow, limitEndNote, finishWorkflow, JSON helpers, loopLog, runningVerdicts, verdict oneshots
// (judgeWorkflowCondition, judgeNodeDone, doneJudgeModel), produceWorkflowList, driveWorkflow.

import crypto from "node:crypto";
import { runOnce } from "../claude.js";
import { isProviderId } from "../providers/index.js";
import { ultracodeFollowUp } from "../chats/ultracode.js";
import * as wf from "../workflows.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { WORKFLOW_MAX_STEPS, WORKFLOW_MAX_VISITS, closeRunStep, emitWorkflowRun, runStillOur, logRunStep, notifyNodeReached, runLockKey, runStepStart, workflowGraph, workflowIntent, workflowNote } from "./run-state.js";
import { agentRunFor, agentModelFor } from "../settings/agent-models.js";
import { broadcast, sse } from "../runtime/sse.js";
import { autocompactPercent, clearChatContext, compactChatContext, compactionDue } from "../runs/post-run.js";
import { defaultModelFor } from "../account/providers.js";
import { dismissAsk } from "../runs/ask.js";
import { doRun } from "../runs/do-run.js";
import { isLimitError, clearAwayJudgeRow, parkJudge, drainQueue } from "../runs/auto-continue.js";
import { sandboxed } from "../runs/sandboxing.js";
import { compacting, running, workflowDecidesOn, workflowDecidesOff } from "../runs/state.js";
import { resolveSkillSlash } from "../toolchain/skill-catalog.js";
import { onceBooking } from "../runs/booking.js";
// The job of every node turn carries what is earmarked for the graph run.
import { withEarmarked } from "./graph-message.js";


// Starts a workflow in a chat. Returns: { run } — or { blocked, key, lock } when another run
// holds the lock. The caller then decides: the trigger puts the event back (it returns at the
// next tick), a manual start gets a 409.
function beginWorkflow(chatArg, workflow, input = "", opts = {}) {
  let chat = chatArg;
  const graph = wf.normalizeGraph(workflow.graph);
  const { total, approx } = wf.countSteps(graph);
  const runId = opts.runId || crypto.randomUUID();
  const lockKey = opts.lockKey !== undefined ? opts.lockKey : runLockKey(workflow, chat, opts.vars, input);
  if (lockKey) {
    const got = store.acquireLock(lockKey, {
      runId, chatId: chat.id, workflowId: workflow.id, workflowName: workflow.name,
      workspaceId: chat.workspaceId || "",
    });
    if (!got.ok) return { blocked: true, key: lockKey, lock: got.lock };
  }
  // Transfer the run settings to the chat (only SET fields — an empty field must not overwrite
  // the user's choice). For triggered runs that already happened when the chat was created; a
  // chat started by hand is switched here, so the steps really run with the model/permissions
  // set on the workflow.
  // Ultracode (via the ONE rule `chats/ultracode.js`): switch on ⇒ the chat carries it; the effort stays untouched
  // (two independent axes). The rule returns the switch as 0/1 (SQLite binds no booleans).
  const runFields = ultracodeFollowUp(chat, wf.chatFieldsFromRun(workflow.run));
  const changed = Object.keys(runFields).filter((k) => (k === "ultracode" ? !!chat.ultracode !== !!runFields.ultracode : (chat[k] || "") !== runFields[k]));
  if (changed.length) {
    try {
      store.updateChat(chat.id, runFields);
      chat = { ...chat, ...runFields, ...("ultracode" in runFields ? { ultracode: !!runFields.ultracode } : {}) };
      sse(chat.id, { type: "harness", subtype: "chat_settings", ...runFields });
      broadcast({ type: "chat_meta", chatId: chat.id }); // header/list show model + permissions
    } catch (e) { console.error("[workflow] run settings:", e?.message || e); }
  }
  // An unanswered question card from an EARLIER run survives in the history (sticky in
  // openAskOf) and would halt the first step of the new workflow right away — with the foreign
  // question, logged as the question of THIS step.
  dismissAsk(chat.id, "workflow-start");
  const run = store.startWorkflowRun({
    id: runId, chatId: chat.id, workflowId: workflow.id, workflowName: workflow.name,
    input, total, cursor: wf.initialCursor(graph, input, opts),
    origin: opts.vars?.origin === "trigger" ? "trigger" : "",
    triggerEvent: opts.triggerEvent || null,
    workspaceId: chat.workspaceId || "", projectId: chat.projectId || null,
  });
  runStepStart.delete(chat.id);
  if (opts.triggerEvent) logRunStep(run, "trigger", { nodeId: opts.at || "", nodeTitle: opts.triggerEvent.node || "", detail: { event: opts.triggerEvent } });
  logRunStep(run, "start", { detail: { name: workflow.name, total, approx, input: String(input || "").slice(0, 4000) } });
  workflowNote(chat.id, { kind: "start", name: workflow.name, total, approx });
  emitWorkflowRun(chat.id, run);
  driveWorkflow(chat.id).catch((e) => console.error("[workflow] start failed:", e?.message || e));
  return { run };
}
// The ONE wording with which a workflow ends when a verdict failed at the usage limit (or at the
// credits gate) and could NOT be parked (auto-continue off at a CLI limit, attempt cap, credits
// without reset) — five verdict sites (condition, loop list, completion gate, cap and review
// interpretation) and the discarded wait row (cancelAutoContinue) write it.
const limitEndNote = () => T("Usage limit — no automatic continuation.");
function finishWorkflow(chatId, status, note = "") {
  const before = store.getWorkflowRun(chatId);
  // A run ends EXACTLY ONCE. Since cancelAutoContinue closes a hanging workflow whenever the wait
  // row is discarded, a second end reaches the same row on two paths: parkJudge →
  // maybeAutoContinue → "gave-up"/"credits" → cancelAutoContinue ends the run, and the verdict
  // site (condition, list, gate, cap, review) ends it once more right after, because parking did
  // not take over. Two end rows, two notifications, and the second reason would overwrite the
  // first — although the first ("usage limit") is the true one.
  // `before &&` is load-bearing: if there IS no run, we do NOT bail out here (the caller then
  // creates nothing but cleans up). `!workflowOpen(null)` alone would be `true` and thus a
  // silent exit.
  if (before && !store.workflowOpen(before)) return before;
  // A parked verdict of this run waits for a node that no longer exists.
  clearAwayJudgeRow(chatId);
  // When the run ends (done, cancelled, failed), a still open question card is moot: its answer
  // would have no session left to go into. Clean up before the status change, while the card
  // still counts as open on the server at all (sticky in openAskOf). The clients collapse it at
  // the same point (row kind='end').
  dismissAsk(chatId, `run-${status}`);
  // A step that was still open at the end would otherwise stay without duration and result
  // forever.
  if (before) closeRunStep(before, { ok: false, error: status === "cancelled" ? "aborted" : status });
  // The wait state belongs to the running operation: after the end the view would still say
  // "waiting for the cap" although nobody is waiting any more.
  const cursorWithoutHold = before?.cursor ? wf.clearPending(before.cursor) : null;
  const run = store.updateWorkflowRun(chatId, { status, note, question: "", nodeId: "", nodeTitle: "", ...(cursorWithoutHold ? { cursor: cursorWithoutHold } : {}) });
  runStepStart.delete(chatId);
  logRunStep(run || before, "end", { step: run?.step || 0, detail: { status, note, ms: run?.startedAt ? Date.now() - run.startedAt : 0 } });
  workflowNote(chatId, { kind: "end", status, note, step: run?.step || 0 });
  emitWorkflowRun(chatId, run);
  return run;
}

// Cut JSON out of a model response. The naive grab "from the first { to the last }" is greedy:
// "Here: [\"a\"] and also [\"b\"]" yields garbage that way although both brackets are valid on
// their own. Hence first the big grab, then each bracket group individually — from the back,
// because a model puts its answer at the end when it explains something first.
function jsonFrom(text, open, close) {
  const s2 = String(text || "");
  const candidates = [];
  const first = s2.indexOf(open);
  const last = s2.lastIndexOf(close);
  if (first >= 0 && last > first) candidates.push(s2.slice(first, last + 1));
  // Each balanced group on its own, last one first.
  const groups = [];
  let depth = 0, start = -1;
  for (let i = 0; i < s2.length; i++) {
    if (s2[i] === open) { if (depth === 0) start = i; depth++; }
    else if (s2[i] === close && depth > 0) { depth--; if (depth === 0 && start >= 0) groups.push(s2.slice(start, i + 1)); }
  }
  candidates.push(...groups.reverse());
  for (const k of candidates) {
    try { return JSON.parse(k); } catch { /* next candidate */ }
  }
  return undefined;
}
const jsonObject = (text) => { const v = jsonFrom(text, "{", "}"); return v && typeof v === "object" && !Array.isArray(v) ? v : null; };
const jsonList = (text) => { const v = jsonFrom(text, "[", "]"); return Array.isArray(v) ? v : null; };
// "unclear" (unclear): condition and loop list judge sandboxed and cannot look anything up (see verdictOneshot). If the
// material is not enough, they answer {"unclear": "<reason>"} instead of guessing — a value of its OWN, not an empty
// verdict: `[]` remains the genuine empty list. Returns the reason (never empty) or null. An object that carries a
// verdict next to "unclear" is unclear: the model itself said that it cannot decide.
function unclearFrom(text) {
  const obj = jsonObject(text);
  if (!obj || obj.unclear === undefined || obj.unclear === null || obj.unclear === false) return null;
  const reason = String(obj.unclear).replace(/\s+/g, " ").trim().slice(0, 140);
  return reason || T("no reason given");
}

// Log row of a loop: the elements that REALLY run, plus the number of dropped ones — the row,
// the run and the cap must show the same number.
function loopLog(node, items) {
  const cap = Math.min(node.maxIterations || 20, wf.MAX_ITERATIONS);
  const usable = items.filter((x) => String(x || "").trim());
  const run = usable.slice(0, cap);
  const dropped = usable.length - run.length;
  return { items: run, cap, ...(dropped ? { dropped } : {}) };
}

// A verdict (condition, list, completion gate, interpretation of an answer) is a model call but
// NOT a turn: it is not in the `running` set, shows up in no event stream and therefore could
// not be stopped — a /stop would answer "no running run", and the workflow would then run
// through completely. This count makes it visible; the stop path above it halts the RUN, and
// the returning verdict notices via `runStillOur` that it is no longer its own and writes nothing.
const runningVerdicts = new Map(); // chatId -> number of open verdict oneshots
// Test seam: how often a driver saw a foreign compaction before a step and kept waiting. A test
// proves "the step did NOT start next to it" by counted occasions instead of a second of
// silence. Only counted, nothing reads it.
let compactionWaitCounter = 0;
const compactionWaitRounds = () => compactionWaitCounter;
// `overruled`: the human released the parked verdict via "start anyway" — fireAutoContinueInner
// passes it through resumeJudge down to here, to EVERY verdict of the chain up to the next turn
// (gate → condition → list). A verdict after a turn never gets it: it checks the start gate
// itself and parks when caught (isLimitError ⇒ parkJudge).
// Sandboxed (runs/sandboxing.js): all four verdicts (condition, list, completion gate, interpretation of an answer)
// judge what is in the prompt — the condition or the job and the last output of the step or the human's answer —, and
// the output of a step is foreign text (tool outputs, web pages). A list "all folders under packages/" without the
// output of the step before it cannot be looked up by the verdict itself: it belongs into a step whose output names it.
// So that the verdict does not GUESS, the prompts tell it explicitly (workflows.js conditionPrompt, loopListPrompt,
// donePrompt), and condition and list have the answer {"unclear": "<reason>"} (unclearFrom): the run then fails
// VISIBLY on the same path as an unreadable verdict (`failed`, log row with `unclear`, end note with the reason),
// without a second attempt — the same material would yield the same answer. Otherwise a guessed condition would run
// down one branch and an empty list zero rounds, both as "done". The completion gate has NO "unclear": when in doubt
// "not done", and the agent of the step, who can look things up, delivers more.
async function verdictOneshot(chat, prompt, model = "", { overruled = false } = {}) {
  const id = chat.id;
  runningVerdicts.set(id, (runningVerdicts.get(id) || 0) + 1);
  try {
    return await runOnce(prompt, { ...sandboxed(), timeoutMs: 60_000, model: model || agentModelFor("workflow"), effort: agentRunFor("workflow").effort, chatId: chat.id, overruled, atConsumption: onceBooking("workflow_verdict", chat.id) });
  } finally {
    const n = (runningVerdicts.get(id) || 1) - 1;
    if (n > 0) runningVerdicts.set(id, n); else runningVerdicts.delete(id);
  }
}

// Verdict on a condition. Two attempts; after that rather fail honestly than guess — a wrongly
// guessed branch would work off half the workflow on the wrong branch.
async function judgeWorkflowCondition(chat, node, lastOutput, vars, loop, arrival, { overruled = false } = {}) {
  const prompt = wf.conditionPrompt({ node, lastOutput, vars, loop, arrival });
  // Raw output and errors of the attempts are PASSED ALONG, not swallowed: if the verdict fails,
  // exactly that is the question when debugging ("what did the model answer instead?").
  const tries = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let out = "";
    try {
      out = await verdictOneshot(chat, prompt, "", { overruled });
      tries.push(String(out || "").slice(0, 1200));
      // "unclear" before the verdict and without a second attempt: the same material would yield the same answer (see verdictOneshot).
      const unclear = unclearFrom(out);
      if (unclear !== null) return { failed: true, unclear, prompt, tries };
      const obj = jsonObject(out) || {};
      if (typeof obj.yes === "boolean") return { yes: obj.yes, note: String(obj.note || "").slice(0, 140), prompt, tries };
    } catch (e) {
      // At the usage limit the second attempt is only the second failure — we wait here.
      if (isLimitError(e)) return { limited: true, error: e, prompt, tries };
      tries.push(`${String(out || "").slice(0, 600)} ⟶ ${e?.message || e}`);
    }
  }
  return { failed: true, prompt, tries };
}
// Completion gate of a node ("check completion"): judges after the turn whether the step is
// done. Same build as judgeWorkflowCondition — two attempts, strict JSON, at the usage limit we
// wait instead of guessing. "Unusable verdict" does NOT mean "done": the step then gets another
// round, otherwise exactly the case the check is meant to prevent would slip through. The round
// cap is a run setting per workflow (`run.doneRounds`, see gates.js).
// `model`: the workflow's choice (see doneJudgeModel) — it is part of the verdict so the
// history says WHO judged when a gate was too strict or too lax.
async function judgeNodeDone(chat, node, lastOutput, vars, loop, model = "", { overruled = false } = {}) {
  const prompt = wf.donePrompt({ node, lastOutput, vars, loop });
  const tries = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let out = "";
    try {
      out = await verdictOneshot(chat, prompt, model, { overruled });
      tries.push(String(out || "").slice(0, 1200));
      const obj = jsonObject(out) || {};
      if (typeof obj.done === "boolean") return { done: obj.done, note: String(obj.note || "").slice(0, 200), prompt, tries, model };
    } catch (e) {
      if (isLimitError(e)) return { limited: true, error: e, prompt, tries, model };
      tries.push(`${String(out || "").slice(0, 600)} ⟶ ${e?.message || e}`);
    }
  }
  return { failed: true, done: false, note: "", prompt, tries, model };
}
// What the completion gate of THIS workflow judges with (run settings): model with provider in
// the form "provider::model" (which runOnce understands), a provider alone with its default
// model, otherwise the app agent "workflow" — the same choice as for conditions and lists.
function doneJudgeModel(run) {
  const s = wf.normalizeRunSettings(run);
  if (s.doneModel) return s.doneProvider ? `${s.doneProvider}::${s.doneModel}` : s.doneModel;
  if (isProviderId(s.doneProvider)) return `${s.doneProvider}::${defaultModelFor(s.doneProvider)}`;
  return agentModelFor("workflow");
}
// List of a loop without fixed elements.
async function produceWorkflowList(chat, node, lastOutput, vars, { overruled = false } = {}) {
  const prompt = wf.loopListPrompt({ node, lastOutput, vars });
  const tries = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let out = "";
    try {
      out = await verdictOneshot(chat, prompt, "", { overruled });
      tries.push(String(out || "").slice(0, 1200));
      // "unclear" is NOT the empty list: `[]` continues (zero rounds, exit "done"), "unclear" fails visibly.
      const unclear = unclearFrom(out);
      if (unclear !== null) return { failed: true, unclear, prompt, tries };
      const arr = jsonList(out);
      // `null` in the list is not an element: it would become the text "null" and cost a real,
      // paid iteration. Objects are kept as JSON — those are a statement.
      if (arr) {
        return {
          items: arr.filter((x) => x !== null && x !== undefined && x !== "")
            .map((x) => (typeof x === "string" ? x : JSON.stringify(x))),
          prompt, tries,
        };
      }
    } catch (e) {
      if (isLimitError(e)) return { limited: true, error: e, prompt, tries };
      tries.push(`${String(out || "").slice(0, 600)} ⟶ ${e?.message || e}`);
    }
  }
  return { failed: true, prompt, tries };
}

// Nodes before which the driver may compact (see driveWorkflow): those with an agent turn.
// `ask` counts as a step but has no turn — there would be nothing to relieve.
const COMPACTION_KINDS = new Set(["instruction", "parallel", "review"]);
// Core of the driver: advances through the graph until a turn is needed (then doRun takes over
// and calls workflowGateAfterRun after its end) or the run ends.
// `overruled`: the release of a "start anyway" at the parked verdict applies to the WHOLE
// verdict chain up to the next turn (see verdictOneshot) — doRun below does not get it, the
// next turn asks its gate itself.
// While the driver advances — condition, list, cap, compaction between two steps, all without a turn —, the chat is
// BUSY (runs/state.js workflowDecides), set SYNCHRONOUSLY on entry, before the first await. Otherwise a message in
// this window would start a turn of its own right away, the driver would return at `running`, and the gate afterwards
// would take the reply as the result of the step whose job never went out. When the last decision ends, the queue
// drains (end, wait) or goes along with the step just started (whose `running` then holds it).
async function driveWorkflow(chatId, lastOutput = "", opts = {}) {
  workflowDecidesOn(chatId);
  try { return await driveWorkflowIntern(chatId, lastOutput, opts); }
  finally {
    if (workflowDecidesOff(chatId)) {
      try { drainQueue(chatId); } catch (e) { console.error("[workflow] queue after the driver:", chatId, e?.message || e); }
    }
  }
}
async function driveWorkflowIntern(chatId, lastOutput = "", { overruled = false } = {}) {
  // The gate calls from inside doRun — let its finally block pass first, otherwise the next
  // turn would stand in the `running` set of the one just ending.
  await Promise.resolve();
  for (let guard = 0; guard < 200; guard++) {
    const chat = store.getChat(chatId);
    const run = store.getWorkflowRun(chatId);
    if (!chat || !run || run.status !== "running") return;
    if (running.has(chatId)) return; // a turn is already running (e.g. resume) — the gate will report
    // A human is steering right now (skip/cancel) and is only waiting for the running turn to
    // end. They set the cursor themselves afterwards. Without this line the driver would keep
    // going in exactly this window — up to the END node, and the cancel would write its "end"
    // behind it (two end rows in one log).
    if (workflowIntent.has(chatId)) return;
    const g = workflowGraph(run);
    if (!g) { finishWorkflow(chatId, "failed", T("The workflow was deleted.")); return; }
    const { graph } = g;
    let cursor = run.cursor && "at" in run.cursor ? run.cursor : wf.initialCursor(graph, run.input);
    const node = wf.currentNode(graph, cursor);
    if (!node) { finishWorkflow(chatId, "done"); return; }
    if (run.step >= WORKFLOW_MAX_STEPS) {
      finishWorkflow(chatId, "failed", T`Reached the limit of ${WORKFLOW_MAX_STEPS} steps.`);
      return;
    }
    const vars = cursor.vars || {};
    const loop = wf.loopContext(graph, cursor);
    const counts = wf.countSteps(graph);
    // The title is rendered EVERYWHERE, not just in the prompt: run strip, step history and bell
    // would otherwise keep showing "{{element}}" while the prompt next to it named the element.
    const title = wf.renderText(node.title, { ...vars, item: loop?.item, answer: vars.answer }) || node.title || "";

    // Entries send no notification: the trigger already reports with the event, and a manual
    // start is visible in the open chat anyway.
    // Exactly ONCE per visit: after a start command the loop head runs a second time on the same
    // node, and the bell would ring twice (without bundling, so visible twice and pushed twice).
    if (node.type !== "start" && node.type !== "trigger" && !wf.commandDone(cursor, node.id)) {
      notifyNodeReached(chat, run, node);
    }
    if (node.type === "end") { finishWorkflow(chatId, "done"); return; }

    // Round cap: the same step may run in ONE run only as often as its number allows (otherwise
    // the default). When the cap is reached, the run halts and ASKS — exactly where a fix loop
    // ("review clean? → no → fix → review …") would otherwise keep spinning until quota or step
    // limit run out. The cap applies independently per loop iteration, so a body over 20
    // elements still runs 20 times (see wf.visitKey).
    const rounds = wf.visitCount(cursor, node.id);
    // Cap and choice apply per CYCLE (see wf.effectiveCap): without a value of its own the step
    // inherits the largest explicitly set cap of its loop including that one's choice —
    // otherwise the default 5 of an untouched neighbour would stop a loop deliberately set to
    // 20, and the "continue" would only work if the node with the choice happened to come first.
    // Without a choice in the cycle the workflow decides (`run.loopCapAuto`).
    const eff = wf.effectiveCap(graph, node, WORKFLOW_MAX_VISITS, g.workflow.run);
    const budget = eff.cap + wf.grantedVisits(cursor, node.id);
    if (rounds >= budget) {
      const more = eff.cap;
      const name = node.title || node.id;
      const giver = eff.from ? (eff.from.title || eff.from.id) : "";
      // "Continue without asking": the loop is LEFT (exit of the cycle, for "review clean?" the
      // yes path) and the run continues behind it. Without an exit it ends visibly — silently
      // spinning on is exactly what the cap is meant to prevent.
      if (eff.auto) {
        const exit = wf.cycleExit(graph, node.id);
        const exitNode = exit ? wf.nodeById(graph, exit) : null;
        const note = exitNode
          ? T`Cap reached after ${rounds} rounds — continuing without asking at “${exitNode.title || exitNode.id}”.`
          : T`Cap reached after ${rounds} rounds — this loop has no exit.`;
        logRunStep(run, "cap", { nodeId: node.id, nodeTitle: title, step: run.step, detail: { auto: true, rounds, cap: budget, note, exit: exitNode?.title || "", ...(giver ? { from: giver } : {}) } });
        workflowNote(chatId, { kind: "cap", step: run.step, title: node.title || "", rounds, cap: budget, auto: true, note });
        // NOT "done": the run never reached its end, and in list, history and counters it would
        // only be distinguishable from a regularly completed one by the note text.
        if (!exit) { finishWorkflow(chatId, "failed", note); return; }
        // The note must also reach the prompt of the node that continues working with it, not
        // only the log and the run row: the cap may forward to a review node whose text begins
        // with "the state is clean" while the last verdict was "not clean". `arrival` therefore
        // travels in the cursor and is rendered ONCE at the next turn (see wf.withoutArrival).
        const target = { ...wf.jumpTo(graph, cursor, exit), arrival: { kind: "cap", from: name, target: exitNode?.title || exitNode?.id || "", rounds, cap: budget, note } };
        store.updateWorkflowRun(chatId, { cursor: target, nodeId: node.id, nodeTitle: title, note });
        continue;
      }
      const question = T`Round cap reached: “${name}” has already run ${rounds} times in this run (allowed: ${budget}${giver ? T`, inherited from “${giver}”` : ""}).\n\n“continue” grants the whole loop ${more} more rounds (or e.g. “2 more” for exactly two), “finish” ends the run here.`;
      const held = wf.withPending(cursor, { kind: "cap", node: node.id, count: rounds, cap: budget });
      store.updateWorkflowRun(chatId, { status: "waiting", cursor: held, nodeId: node.id, nodeTitle: title, question });
      logRunStep(run, "cap", { nodeId: node.id, nodeTitle: title, step: run.step, detail: { question, rounds, cap: budget, ...(giver ? { from: giver } : {}) } });
      workflowNote(chatId, { kind: "cap", step: run.step, title: node.title || "", rounds, cap: budget, text: question });
      emitWorkflowRun(chatId, store.getWorkflowRun(chatId));
      return; // waits for the answer (see answerWorkflow)
    }
    // Compaction BETWEEN two steps. The post-run compaction (runs/post-run.js compactionDue)
    // skips every open workflow, because after the turn the completion gate still judges and the
    // driver starts the next turn directly. Here is the one place where a step is done and the
    // next has not begun yet.
    //   · only at a turn node (instruction, parallel, review) and ONCE per visit
    //     (wf.compactionChecked — the driver enters the same visit again after a command turn,
    //     after "continue" and after a restart);
    //   · not when the node itself begins with `/compact` or `/clear` (RAW version, like the
    //     start command below) — otherwise twice in a row;
    //   · check rounds of the same step run directly via doRun and never pass through here;
    //   · due by precedence: workflow value, otherwise chat, otherwise global (post-run.js);
    //   · executed like the start command `/compact`: a throw is not a failed workflow, at the
    //     limit the mark is set BEFORE parking, and after every `await` the run may no longer
    //     belong to this call (runStillOur).
    //   · NOT before the first step (`run.step > 0`): before it the driver would summarize the
    //     conversation in which the workflow was started.
    //   · If a compaction is already running (say that of the step a "skip" just left out), it
    //     is AWAITED — the step would otherwise start next to it, and its end would then throw
    //     the step's session away.
    //   · The mark is set before waiting: if another turn ends in this time, the gate recognizes
    //     by it that the job of this node has not gone out yet (gates.js, "never commissioned").
    if (COMPACTION_KINDS.has(node.type) && run.step > 0 && !wf.compactionChecked(cursor, node.id)) {
      cursor = wf.markCompaction(cursor, node.id);
      store.updateWorkflowRun(chatId, { cursor });
      if (compacting.has(chatId)) {
        while (compacting.has(chatId)) {
          compactionWaitCounter += 1;
          await new Promise((r) => setTimeout(r, 200));
          if (!runStillOur(chatId, run)) return;
        }
        continue;
      }
      if (!wf.isHarnessCommand(node.command) && compactionDue(chat)) {
        const startedAt = Date.now();
        const percent = autocompactPercent(chat);
        const stepValue = run.step + 1;
        // The run view shows the step that is being PREPARED — not the finished one. A "skip"
        // in this time hits exactly this node; the view must not announce the previous one.
        store.updateWorkflowRun(chatId, { nodeId: node.id, nodeTitle: title });
        emitWorkflowRun(chatId, store.getWorkflowRun(chatId));
        let result;
        try {
          result = await compactChatContext(chat, { auto: true, percent });
        } catch (e) {
          if (!runStillOur(chatId, run)) return;
          const error = e?.message || String(e);
          const row = logRunStep(run, "command", {
            nodeId: node.id, nodeTitle: title, step: stepValue,
            detail: { command: "/compact", native: true, auto: true, ok: false, error: error },
          });
          if (row) { try { store.finishRunStep(row, { durationMs: Math.max(1, Date.now() - startedAt) }); } catch {} }
          workflowNote(chatId, { kind: "command", title: node.title || "", command: "/compact", native: true, note: error });
          continue;
        }
        if (!runStillOur(chatId, run)) return;
        if (result?.limited) {
          // Parked, not failed: the continuation makes up for the compaction and then calls
          // this driver — the mark is already set, it continues directly.
          const rowL = logRunStep(run, "command", {
            nodeId: node.id, nodeTitle: title, step: stepValue,
            detail: { command: "/compact", native: true, auto: true, limited: true },
          });
          if (rowL) { try { store.finishRunStep(rowL, { durationMs: Math.max(1, Date.now() - startedAt) }); } catch {} }
          workflowNote(chatId, {
            kind: "command", title: node.title || "", command: "/compact", native: true,
            note: result.wait?.text || T("Usage limit reached — will be retried."),
          });
          return;
        }
        // `{ok:false, note}` means "nothing to do" (too little history — a run without input has
        // only ONE reply in the history before the second step —, or compaction is already
        // running). That is a result, not a failure: no row, no entry, the run continues.
        if (result?.ok === false) continue;
        const row = logRunStep(run, "command", {
          nodeId: node.id, nodeTitle: title, step: stepValue,
          detail: { command: "/compact", native: true, auto: true, ok: true, result },
        });
        if (row) { try { store.finishRunStep(row, { durationMs: Math.max(1, Date.now() - startedAt) }); } catch {} }
        // No history entry of its own: the compaction marker (`meta` with `compacted`, `auto`)
        // already stands as a separator in the chat.
        continue;
      }
    }
    // Optional start message of this node. `/clear` and `/compact` are harness commands and run
    // without an agent turn; any other input is persisted including placeholders like an
    // ordinary chat message and sent to the agent. Only when this prelude is done does the
    // actual node visit count — otherwise the return from the command turn would count the same
    // visit as a second round and repeat the command endlessly.
    const command = wf.renderText(node.command, { ...vars, item: loop?.item, answer: vars.answer }).trim();
    if (command && !wf.commandDone(cursor, node.id)) {
      const commandCursor = wf.beginCommand(cursor, node.id);
      store.updateWorkflowRun(chatId, { cursor: commandCursor, nodeId: node.id, nodeTitle: title, note: "" });
      // Whether the harness knows the command itself is decided by the RAW version — and only
      // when nothing follows it. With the rendered result "/clear please redo everything" would
      // silently drop its rest, "/compact-now" would run as a compaction, and a command
      // consisting only of "{{answer}}" would turn the user's answer into a harness command.
      // The step counter uses the same rule (wf.isHarnessCommand).
      const native = wf.isHarnessCommand(node.command) ? command.replace(/^\//, "").trim().toLowerCase() : "";
      // The number of the step this command INTRODUCES — but only if the node consumes one at
      // all. Start, trigger, condition and loop head may carry a start command and log under
      // `run.step` themselves; a `+1` would make the same node carry two different numbers.
      const commandStep = run.step + (wf.countsAsStep(node) ? 1 : 0);
      if (native) {
        const startedAt = Date.now();
        let result;
        try {
          result = native === "clear" ? clearChatContext(chat) : await compactChatContext(chat);
        } catch (e) {
          // During `compactChatContext` the chat is in `compacting`, NOT in `running` — but
          // `cancelWorkflow` checks `running.has` and therefore ends the run IMMEDIATELY, without
          // intent and without waiting. Minutes later this branch would return and write into
          // an ended (or the next) run. The same check as at the verdicts.
          if (!runStillOur(chatId, run)) return;
          // A failed start command is NOT a failed workflow. `/compact` is an optimization; its
          // timeout must not destroy the real work of the steps before by ending the whole run.
          // The failure is in the history, the run continues — and the agent does not learn of
          // it, because it did nothing wrong.
          const error = e?.message || String(e);
          cursor = wf.finishCommand(commandCursor, node.id);
          store.updateWorkflowRun(chatId, { cursor });
          const row = logRunStep(run, "command", {
            // The number of the step this command INTRODUCES — not that of its predecessor.
            // `run.step` itself deliberately stays (a harness command is not a paid turn and
            // must not count the visit early).
            nodeId: node.id, nodeTitle: title, step: commandStep,
            detail: { command, native: true, ok: false, error: error },
          });
          if (row) { try { store.finishRunStep(row, { durationMs: Math.max(1, Date.now() - startedAt) }); } catch {} }
          workflowNote(chatId, { kind: "command", title: node.title || "", command, native: true, note: error });
          continue;
        }
        // Compaction parked at the usage limit: the run has NOT failed, it waits. The command
        // counts as done — the continuation makes up for it and then calls this driver again
        // (see fireAutoContinueInner). Without this earmark it would run a second time there,
        // this time on an already compacted history.
        if (!runStillOur(chatId, run)) return; // see above — the success path would write blindly too
        if (result?.limited) {
          cursor = wf.finishCommand(commandCursor, node.id);
          store.updateWorkflowRun(chatId, { cursor });
          // NO `ok: false` — parked is not failed. The history view would otherwise read the
          // mark as a failure and show the step red permanently although it is made up for.
          const rowL = logRunStep(run, "command", {
            // see above: the number of the introduced step.
            nodeId: node.id, nodeTitle: title, step: commandStep,
            detail: { command, native: true, limited: true },
          });
          if (rowL) { try { store.finishRunStep(rowL, { durationMs: Math.max(1, Date.now() - startedAt) }); } catch {} }
          // As a "command" row (not as a kind of its own): the history view knows this kind and
          // shows the note with it. The wait itself is in the chat as a limit row anyway.
          workflowNote(chatId, {
            kind: "command", title: node.title || "", command, native: true,
            note: result.wait?.text || T("Usage limit reached — will be retried."),
          });
          return;
        }
        cursor = wf.finishCommand(commandCursor, node.id);
        store.updateWorkflowRun(chatId, { cursor });
        // `ok` comes from the result, not from hope: `compactChatContext` returns {ok:false,
        // note} for "too little history" or "already running".
        const succeeded = result?.ok !== false;
        const row = logRunStep(run, "command", {
          // see above: the number of the introduced step.
          nodeId: node.id, nodeTitle: title, step: commandStep,
          detail: { command, native: true, ok: succeeded, ...(succeeded ? { result } : { error: result?.note || "" }) },
        });
        // Duration on the ROW, not only in the detail: the history view shows `durationMs`.
        if (row) { try { store.finishRunStep(row, { durationMs: Math.max(1, Date.now() - startedAt) }); } catch {} }
        workflowNote(chatId, { kind: "command", title: node.title || "", command, native: true, ...(succeeded ? {} : { note: result?.note || "" }) });
        continue;
      }

      const step = run.step + 1;
      store.updateWorkflowRun(chatId, { step, cursor: commandCursor, nodeId: node.id, nodeTitle: title, question: "", note: "" });
      const commandRow = logRunStep(run, "command", {
        nodeId: node.id, nodeTitle: title, step,
        detail: { command, native: false },
      });
      runStepStart.set(chatId, { rowId: commandRow, at: Date.now(), kind: "command", runId: run.id });
      store.addMessage(chatId, "user", command);
      sse(chatId, { type: "harness", subtype: "user_message", text: command, attachments: [] });
      workflowNote(chatId, { kind: "command", step, title: node.title || "", command, native: false });
      emitWorkflowRun(chatId, store.getWorkflowRun(chatId));
      // A leading "/skillname" is resolved as at the chat route (resolveSkillSlash): the history
      // keeps showing the typed line (`command`), the model reads the job to load the skill. Raw,
      // "/name" would go to the CLI — "Unknown command", and the whole message would be swallowed.
      // The RENDERED line is resolved — unlike the harness command above, which checks the raw
      // version: a command made of placeholders is a message here like any at the chat route,
      // and that one resolves "/receipt" too when it came from "{{answer}}". Whoever wants the
      // raw version here as well checks `/^\//.test(String(node.command || "").trim())` first.
      const prompt = resolveSkillSlash(chat, command) || command;
      // The next step of a running graph workflow belongs to its run — the project-layout lock lets it through while
      // waiting if the run began before the job (`parentSince`).
      doRun(chat, withEarmarked(chat, prompt), { parentSince: Number(run.startedAt) || null })
        .catch((e) => console.error("[workflow] node command failed:", e?.message || e));
      return;
    }

    cursor = wf.countVisit(cursor, node.id);

    // Entries cost no turn themselves. Their command (if set) has been fully executed at this
    // point; only now do we move on to the first working node.
    if (node.type === "start" || node.type === "trigger") {
      store.updateWorkflowRun(chatId, { cursor: wf.advance(graph, cursor) });
      continue;
    }

    if (node.type === "condition") {
      // A condition without text is not a condition: the model would judge nothing and the run
      // would branch on a coin toss. The editor reports that as an error anyway.
      if (!wf.renderText(node.text, { ...vars, item: loop?.item }).trim()) {
        finishWorkflow(chatId, "failed", T`Condition “${node.title || node.id}” has no text — there is nothing to decide.`);
        return;
      }
      const t0 = Date.now();
      // A condition reached via a cap decides the further path based on a state that did not
      // come about cleanly — it MUST know that. And it consumes the mark, otherwise it would
      // appear once more one node later.
      const arrivalHere = cursor?.arrival || null;
      if (arrivalHere) cursor = wf.withoutArrival(cursor);
      const verdict = await judgeWorkflowCondition(chat, node, lastOutput, vars, loop, arrivalHere, { overruled });
      const base = { nodeId: node.id, nodeTitle: title, step: run.step };
      // Seconds lie between question and answer. If the human skipped, cancelled or stopped in
      // that time, the cursor no longer belongs to this call — then write NOTHING more
      // (otherwise the verdict overwrites the step that has long been running).
      if (!runStillOur(chatId, run)) return;
      // At the usage limit we do not guess but wait: the cursor stays unsaved on this node, the
      // continuation judges THE SAME output after the reset.
      if (verdict.limited && await parkJudge(chat, verdict.error, { at: "workflow", lastOutput })) {
        logRunStep(run, "decision", { ...base, detail: { limited: true, prompt: verdict.prompt, ms: Date.now() - t0 } });
        return;
      }
      // At the limit but not parked: the same reason as at the four other verdict sites — not
      // "could not be decided", because deciding was not even attempted.
      if (verdict.limited) {
        logRunStep(run, "decision", { ...base, detail: { failed: true, limited: true, prompt: verdict.prompt, tries: verdict.tries, ms: Date.now() - t0 } });
        finishWorkflow(chatId, "failed", limitEndNote());
        return;
      }
      // Unreadable OR "unclear": the same path, only "unclear" carries its reason into log and end note.
      if (verdict.failed) {
        logRunStep(run, "decision", { ...base, detail: { failed: true, ...(verdict.unclear ? { unclear: verdict.unclear } : {}), prompt: verdict.prompt, tries: verdict.tries, ms: Date.now() - t0 } });
        finishWorkflow(chatId, "failed", verdict.unclear
          ? T`Could not decide the condition — the judge only sees the previous step's output and called it unclear: ${verdict.unclear}`
          : T("Could not decide the condition."));
        return;
      }
      const rowId = logRunStep(run, "decision", { ...base, detail: { yes: verdict.yes, note: verdict.note, prompt: verdict.prompt, tries: verdict.tries } });
      store.finishRunStep(rowId, { durationMs: Date.now() - t0 });
      const next = wf.advance(graph, cursor, verdict.yes ? "true" : "false");
      store.updateWorkflowRun(chatId, { cursor: next, nodeId: node.id, nodeTitle: title, note: verdict.note });
      workflowNote(chatId, { kind: "decision", title: node.title || "", yes: verdict.yes, note: verdict.note });
      continue;
    }

    if (node.type === "loop") {
      const t0 = Date.now();
      const base = { nodeId: node.id, nodeTitle: title, step: run.step };
      let items = node.items?.length ? node.items : null;
      if (!items) {
        const produced = await produceWorkflowList(chat, node, lastOutput, vars, { overruled });
        if (!runStillOur(chatId, run)) return;
        if (produced.limited && await parkJudge(chat, produced.error, { at: "workflow", lastOutput })) {
          logRunStep(run, "loop", { ...base, detail: { limited: true, prompt: produced.prompt, ms: Date.now() - t0 } });
          return;
        }
        if (produced.limited) {
          logRunStep(run, "loop", { ...base, detail: { failed: true, limited: true, prompt: produced.prompt, tries: produced.tries, ms: Date.now() - t0 } });
          finishWorkflow(chatId, "failed", limitEndNote());
          return;
        }
        if (produced.failed) {
          logRunStep(run, "loop", { ...base, detail: { failed: true, ...(produced.unclear ? { unclear: produced.unclear } : {}), prompt: produced.prompt, tries: produced.tries, ms: Date.now() - t0 } });
          finishWorkflow(chatId, "failed", produced.unclear
            ? T`Could not build the loop's list — the judge only sees the previous step's output and called it unclear: ${produced.unclear}`
            : T("Could not build the loop's list."));
          return;
        }
        items = produced.items;
        const rowId = logRunStep(run, "loop", { ...base, detail: { ...loopLog(node, items), prompt: produced.prompt, tries: produced.tries } });
        store.finishRunStep(rowId, { durationMs: Math.max(1, Date.now() - t0) });
      } else {
        logRunStep(run, "loop", { ...base, detail: { ...loopLog(node, items), fixed: true } });
      }
      const next = wf.enterLoop(graph, cursor, items);
      const isRunning = next.frames.length > cursor.frames.length ? next.frames[next.frames.length - 1].items.length : 0;
      const dropped = Math.max(0, items.filter((x) => String(x || "").trim()).length - isRunning);
      store.updateWorkflowRun(chatId, { cursor: next, nodeId: node.id, nodeTitle: title });
      // A list that truncates silently cannot be told from a complete one — the number of
      // DROPPED elements belongs on the same row as that of the running ones.
      workflowNote(chatId, { kind: "loop", title: node.title || "", count: isRunning, ...(dropped ? { dropped } : {}) });
      continue;
    }

    if (node.type === "ask") {
      const question = wf.renderText(node.text, { ...vars, item: loop?.item }).trim() || node.title || T("How should we continue?");
      const step = run.step + 1;
      store.updateWorkflowRun(chatId, { status: "waiting", step, cursor, nodeId: node.id, nodeTitle: title, question });
      logRunStep(run, "ask", { nodeId: node.id, nodeTitle: title, step, detail: { question } });
      workflowNote(chatId, { kind: "ask", step, total: counts.total, approx: counts.approx, title: node.title || "", text: question });
      emitWorkflowRun(chatId, store.getWorkflowRun(chatId));
      return; // waits for the next user message (see answerWorkflow)
    }

    // instruction | parallel | review → one turn of the agent
    const step = run.step + 1;
    // Render ONCE: the mark is saved along under `cursor` right away, hence read here.
    const arrival = cursor?.arrival || null;
    let prompt;
    if (node.type === "parallel") {
      const { branches } = wf.parallelBranches(graph, node.id);
      // `answer: vars.answer` is MANDATORY since parallelPrompt knows the parameter: an
      // explicitly passed `answer: undefined` overwrites the value from the spread
      // (`{ ...vars, answer }`) when the prompt is built, and `{{answer}}` then renders EMPTY.
      prompt = wf.parallelPrompt({ workflowName: run.workflowName, node, step, total: counts.total, approx: counts.approx, branches, vars, loop, answer: vars.answer, arrival });
    } else if (node.type === "review") {
      // Phase 1 of a review node: the agent writes the request including test instructions. The
      // wait only begins AFTER the turn (see workflowGateAfterRun) — its result IS the request.
      prompt = wf.reviewPrompt({
        workflowName: run.workflowName, node, step, total: counts.total, approx: counts.approx, vars, loop,
        round: wf.visitCount(cursor, node.id) || 1, lastIssues: vars.reviewLast || "", arrival,
      });
    } else {
      prompt = wf.instructionPrompt({ workflowName: run.workflowName, node, step, total: counts.total, approx: counts.approx, vars, loop, answer: vars.answer, arrival });
    }
    // The arrival is in the prompt now — it must not reach the next step a second time,
    // otherwise it would be in every turn until the end of the run.
    cursor = wf.withoutArrival(cursor);
    // What is earmarked for the graph run belongs to the job — BEFORE the log, so the history shows what the agent was
    // sent off with.
    prompt = withEarmarked(chat, prompt);
    store.updateWorkflowRun(chatId, { step, cursor, nodeId: node.id, nodeTitle: title, question: "", note: "" });
    // The prompt is logged BEFORE the turn: if the backend crashes mid-step, the history still
    // says what the agent was sent off with (the active_runs row is gone afterwards).
    const stepRow = logRunStep(run, "step", {
      nodeId: node.id, nodeTitle: title, step,
      detail: { type: node.type, prompt, total: counts.total, approx: counts.approx, ...(loop ? { item: loop.item, index: loop.index, itemTotal: loop.total } : {}) },
    });
    runStepStart.set(chatId, { rowId: stepRow, at: Date.now(), runId: run.id });
    workflowNote(chatId, { kind: "step", step, total: counts.total, approx: counts.approx, title: node.title || "", type: node.type, ...(loop ? { loop: { index: loop.index, total: loop.total, item: loop.item } } : {}) });
    emitWorkflowRun(chatId, store.getWorkflowRun(chatId));
    // `parentSince` as above at the node command.
    doRun(chat, prompt, { parentSince: Number(run.startedAt) || null })
      .catch((e) => console.error("[workflow] step failed:", e?.message || e));
    return;
  }
  finishWorkflow(chatId, "failed", T("The workflow is going in circles."));
}

// Two hooks of the limit side (registered in server.js).
// afterLimitCancel/"workflow-end": the wait row has been discarded, and a workflow that hung on it has failed (a
// "running" workflow without a driver only holds its lock).
// Error path: if finishWorkflow throws synchronously, the hook frame logs it
// (`[hooks] afterLimitCancel/workflow-end: …`), cancelAutoContinue runs to its end, and the workflow run stays
// "running" — a zombie that only holds its lock. Whoever does not want that catches HERE and ends the run themselves.
function workflowDismissedHook({ chat, row, note }) {
  if (!row.workflow || store.getWorkflowRun(chat.id)?.status !== "running") return;
  finishWorkflow(chat.id, "failed", note || limitEndNote());
}
// afterCompactResume/"workflow-continue": the parked compaction has been made up for; if a workflow hung on it
// (command node `/compact`), it continues — the driver noted the command as done when parking and jumps straight to
// the node. Fire and forget with the same console line.
function workflowContinueHook({ chat }) {
  if (store.getWorkflowRun(chat.id)?.status !== "running") return;
  driveWorkflow(chat.id).catch((e) => console.error("[limit] Workflow", chat.id, "failed:", e?.message || e));
}

export { beginWorkflow, doneJudgeModel, driveWorkflow, finishWorkflow, jsonObject, judgeNodeDone, runningVerdicts, limitEndNote, verdictOneshot, compactionWaitRounds, workflowDismissedHook, workflowContinueHook };
