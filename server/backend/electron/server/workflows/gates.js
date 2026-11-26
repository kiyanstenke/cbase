// The gates at the step: workflowGateAfterRun, workflowRunFailed, holdWorkflow, round cap (judgeCapAnswer, answerCap),
// review (requestHumanReview, the item "request review" in the agenda, judgeReviewAnswer, answerReview),
// answerWorkflow, workflowAction, serialPerChat, skip and cancel; hook consumers of the restart: workflowLocksHook,
// workflowRunsHook, workflowAbandonedHook.

import * as wf from "../workflows.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { recordNotice, resolveNotices } from "../services.js";
import { WORKFLOW_MAX_STEPS, WORKFLOW_MAX_VISITS, closeRunStep, emitWorkflowRun, firstLines, runStillOur, lastOutput as lastOutputValue, logRunStep, nextGeneration, workflowGraph, workflowIntent, workflowNote } from "./run-state.js";
import { cancelAutoContinue, emitAutoContinue, isLimitError, clearAwayJudgeRow, limitLine, parkJudge, drainQueue, verdictOutdated } from "../runs/auto-continue.js";
import { clearAutoContinueTimer } from "../runs/limit-gate.js";
import { dismissAsk, openAskOf } from "../runs/ask.js";
import { doRun } from "../runs/do-run.js";
import { doneJudgeModel, driveWorkflow, finishWorkflow, jsonObject, judgeNodeDone, limitEndNote, verdictOneshot } from "./driver.js";
import { running, stopRun, waitForRunEnd, workflowDecidesOn, workflowDecidesOff } from "../runs/state.js";
import { changeAgenda } from "../agenda/change.js";
import { AgendaError } from "../agenda/operations.js";
import { openCard } from "../dynworkflows/approval.js";
// Every turn a gate starts carries what is earmarked for the graph run (withEarmarked); the "follow-up run" switch
// never turns a message into an answer (messageFromQueue).
import { withEarmarked, messageFromQueue, putBackMessage } from "./graph-message.js";


// ONE gate per run state at a time. The entry check in `gateAfterRunWithoutClaim`
// (`run.status !== "running"`) is synchronous, the completion verdict behind it takes seconds,
// and `runStillOur` only applies AFTER the verdict — two callers side by side would both get
// through and pay for two verdicts on the same step, with an identical prompt. The claim belongs
// BEFORE the work, not behind it: whoever checks after the verdict has already paid for it.
//
// The claim carries the STATE of the holder (the same fields as parkJudge and runStillOur) — not
// just the chat. A second caller only goes away empty-handed while the holder still OWNS the run.
// If the run was cancelled and restarted during the verdict, stopped and continued (gen+1) or
// skipped (cursor moved on), and then a NEW turn ends, the holder is orphaned: it will write
// nothing more at its own runStillOur check, and the second one takes over. With a claim per
// chat only, the successor run would stay "running" without gate, without driver, with an open
// step row. Released in the finally, whether the gate runs through, parks or throws — and only
// the OWN claim (marker), otherwise an orphaned holder would clear away the successor when it
// returns. Guard: workflow-gate-claim.test.js.
const gateClaims = new Map(); // chatId -> { marker, stand }
const gateState = (run) => (run ? { id: run.id, status: run.status, step: run.step, cursor: { at: run.cursor?.at || "", gen: run.cursor?.gen || 0 } } : null);
// Is a gate currently holding this run? (The "gate" switch asks this too — see verdictSwitch.)
function gateRunning(chatId) {
  const holder = gateClaims.get(chatId);
  return Boolean(holder?.state && runStillOur(chatId, holder.state));
}
// While the gate decides, the chat is BUSY although no turn is running (runs/state.js workflowDecides) — set
// synchronously, still inside doRun (afterRun), so that neither its end of work nor a message in the verdict window
// starts a turn the gate would afterwards take as the result of the NEXT step. At the end of the last decision
// whatever has accumulated drains (usually nothing: the next step is already running then and takes the queue at its
// `result`).
async function workflowGateAfterRun(chat, lastOutput, opts = {}) {
  workflowDecidesOn(chat.id);
  try { return await gateWithClaim(chat, lastOutput, opts); }
  finally {
    if (workflowDecidesOff(chat.id)) {
      try { drainQueue(chat.id); } catch (e) { console.error("[workflow] queue after the gate:", chat.id, e?.message || e); }
    }
  }
}
async function gateWithClaim(chat, lastOutput, opts = {}) {
  const id = chat.id;
  if (gateRunning(id)) {
    console.error("[workflow] gate already running for", id, "— the second call is dropped");
    return;
  }
  const marker = Symbol("gate");
  gateClaims.set(id, { marker, state: gateState(store.getWorkflowRun(id)) });
  try {
    return await gateAfterRunWithoutClaim(chat, lastOutput, opts);
  } finally {
    if (gateClaims.get(id)?.marker === marker) gateClaims.delete(id);
  }
}
// After a SUCCESSFUL turn: move behind the finished node and continue.
async function gateAfterRunWithoutClaim(chat, lastOutput, { overruled = false } = {}) {
  // Set when the completion gate did "continue without asking" (see `gateArrival`).
  let arrivalFromGate = null;
  const run = store.getWorkflowRun(chat.id);
  if (!run || run.status !== "running") return;
  // The same window as in driveWorkflow: if the turn ends WHILE a skip or cancel is waiting for
  // it, the decision belongs to the human. Otherwise the turn would count as the result of the
  // step, the run would advance — and the click being waited for would hit another step or
  // write a second end.
  if (workflowIntent.has(chat.id)) return;
  // Duration and result belong on the step that just ran — and ONLY on that of this run.
  closeRunStep(run, { output: lastOutput, ok: true });
  const g = workflowGraph(run);
  if (!g) { finishWorkflow(chat.id, "failed", T("The workflow was deleted.")); return; }
  const { graph } = g;
  // `let`: the completion gate below deletes its round counter from the cursor before advancing.
  let cursor = run.cursor && "at" in run.cursor ? run.cursor : wf.initialCursor(graph, run.input);
  const node = wf.currentNode(graph, cursor);
  // The title is rendered in history and strip, not as a raw placeholder — as in the driver.
  // The declaration sits NEXT TO `node`, not in a block further down: `nodeTitle: title` occurs
  // in four places in this function, and three of them lie outside any if.
  const title = wf.renderText(node?.title, {
    ...(cursor.vars || {}), item: wf.loopContext(graph, cursor)?.item, answer: cursor.vars?.answer,
  }) || node?.title || "";
  // A skill may ask via cbase_ask within an ordinary workflow step. The tool call is
  // deliberately non-blocking; without this gate the workflow would jump to the next node after
  // the turn anyway and, say, skip grill-with-docs after question one. We therefore hold THE
  // SAME node. The answer continues the existing agent session; only a turn without an open
  // question completes the step. Because a card in the run also survives an interim question
  // by the user (see openAskOf), the same hold may land here several times — the log row must
  // not repeat then.
  const agentAsk = openAskOf(chat.id);
  if (agentAsk && node) {
    const question = agentAsk.questions
      .map((q) => String(q?.question || "").trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 6000);
    const held = wf.withPending(cursor, { kind: "agent_ask", node: node.id, requestId: agentAsk.requestId });
    store.updateWorkflowRun(chat.id, {
      status: "waiting", cursor: held, nodeId: node.id, nodeTitle: title, question,
    });
    const logged = store.listRunSteps(run.id)
      .filter((s) => s.kind === "ask")
      .some((s) => String(s.detail?.requestId || "") === agentAsk.requestId);
    if (!logged) {
      logRunStep(run, "ask", {
        nodeId: node.id, nodeTitle: title, step: run.step,
        detail: { question, requestId: agentAsk.requestId, agent: true },
      });
    }
    emitWorkflowRun(chat.id, store.getWorkflowRun(chat.id));
    return;
  }
  // The approval card of a dynamic workflow (dynworkflows/approval.js): the step wanted to orchestrate and had no
  // opt-in (no ultracode in the run, no keyword in the node text). It holds on it LIKE on an open question — no
  // advancing, no verdict, the channel hold applies via "waiting" — until the human decides (dynApprovalDecided). The
  // card has its OWN role; openAskOf above does not see it. The notification goes out HERE, not at the card: in an
  // ordinary chat the human sees the card in the running conversation — a triggered graph run would otherwise wait mutely.
  const dynCard = openCard(chat.id);
  if (dynCard && node) {
    const question = T`Approval: dynamic workflow "${dynCard.name}"`;
    const held = wf.withPending(cursor, { kind: "dyn_approval", node: node.id, requestId: dynCard.requestId });
    store.updateWorkflowRun(chat.id, { status: "waiting", cursor: held, nodeId: node.id, nodeTitle: title, question });
    const logged = store.listRunSteps(run.id)
      .some((s) => s.kind === "ask" && String(s.detail?.requestId || "") === dynCard.requestId);
    if (!logged) {
      logRunStep(run, "ask", { nodeId: node.id, nodeTitle: title, step: run.step, detail: { question, requestId: dynCard.requestId, dynApproval: true } });
      // Kind "question" (push on by default): the run stands still until a human answers — the same statement as the
      // question card (runs/ask.js). Settled via resolveNotices with the requestId once decided.
      recordNotice({
        kind: "question",
        title: T`Approval: ${chat.title || run.workflowName || "cbase"}`,
        chatTitle: chat.title || "",
        body: [question, run.workflowName].filter(Boolean).join(" · "),
        chatId: chat.id, workspaceId: chat.workspaceId || null, projectId: chat.projectId || null,
        requestId: dynCard.requestId,
      });
    }
    emitWorkflowRun(chat.id, store.getWorkflowRun(chat.id));
    return;
  }
  // This turn was only the freely entered start message of the node. The node itself stays at
  // the cursor and is only executed now. The separate completion flag is persistent, so that an
  // interposed cbase_ask answer also lands here again.
  if (node && cursor.commandPending?.node === node.id) {
    const next = wf.finishCommand(cursor, node.id);
    store.updateWorkflowRun(chat.id, { cursor: next });
    await driveWorkflow(chat.id, lastOutput);
    return;
  }
  // This turn was never the node's job: the driver has already marked the node for the compaction
  // between two steps but not yet counted its visit (wf.compactionChecked — after countVisit the
  // mark is caught up). This is how a queued message ends that started as a turn of its own while
  // the driver was still waiting; it returned at `running.has`. Counting it as the result of the
  // node — whose job never went out — would end the run "done" without it. Now the driver
  // continues where it stood: the mark is set, no second compaction.
  // The branch remains for the turn that arrives while the compaction is PARKED at the limit (the driver is back, the
  // mark is set, a message starts immediately).
  if (node && wf.compactionChecked(cursor, node.id)) {
    await driveWorkflow(chat.id, lastOutput);
    return;
  }
  // Completion gate ("check completion" at the step): if the node does not check effectively,
  // "turn ended = node done" applies. Otherwise a model judges the last output; "not done" gives
  // THE SAME step a continuation turn instead of advancing. The run settings decide this
  // together with the node: "check all working steps" (`run.doneAll`, default ON) and the
  // three-valued `doneMode` on the node (wf.wantsDoneCheck). If the node still is not done after
  // `run.doneRounds` rounds, the CHECK cap (`doneCapMode` on the node, otherwise
  // `run.doneCapAuto` — wf.doneCapAuto) decides whether the run halts here and asks or
  // continues by itself — a switch separate from the round cap's.
  // Only the OWN node is read — "done" is a question to this step, not to the loop (the
  // inheritance within the cycle, effectiveCap, applies only to the round cap).
  const runRule = g.workflow.run;
  const checkRounds = wf.normalizeRunSettings(runRule).doneRounds;
  if (node && wf.wantsDoneCheck(node, runRule) && !workflowIntent.has(chat.id)) {
    const vars = cursor.vars || {};
    const loop = wf.loopContext(graph, cursor);
    const t0 = Date.now();
    const rounds = wf.doneRounds(cursor, node.id);
    const base = { nodeId: node.id, nodeTitle: title, step: run.step };
    const verdict = await judgeNodeDone(chat, node, lastOutput, vars, loop, doneJudgeModel(g.workflow.run), { overruled });
    // After the verdict the run may be a different one: a `cancel` during the verdict ends it,
    // and the "not done" branch below would then start another paid agent turn unchecked on a
    // cancelled run.
    if (!runStillOur(chat.id, run)) return;
    // At the usage limit we do not guess: the cursor stays put, after the reset the continuation
    // judges THE SAME output (`at: "gate"` — see resumeJudge; "workflow" would mean: execute the
    // node once more).
    if (verdict.limited && await parkJudge(chat, verdict.error, { at: "gate", lastOutput })) {
      logRunStep(run, "gate", { ...base, detail: { limited: true, prompt: verdict.prompt, ms: Date.now() - t0 } });
      return;
    }
    // Limit but not parkable (auto-continue off, attempt cap, credits/reset too far away, or a
    // run row takes precedence): end HONESTLY instead of branching wrongly — like condition and
    // loop list. Falling into "not done" with `note === undefined` (a limited verdict carries no
    // note) would make updateWorkflowRun throw an SQLite bind error: the run would stay "running"
    // without driver, wait row or closure and hold its lock. If parking has already ended the
    // run ("gave-up" → cancelAutoContinue), finishWorkflow is a no-op here.
    if (verdict.limited) {
      logRunStep(run, "gate", { ...base, detail: { failed: true, limited: true, prompt: verdict.prompt, tries: verdict.tries, model: verdict.model, ms: Date.now() - t0 } });
      finishWorkflow(chat.id, "failed", limitEndNote());
      return;
    }
    if (!verdict.done) {
      const note = verdict.failed
        ? T("No usable verdict — treating the step as unfinished.")
        : verdict.note;
      const nextRound = rounds + 1;
      const done = nextRound >= checkRounds;
      // At the cap the check cap decides (see comment above). It is already in the log row so
      // the history explains the jump and does not just show "3/3".
      const auto = wf.doneCapAuto(node, runRule);
      // Whoever does "continue without asking" after `checkRounds` sends a step that is NOT
      // completed to the next node — which would otherwise get the same prompt as after a
      // cleanly passed gate. Hence the arrival travels along.
      const gateArrival = () => ({ kind: "done", from: node.title || node.id, target: "", rounds: nextRound, cap: checkRounds, note });
      const rowId = logRunStep(run, "gate", {
        ...base,
        detail: {
          done: false, note, round: nextRound, max: checkRounds,
          ...(done && auto ? { auto: true } : {}),
          prompt: verdict.prompt, tries: verdict.tries, model: verdict.model, ...(verdict.failed ? { failed: true } : {}),
        },
      });
      store.finishRunStep(rowId, { durationMs: Date.now() - t0 });
      if (!done) {
        // Let it keep working: the same agent session, the same cursor, only the counter rises.
        store.updateWorkflowRun(chat.id, { cursor: wf.withDoneRound(cursor, node.id, nextRound), note });
        workflowNote(chat.id, { kind: "gate", title: node.title || "", done: false, note, round: nextRound, max: checkRounds });
        emitWorkflowRun(chat.id, store.getWorkflowRun(chat.id));
        const again = [
          `[Completion gate · round ${nextRound}/${checkRounds}] This step does NOT count as done yet.`,
          note ? `Missing: ${note}` : "",
          "Finish the step — not an announcement, but the work itself. Only end your turn when you are done.",
        ].filter(Boolean).join("\n");
        doRun(chat, withEarmarked(chat, again))
          .catch((e) => console.error("[workflow] completion gate: continuation failed:", e?.message || e));
        return;
      }
      if (!auto) {
        const question = T`“${node.title || node.id}” is still not finished after ${nextRound} rounds${note ? ` (${note})` : ""}.\n\n“continue” moves on to the next step; anything else goes back into this step as an instruction.`;
        const held = wf.withPending(cursor, { kind: "done", node: node.id, count: nextRound });
        store.updateWorkflowRun(chat.id, { status: "waiting", cursor: held, nodeId: node.id, nodeTitle: title, question });
        workflowNote(chat.id, { kind: "gate", title: node.title || "", done: false, note, round: nextRound, max: checkRounds, text: question });
        emitWorkflowRun(chat.id, store.getWorkflowRun(chat.id));
        return; // waits for the answer (see answerWorkflow)
      }
      // Continue without asking: the reason belongs on the run (strip, run list) — otherwise the
      // justification of the last rework would remain there as if the step were still waiting for it.
      const autoNote = T`Not confirmed after ${nextRound} rounds — continuing without asking.`;
      workflowNote(chat.id, {
        kind: "gate", title: node.title || "", done: false, auto: true,
        round: nextRound, max: checkRounds, note: autoNote,
      });
      store.updateWorkflowRun(chat.id, { note: autoNote });
      // …and on the FOLLOWING NODE, not only on the run row: the reason for the premise it is
      // about to work under would otherwise be nowhere in its prompt (see wf arrival sentence).
      arrivalFromGate = { ...gateArrival(), note: autoNote };
    } else {
      const rowId = logRunStep(run, "gate", { ...base, detail: { done: true, note: verdict.note, prompt: verdict.prompt, tries: verdict.tries, model: verdict.model } });
      store.finishRunStep(rowId, { durationMs: Date.now() - t0 });
      workflowNote(chat.id, { kind: "gate", title: node.title || "", done: true, note: verdict.note });
      // The justification of an earlier round ("missing …") no longer belongs on the run: it
      // would otherwise stay in the strip and in the run list until the next write.
      if (run.note) store.updateWorkflowRun(chat.id, { note: "" });
    }
    // Done (or check cap with "continue"): delete the counter so a second loop round has its
    // full budget again — and then continue on the ordinary path.
    cursor = wf.clearDoneRound(cursor, node.id);
  }
  // Review: the turn only produced the REQUEST — the run does NOT advance now but waits for the
  // human. What the agent wrote is the request.
  if (node?.type === "review") { requestHumanReview(chat, run, graph, cursor, node, lastOutput); return; }
  // Parallel: after the turn we continue at the join point, not at one of the branches. If the
  // branches do NOT join, the run would jump to "nothing" and report "done" — the join, the
  // condition behind it and the end node would never run, and nobody would see it.
  if (node?.type === "parallel") {
    const open = wf.parallelJoinProblem(graph, node.id);
    if (open) {
      const openNode = wf.nodeById(graph, open);
      finishWorkflow(chat.id, "failed", T`The branches of “${node.title || node.id}” do not merge (open at “${openNode?.title || open}”) — the rest of the workflow would have been skipped.`);
      return;
    }
  }
  let next = node?.type === "parallel"
    ? wf.jumpTo(graph, cursor, wf.parallelBranches(graph, node.id).join)
    : wf.advance(graph, cursor);
  // The answer to a question applies only to the immediately following step.
  if (next.vars?.answer) next.vars = { ...next.vars, answer: "" };
  if (arrivalFromGate) next = { ...next, arrival: arrivalFromGate };
  store.updateWorkflowRun(chat.id, { cursor: next });
  await driveWorkflow(chat.id, lastOutput, { overruled });
}
// After a FAILED or aborted turn.
// `aborted` comes from the caller: `abortedRuns` has already been cleared at this point (doRun
// takes the mark out at the very top), so asking it here would ALWAYS be wrong.
function workflowRunFailed(chat, code, { aborted = false } = {}) {
  const run = store.getWorkflowRun(chat.id);
  if (!run || run.status !== "running") return;
  if (workflowIntent.has(chat.id)) return; // skip/cancel steers on by itself
  // The step that just ran gets its error — otherwise the history would only show a step
  // without an end and next to it "failed", without connection.
  closeRunStep(run, { ok: false, error: aborted ? "stopped" : `Exit-Code ${code}` });
  // A step STOPPED by the human does not end the run — it halts it. Left on "running" without
  // anybody driving it, the next arbitrary user message would run into the gate and count as
  // the result of this step.
  if (aborted) { holdWorkflow(chat, run); return; }
  finishWorkflow(chat.id, "failed", T`Step failed (code ${code}).`);
}

// The run halts visibly instead of standing dead on "running". It waits as at any other
// question — "continue" executes the step again, anything else is a job for the same step,
// "cancel" ends it.
function holdWorkflow(chat, run) {
  const g = workflowGraph(run);
  const cursor = run.cursor && "at" in run.cursor ? run.cursor : (g ? wf.initialCursor(g.graph, run.input) : null);
  const node = g && cursor ? wf.currentNode(g.graph, cursor) : null;
  const name = node ? (node.title || node.id) : (run.nodeTitle || "");
  const question = T`The step${name ? T` “${name}”` : ""} was stopped.\n\n“continue” runs it again; anything else goes into the same step as an instruction. “Cancel” ends the run.`;
  const held = nextGeneration(wf.withPending(cursor || {}, { kind: "stopped", node: node?.id || run.nodeId || "" }));
  store.updateWorkflowRun(chat.id, { status: "waiting", cursor: held, nodeId: node?.id || run.nodeId || "", nodeTitle: name, question, note: T("Stopped by the user.") });
  logRunStep(run, "ask", { nodeId: node?.id || "", nodeTitle: name, step: run.step, detail: { question, stopped: true } });
  workflowNote(chat.id, { kind: "ask", step: run.step, title: name, text: question });
  emitWorkflowRun(chat.id, store.getWorkflowRun(chat.id));
}

// Interpretation of an answer to the round cap when it is not unambiguous. Two attempts, after
// that "finish" applies — the cap is a brake, when in doubt it brakes (instead of burning more
// quota).
async function judgeCapAnswer(chat, node, count, question, answer, { overruled = false } = {}) {
  const prompt = wf.capAnswerPrompt({ node, count, question, answer });
  for (let attempt = 0; attempt < 2; attempt++) {
    let out = "";
    try {
      out = await verdictOneshot(chat, prompt, "", { overruled });
      const obj = jsonObject(out) || {};
      if (typeof obj.continue === "boolean") {
        const rounds = Number(obj.rounds);
        return { go: obj.continue, rounds: Number.isFinite(rounds) && rounds > 0 ? Math.round(rounds) : 0, note: String(obj.note || "").slice(0, 140) };
      }
    } catch (e) {
      // At the limit "when in doubt brake" does NOT apply: the cap brakes when the answer is
      // unclear — here it is unread. The run waits instead and interprets it after the reset.
      if (isLimitError(e)) return { limited: true, error: e };
      /* second attempt; after that the cap brakes */
    }
  }
  return { failed: true, go: false, rounds: 0, note: "" };
}

// Answer to the round cap: continue (with how many rounds?) or stop here.
// `logged` = the answer row is already in the history (re-entry after a verdict parked at the
// limit) — otherwise the same answer would be in it twice.
async function answerCap(chat, run, graph, pending, text, { logged = false, overruled = false } = {}) {
  const node = wf.nodeById(graph, pending.node);
  const answer = String(text || "").slice(0, 4000);
  if (!logged) logRunStep(run, "answer", { nodeId: pending.node, nodeTitle: run.nodeTitle, step: run.step, detail: { question: run.question, answer: answer.slice(0, 2000), cap: true } });
  if (!node) { finishWorkflow(chat.id, "failed", T("That step is no longer in the graph.")); return true; }
  let intent = wf.capIntent(answer);
  // Without a number the effective cap of the cycle counts as the portion — not the raw node number.
  let rounds = wf.capRounds(answer, wf.effectiveCap(graph, node, WORKFLOW_MAX_VISITS).cap);
  let why = "";
  if (intent === "unclear") {
    const verdict = await judgeCapAnswer(chat, node, pending.count, run.question, answer, { overruled });
    // If someone answered, skipped or cancelled in the meantime, the decision no longer belongs
    // to this call.
    if (!runStillOur(chat.id, run)) return true;
    // Parked: the run stays "waiting" with the same open question — the continuation interprets
    // the answer after the reset. Nothing is branched, nothing discarded.
    if (verdict.limited && await parkJudge(chat, verdict.error, { at: "cap", answer })) return true;
    // Limit but not parkable: end honestly instead of branching wrongly (like condition and
    // loop list). The UNREAD answer must not count as "stop" with the reason "answer not
    // interpretable" — an interpretation that never took place. "gave-up" may already have
    // ended the run; then this is a no-op.
    if (verdict.limited) {
      finishWorkflow(chat.id, "failed", limitEndNote());
      return true;
    }
    intent = verdict.go ? "go" : "stop";
    if (verdict.rounds) rounds = verdict.rounds;
    why = verdict.failed ? T("Could not read the answer.") : verdict.note;
  }
  const name = node.title || node.id;
  if (intent === "stop") {
    finishWorkflow(chat.id, "cancelled", T`Finished at the round cap: “${name}” ran ${pending.count} times.${why ? ` (${why})` : ""}`);
    return true;
  }
  // Granting more rounds than the step limit allows means: the run fails on it right after.
  // Better say how many there really are ("99 more" with 4 steps remaining).
  const restSteps = Math.max(0, WORKFLOW_MAX_STEPS - (run.step || 0));
  if (rounds > restSteps) {
    why = [why, T`Only ${restSteps} steps remain before the limit — that is how many rounds you get.`].filter(Boolean).join(" ");
    rounds = Math.max(1, restSteps);
  }
  // The WHOLE cycle gets the rounds (see wf.grantCycle) — otherwise one step later the equally
  // high cap of the neighbour asks, and the questions cascade once around the loop.
  const cursor = wf.grantCycle(
    graph,
    wf.clearPending({ ...run.cursor, vars: { ...(run.cursor.vars || {}), answer } }),
    node,
    rounds,
  );
  store.updateWorkflowRun(chat.id, { status: "running", cursor, question: "", note: "" });
  workflowNote(chat.id, { kind: "cap", step: run.step, title: node.title || "", rounds: pending.count, cap: pending.cap + rounds, granted: rounds });
  emitWorkflowRun(chat.id, store.getWorkflowRun(chat.id));
  driveWorkflow(chat.id, "", { overruled }).catch((e) => console.error("[workflow] continuing after the cap failed:", e?.message || e));
  return true;
}

// ── Review node: the human checks ────────────────────────────────────────────
// Phase 2: the turn is through, its output IS the request (summary + test instructions). The run
// goes into `waiting`, reports (bell) and creates the item "Request review" in the chat's agenda
// — whoever only looks at the agenda should still notice that it is their turn.
function requestHumanReview(chat, run, graph, cursor, node, lastOutput) {
  const round = wf.visitCount(cursor, node.id) || 1;
  // No silent cut here either: the instructions the human reads must not end mid-sentence at
  // the cap while the later interpretation of their answer claims completeness. Whoever is
  // truncated is told so.
  const question = wf.clipForVerdict(String(lastOutput || "").trim(), wf.RESULT_MAX)
    || T("Please check the current state and answer with \"looks good\" or with your findings.");
  const point = reviewPointCreate(chat, cursor, question);
  const vars = { ...withoutReviewTodo(cursor.vars), answer: "", reviewLast: "", reviewPoint: point.id };
  const held = wf.withPending({ ...cursor, vars }, { kind: "review", node: node.id, round, point: point.id });
  store.updateWorkflowRun(chat.id, { status: "waiting", cursor: held, nodeId: node.id, nodeTitle: node.title || "", question });
  logRunStep(run, "review", { nodeId: node.id, nodeTitle: node.title || "", step: run.step, detail: { question, round, point: point.id, ...agendaErrorDetail(point) } });
  workflowNote(chat.id, { kind: "review", step: run.step, title: node.title || "", round, text: question });
  // The notification is the point of this node: the run stands still until a human answers. It
  // can still be deselected (notify) — e.g. when two reviews follow closely.
  if (node.notify) {
    recordNotice({
      kind: "review", chatId: chat.id, chatTitle: chat.title || run.workflowName || "",
      workspaceId: chat.workspaceId, projectId: chat.projectId || null,
      title: round > 1
        ? T`Review requested (round ${round}): ${chat.title || run.workflowName}`
        : T`Review requested: ${chat.title || run.workflowName}`,
      body: firstLines(question),
    });
  }
  emitWorkflowRun(chat.id, store.getWorkflowRun(chat.id));
}

// The item "Request review" in the agenda of the workflow chat. Created by the SERVER as the driver (not via a tool by
// the agent): it belongs to the node, not to the model's discretion — so it goes straight into the store via
// agenda/change.js, bypassing the route that only lets the main agent write. A second round gets NO second item, the
// same one is updated (`vars.reviewPoint`, id `s<n>`).
// The card is the gate, the item only the display: an error (AgendaError, chat missing, no agenda, archived) does not
// hold up the gate, it goes into the step log (`agendaError`). A chat without an agenda (store.chatKeepsAgenda) gets
// no item. A run that stood at the card across a deploy may still carry `vars.reviewTodo`/`pending.todoId` — nothing
// reads them, it continues without an item, and the field is dropped at the next write of the variables.
const withoutReviewTodo = (vars) => { const { reviewTodo: _old, ...rest } = vars || {}; return rest; };
const agendaErrorDetail = (r) => (r?.error ? { agendaError: r.error } : {});
function agendaErrorText(e) {
  if (e instanceof AgendaError) return e.message;
  return e?.code ? String(e.code) : String(e?.message || e).slice(0, 300);
}
// The item with this id in the chat's agenda including the leaves of its subtree (`sheets`, empty = it is a leaf
// itself) — null if it (or the agenda) does not exist. The gate needs the leaves because the node agent may create
// sub-items under "Request review": then the item's status is computed (agenda/operations.js throws for a `status`
// on it), and the leaves are ticked off.
function agendaItem(chat, id) {
  if (!id) return null;
  let steps = [];
  try { steps = store.readAgenda(chat.id).steps || []; } catch { return null; }
  const point = steps.find((s) => s.id === id);
  if (!point) return null;
  const inSubtree = new Set([id]);
  for (const s of steps) if (s.parent != null && inSubtree.has(s.parent)) inSubtree.add(s.id); // pre-order: parents before children
  const hasChildren = new Set(steps.filter((s) => s.parent != null).map((s) => s.parent));
  const sheets = steps.filter((s) => s.id !== id && inSubtree.has(s.id) && !hasChildren.has(s.id));
  return { ...point, sheets };
}
// Characters as the agenda counts them (code points) — the cap of the note (2,000) is kept here, not exceeded: a
// long answer by the human should not make the item fail.
const clipped = (text, max = 2000) => { const z = [...String(text || "")]; return z.length > max ? `${z.slice(0, max - 1).join("")}…` : z.join(""); };

// The item lives in the ACTIVE tree only: once archived (the agent, or the sweep a week after it was finished), the next round
// no longer finds it and creates a new "Request review" item — intended, the archived one is history.
function reviewPointCreate(chat, cursor, question) {
  if (!store.chatKeepsAgenda(chat)) return { id: "" };
  const note = firstLines(question, 400);
  const old = agendaItem(chat, String(cursor.vars?.reviewPoint || ""));
  try {
    // As long as the item exists, IT is updated (even one ticked off by the agent — the new round reopens it). A
    // status only goes to a leaf and only if it is not already set; with sub-items only the note (the status is
    // computed — a `status` there would be an AgendaError, and the next round would create a second item).
    if (old) {
      changeAgenda(chat.id, chat.workspaceId, { steps: [{ op: "change", id: old.id, note, ...(!old.sheets.length && old.status !== "open" ? { status: "open" } : {}) }] }, { originator: "server" });
      return { id: old.id };
    }
    const r = changeAgenda(chat.id, chat.workspaceId, { steps: [{ op: "fresh", text: T("Request review"), note }] }, { originator: "server" });
    return { id: r.fresh[0] || "" };
  } catch (e) {
    console.error("[workflow] review item of the agenda:", agendaErrorText(e));
    return { id: "", error: agendaErrorText(e) };
  }
}

// Complete the item (default) or replace its note (`note`). → `{ way }` (the item has been deleted — the variable is
// cleared) or `{ error }`; without an id nothing. For an item with sub-items completing means: tick off its open
// leaves, in ONE move (the agenda rule — the item's status is computed from them); the approval (or skip, cancel)
// ends the review including its sub-steps. What is already set does not go out again.
function reviewPointWrite(chat, id, { note = null } = {}) {
  if (!id) return {};
  const point = agendaItem(chat, id);
  if (!point) return { gone: true };
  const ops = note !== null ? [{ op: "change", id, note: clipped(note) }]
    : (point.sheets.length ? point.sheets : [point]).filter((s) => s.status !== "done").map((s) => ({ op: "change", id: s.id, status: "done" }));
  if (!ops.length) return {};
  try {
    changeAgenda(chat.id, chat.workspaceId, { steps: ops }, { originator: "server" });
    return {};
  } catch (e) {
    console.error("[workflow] review item of the agenda:", agendaErrorText(e));
    return { error: agendaErrorText(e) };
  }
}

// Interpretation of an unclear review answer. As with the round cap: two attempts, after that
// "findings" applies. The asymmetry is intended — a wrongly detected approval sends an
// unchecked state onwards, a wrongly detected finding costs one turn.
async function judgeReviewAnswer(chat, node, round, question, answer, { overruled = false } = {}) {
  const prompt = wf.reviewAnswerPrompt({ node, round, question, answer });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await verdictOneshot(chat, prompt, "", { overruled });
      const obj = jsonObject(out) || {};
      if (typeof obj.approval === "boolean") return { ok: obj.approval, note: String(obj.note || "").slice(0, 140) };
    } catch (e) {
      // As with the cap: "when in doubt findings" is the rule for an answer that was READ but
      // is unclear. Unread because of the limit means wait — otherwise it sends the human into
      // a fix round they never asked for.
      if (isLimitError(e)) return { limited: true, error: e };
      /* second attempt; after that "findings" applies */
    }
  }
  return { failed: true, ok: false, note: "" };
}

// The human's answer to a review request: approval → edge "ok"; anything else is findings →
// edge "issues", and the answer is available to the fixing step as {{answer}}.
// `logged`: see answerCap — re-entry after a verdict parked at the limit.
async function answerReview(chat, run, graph, pending, text, { logged = false, overruled = false } = {}) {
  resolveNotices({ id: chat.id, kinds: ["review"] }); // a human has judged — the bell should stop prompting
  const node = wf.nodeById(graph, pending.node);
  const answer = String(text || "").slice(0, 4000);
  const round = pending.round || 1;
  if (!logged) logRunStep(run, "answer", { nodeId: pending.node, nodeTitle: run.nodeTitle, step: run.step, detail: { question: run.question, answer: answer.slice(0, 2000), review: true, round } });
  if (!node) { finishWorkflow(chat.id, "failed", T("That step is no longer in the graph.")); return true; }
  let intent = wf.reviewIntent(answer);
  let why = "";
  if (intent === "unclear") {
    const verdict = await judgeReviewAnswer(chat, node, round, run.question, answer, { overruled });
    // While the model judges, the run stays on "waiting" — any further message in this window
    // would pass as a SECOND answer to the same review round and then leave two drivers running
    // on ONE run. Whoever writes first wins.
    if (!runStillOur(chat.id, run)) return true;
    // Parked: the run keeps waiting for the same review — the verdict comes after the reset.
    if (verdict.limited && await parkJudge(chat, verdict.error, { at: "review", answer })) return true;
    // Limit but not parkable: end honestly. The UNREAD answer must not go over the issues edge
    // as "findings" — the fixing step would then work on what may have been an approval.
    // "gave-up" may already have ended it → no-op.
    if (verdict.limited) {
      finishWorkflow(chat.id, "failed", limitEndNote());
      return true;
    }
    intent = verdict.ok ? "ok" : "issues";
    why = verdict.failed ? T("Could not read the answer — treated as findings.") : verdict.note;
  }
  // A run from before the agenda item carries `reviewTodo`/`todoId` instead of the item — it continues without an item (see reviewPointCreate).
  const pointId = String(run.cursor?.vars?.reviewPoint || pending.point || "");
  const base = { ...withoutReviewTodo(run.cursor.vars), answer };
  const name = node.title || node.id;
  if (intent === "ok") {
    const point = reviewPointWrite(chat, pointId);
    const cursor = wf.clearPending({ ...run.cursor, vars: { ...base, reviewLast: "", reviewPoint: "" } });
    store.updateWorkflowRun(chat.id, { status: "running", cursor: wf.advance(graph, cursor, "ok"), question: "", note: why });
    logRunStep(run, "review", { nodeId: node.id, nodeTitle: node.title || "", step: run.step, detail: { verdict: "ok", round, note: why, ...agendaErrorDetail(point) } });
    workflowNote(chat.id, { kind: "review", title: node.title || "", verdict: "ok", round, note: why });
  } else {
    // Without a findings edge there is no path for "not like this" — then the run ends VISIBLY
    // with the reason instead of silently swallowing the user's findings (the editor warns of it).
    const target = wf.outgoing(graph, node.id, "issues");
    if (!target) {
      logRunStep(run, "review", { nodeId: node.id, nodeTitle: node.title || "", step: run.step, detail: { verdict: "issues", round, note: T("no \"findings\" edge") } });
      finishWorkflow(chat.id, "failed", T`Findings reported, but “${name}” has no “findings” edge — the run ends here. The answer is in the transcript.`);
      return true;
    }
    // The findings replace the item's note (capped at the agenda's cap); a deleted item clears the variable.
    const point = reviewPointWrite(chat, pointId, { note: `${T`Round ${round}: findings reported — being fixed`}\n\n${answer}` });
    // ONLY this place truncates (not the prompt a second time), and it announces it.
    const cursor = wf.clearPending({ ...run.cursor, vars: { ...base, reviewLast: wf.clipForVerdict(answer, 2000), reviewPoint: point.gone ? "" : pointId } });
    store.updateWorkflowRun(chat.id, { status: "running", cursor: wf.advance(graph, cursor, "issues"), question: "", note: why });
    logRunStep(run, "review", { nodeId: node.id, nodeTitle: node.title || "", step: run.step, detail: { verdict: "issues", round, note: why, ...agendaErrorDetail(point) } });
    workflowNote(chat.id, { kind: "review", title: node.title || "", verdict: "issues", round, note: why });
  }
  emitWorkflowRun(chat.id, store.getWorkflowRun(chat.id));
  driveWorkflow(chat.id, "", { overruled }).catch((e) => console.error("[workflow] continuing after review failed:", e?.message || e));
  return true;
}

// Answer to a question node: it becomes the variable {{answer}} of the next step.
async function answerWorkflow(chat, text) {
  const run = store.getWorkflowRun(chat.id);
  if (!run || run.status !== "waiting") return false;
  const g = workflowGraph(run);
  if (!g) { finishWorkflow(chat.id, "failed", T("The workflow was deleted.")); return true; }
  const { graph } = g;
  // If the run waits at the round cap, the answer is not a step answer but a decision about
  // the loop itself.
  const pending = wf.pendingOf(run.cursor);
  if (pending?.kind === "cap") return answerCap(chat, run, graph, pending, text);
  // If the run waits for a human review, the answer is a VERDICT ("looks good" or findings),
  // not input for the next step.
  if (pending?.kind === "review") return answerReview(chat, run, graph, pending, text);
  // After a /stop the run holds at this node. "continue" executes it once more, anything else
  // is a job for the same step — just as at the completion gate.
  if (pending?.kind === "stopped") {
    const answer = String(text || "").slice(0, 4000);
    // A condition or a loop head has no turn of its own: a job would go nowhere there and the
    // gate afterwards would take the first edge without ever having judged. At such nodes
    // EVERY answer means "once more", the text stays in the history as a user row.
    const stoppedNode = wf.currentNode(graph, run.cursor);
    // The set is defined ONCE, in workflows.js (`TURN_TYPES` next to `countsAsStep`).
    const withoutTurn = Boolean(stoppedNode) && !wf.countsAsStep(stoppedNode);
    const go = withoutTurn || wf.capIntent(answer) === "go";
    const cleared = nextGeneration(wf.clearPending(run.cursor));
    logRunStep(run, "answer", {
      nodeId: pending.node, nodeTitle: run.nodeTitle, step: run.step,
      detail: { question: run.question, answer: answer.slice(0, 2000), stopped: true, go },
    });
    store.updateWorkflowRun(chat.id, { status: "running", cursor: cleared, question: "", note: "" });
    emitWorkflowRun(chat.id, store.getWorkflowRun(chat.id));
    if (go) {
      // WITH the last output: after a stop during a verdict the cursor stands on a condition or
      // a loop head — without `lastOutput` the condition would then judge "(no previous step)",
      // that is, nothing.
      driveWorkflow(chat.id, lastOutputValue(run.id))
        .catch((e) => console.error("[workflow] continuing after stop failed:", e?.message || e));
      return true;
    }
    doRun(chat, withEarmarked(chat, wf.clipWithAnnouncement(text, 4000)))
      .catch((e) => console.error("[workflow] job after stop failed:", e?.message || e));
    return true;
  }
  // Completion gate at the cap: "continue" advances, anything else is a JOB for the same step
  // (and resets its round budget — the human has just steered).
  if (pending?.kind === "done") {
    const answer = String(text || "").slice(0, 4000);
    const go = wf.capIntent(answer) === "go";
    const cleared = wf.clearPending(run.cursor);
    logRunStep(run, "answer", {
      nodeId: pending.node, nodeTitle: run.nodeTitle, step: run.step,
      detail: { question: run.question, answer: answer.slice(0, 2000), gate: true, go },
    });
    if (go) {
      const next = wf.advance(graph, wf.clearDoneRound(cleared, pending.node));
      store.updateWorkflowRun(chat.id, { status: "running", cursor: next, question: "", note: "" });
      workflowNote(chat.id, { kind: "gate", title: run.nodeTitle || "", done: true, note: T("Released by the user.") });
      emitWorkflowRun(chat.id, store.getWorkflowRun(chat.id));
      driveWorkflow(chat.id).catch((e) => console.error("[workflow] completion gate: advancing failed:", e?.message || e));
      return true;
    }
    store.updateWorkflowRun(chat.id, {
      status: "running", cursor: wf.withDoneRound(cleared, pending.node, 0), question: "", note: "",
    });
    emitWorkflowRun(chat.id, store.getWorkflowRun(chat.id));
    doRun(chat, withEarmarked(chat, wf.clipWithAnnouncement(text, 4000)))
      .catch((e) => console.error("[workflow] completion gate: continuation failed:", e?.message || e));
    return true;
  }
  // The question did not come from an ask node of its own but from the skill of the current
  // agent node. So do NOT advance to the next node: give the answer into the same session and
  // let it continue working there. The message route has already persisted the user row.
  // A message while the step holds at the approval card of a dynamic workflow: like the interim question at an agent
  // question — it goes into THE SAME step, the card stays open, and the hold arises again after the turn. The decision
  // is only made at the card (dynApprovalDecided).
  if (pending?.kind === "dyn_approval") {
    const answer = String(text || "").slice(0, 4000);
    store.updateWorkflowRun(chat.id, { status: "running", cursor: wf.clearPending(run.cursor), question: "", note: "" });
    logRunStep(run, "answer", {
      nodeId: pending.node, nodeTitle: run.nodeTitle, step: run.step,
      detail: { question: run.question, answer: answer.slice(0, 2000), requestId: pending.requestId || "", dynApproval: true, interjection: true },
    });
    emitWorkflowRun(chat.id, store.getWorkflowRun(chat.id));
    doRun(chat, withEarmarked(chat, wf.clipWithAnnouncement(text, 4000)))
      .catch((e) => console.error("[workflow] continuing at the approval card failed:", e?.message || e));
    return true;
  }
  if (pending?.kind === "agent_ask") {
    const answer = String(text || "").slice(0, 4000);
    // Free text is an INTERIM QUESTION here, not an answer to the card: the selection goes via
    // /ask-answer and writes an `ask_answer` row. So the card stays open (openAskOf), the hold
    // at this node arises again after the turn — and the history must not present this row as
    // an answer, otherwise an unanswered decision point looks answered.
    store.updateWorkflowRun(chat.id, {
      status: "running", cursor: wf.clearPending(run.cursor), question: "", note: "",
    });
    logRunStep(run, "answer", {
      nodeId: pending.node, nodeTitle: run.nodeTitle, step: run.step,
      detail: {
        question: run.question, answer: answer.slice(0, 2000),
        requestId: pending.requestId || "", agent: true,
        interjection: Boolean(openAskOf(chat.id)),
      },
    });
    emitWorkflowRun(chat.id, store.getWorkflowRun(chat.id));
    doRun(chat, withEarmarked(chat, wf.clipWithAnnouncement(text, 4000)))
      .catch((e) => console.error("[workflow] continuing after agent question failed:", e?.message || e));
    return true;
  }
  // Truncate WITH an announcement: otherwise neither the human nor the model could tell an
  // answer cut off at 4,000 characters in the follow-up prompt from a complete one.
  const cursor = { ...run.cursor, vars: { ...(run.cursor.vars || {}), answer: wf.clipWithAnnouncement(text, 4000) } };
  // The node that was waited at is no longer in the graph (someone edited the workflow): the
  // run must not end as "done" as if it had finished. It has not.
  if (!wf.currentNode(graph, cursor)) {
    logRunStep(run, "answer", { nodeId: run.nodeId, nodeTitle: run.nodeTitle, step: run.step, detail: { question: run.question, answer: String(text || "").slice(0, 2000) } });
    finishWorkflow(chat.id, "failed", T("That step is no longer in the graph."));
    return true;
  }
  const next = wf.advance(graph, cursor);
  store.updateWorkflowRun(chat.id, { status: "running", cursor: next, question: "" });
  logRunStep(run, "answer", { nodeId: run.nodeId, nodeTitle: run.nodeTitle, step: run.step, detail: { question: run.question, answer: String(text || "").slice(0, 2000) } });
  emitWorkflowRun(chat.id, store.getWorkflowRun(chat.id));
  driveWorkflow(chat.id).catch((e) => console.error("[workflow] continuing failed:", e?.message || e));
  return true;
}

// `waitForRunEnd` (if a turn is running, it has to end first) lives in runs/state.js; here it is only imported
// (skipWorkflowStep, cancelWorkflow).
// Skip and cancel run SERIALLY per chat. Both first read the status and write after an `await`
// — three simultaneous clicks (or three calls from a script) would run through the same gap: an
// already skipped step would still run in full, skip rows would carry their neighbour's node,
// and two cancels would write two "end" rows into the same log. The second call gets `false`
// — the same answer as a call for which there is nothing to do.
const workflowAction = new Set(); // chatId — is a skip/cancel running right now?
// `wait: true` queues up instead of being rejected. That is the difference between the two
// gestures: a second skip is most likely a double click and should be dropped — a CANCEL is
// never an accident and must not fail because a skip is running (which would swallow it
// silently and still report 200).
async function serialPerChat(chatId, fn, { wait = false } = {}) {
  if (workflowAction.has(chatId)) {
    if (!wait) return false;
    const until = Date.now() + 10_000;
    while (workflowAction.has(chatId) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    if (workflowAction.has(chatId)) return false;
  }
  workflowAction.add(chatId);
  try { return await fn(); } finally { workflowAction.delete(chatId); }
}
const skipWorkflowStep = (chat) => serialPerChat(chat.id, () => skipWorkflowStepIntern(chat));
const cancelWorkflow = (chat) => serialPerChat(chat.id, () => cancelWorkflowIntern(chat), { wait: true });

async function skipWorkflowStepIntern(chat) {
  let run = store.getWorkflowRun(chat.id);
  if (!store.workflowOpen(run)) return false;
  const g = workflowGraph(run);
  if (!g) return false;
  const { graph } = g;
  if (running.has(chat.id)) {
    workflowIntent.set(chat.id, "skip");
    stopRun(chat.id);
    await waitForRunEnd(chat.id);
    workflowIntent.delete(chat.id);
    // The turn survived the stop (the deadline of waitForRunEnd has passed). Setting the cursor
    // now would be flying blind: the gate of this turn is about to run and would advance from
    // the NEW position. Better to honestly do nothing — the user sees "not skipped" and can
    // cancel, which is safe even with a stubborn turn.
    if (running.has(chat.id)) return false;
    // The snapshot from BEFORE the wait may be stale now.
    run = store.getWorkflowRun(chat.id);
    if (!store.workflowOpen(run)) return false;
  }
  let cursor = run.cursor && "at" in run.cursor ? run.cursor : wf.initialCursor(graph, run.input);
  const node = wf.currentNode(graph, cursor);
  // If the run waits at the round cap, "skip" means: leave out this step and continue behind
  // it. The open question is thereby answered — and a single round granted, to the WHOLE
  // cycle: the neighbours' counters are equally high, otherwise their cap would trip right
  // after the jump (the skipped step would be bypassed, the question would come anyway).
  if (wf.pendingOf(cursor)?.kind === "cap" && node) cursor = wf.grantCycle(graph, wf.clearPending(cursor), node, 1);
  // If the run waits for a human review, "skip" means what an approval means too: continue
  // via the edge "ok". Without this branch the order of the edges would decide whether the run
  // jumps to the approval or into the fix loop.
  let skipBranch = null;
  let skipPoint = {};
  if (wf.pendingOf(cursor)?.kind === "review" && node) {
    cursor = wf.clearPending(cursor);
    skipBranch = "ok";
    skipPoint = reviewPointWrite(chat, String(cursor.vars?.reviewPoint || ""));
    // The bell would otherwise keep prompting for a review nobody can give any more — an
    // approval clears it (answerReview), the skip has to as well.
    resolveNotices({ id: chat.id, kinds: ["review"] });
    cursor = { ...cursor, vars: { ...withoutReviewTodo(cursor.vars), reviewPoint: "", reviewLast: "" } };
  }
  cursor = wf.cancelCommand(cursor);
  // Everything still attached to the skipped step is cleared away with it — otherwise it travels
  // in the cursor: (a) an open `pending` (completion gate, agent question; cap and review are
  // handled above) would route the answer to the NEXT question node into the branch of the old
  // hold, because an ordinary ask node sets no `pending` itself. (b) The gate's round counter
  // would let a later loop round start with half its budget. (d) The arrival mark of a cap
  // jump: it applies to the node being skipped now — the next one would otherwise come via the
  // regular path and still read "via the cap".
  cursor = wf.withoutArrival(wf.clearDoneRound(wf.clearPending(cursor), node?.id || ""));
  // (c) An open question card of the agent: it survives every user message in the run (sticky
  // in openAskOf) and would hold the next step at the old question right away.
  dismissAsk(chat.id, "skip");
  // (e) A VERDICT of this step parked at the limit (condition, gate, cap/review interpretation):
  // its re-entry points to the node being skipped now. If the row stayed, the continuation
  // would judge, after the reset, an output that is long gone from the cursor — or discard
  // itself silently while the strip says "waiting" until then.
  clearAwayJudgeRow(chat.id);
  // (f) A TURN of this step parked at the limit (or gate): its run row carries the prompt of
  // the node being skipped now. If it stayed, the skipped node would run after the reset
  // anyway, its result would pass the gate as that of the cursor (the successor), and the
  // successor — queued behind the row at the same limit — would then run a second time. NOT
  // cancelAutoContinue: that would close the workflow as failed and start the queue — but the
  // run is just continuing. Only a row that belongs to the workflow: a parked user turn in a
  // workflow chat would count at the gate as the result of the open step, the very one that
  // is dropped here.
  const parked = store.getPendingResume(chat.id);
  if (parked && (parked.kind || "run") === "run" && parked.workflow && !running.has(chat.id)) {
    clearAutoContinueTimer(chat.id);
    store.clearPendingResume(chat.id);
    limitLine(chat.id, { kind: "cancel", group: parked.limitGroup, label: parked.limitLabel, text: T(
      "Step skipped — the parked continuation of this step is dropped.") });
    emitAutoContinue(chat.id, null);
  }
  const next = node?.type === "parallel"
    ? wf.jumpTo(graph, cursor, wf.parallelBranches(graph, node.id).join)
    : wf.advance(graph, cursor, skipBranch);
  store.updateWorkflowRun(chat.id, { status: "running", cursor: next, question: "" });
  closeRunStep(run, { ok: false, error: "skipped" });
  logRunStep(run, "skip", { nodeId: node?.id || "", nodeTitle: node?.title || "", step: run.step, detail: { ...agendaErrorDetail(skipPoint) } });
  workflowNote(chat.id, { kind: "skip", title: node?.title || "", step: run.step });
  driveWorkflow(chat.id).catch((e) => console.error("[workflow] skip failed:", e?.message || e));
  return true;
}
async function cancelWorkflowIntern(chat) {
  const run = store.getWorkflowRun(chat.id);
  if (!store.workflowOpen(run)) return false;
  // If the run was waiting for a human review, both would otherwise be left behind: the bell
  // keeps prompting for it, and the item "Request review" stays open in the agenda — for a
  // run that no longer exists.
  if (wf.pendingOf(run.cursor)?.kind === "review") {
    const point = reviewPointWrite(chat, String(run.cursor?.vars?.reviewPoint || ""));
    if (point.error) logRunStep(run, "review", { nodeId: run.nodeId || "", nodeTitle: run.nodeTitle || "", step: run.step, detail: { verdict: "cancelled", ...agendaErrorDetail(point) } });
    resolveNotices({ id: chat.id, kinds: ["review"] });
  }
  if (running.has(chat.id)) {
    workflowIntent.set(chat.id, "cancel");
    stopRun(chat.id);
    await waitForRunEnd(chat.id);
    workflowIntent.delete(chat.id);
  }
  finishWorkflow(chat.id, "cancelled", T("Cancelled by the user."));
  // If the run hung at the usage limit, the scheduled continuation is settled with the workflow.
  // AFTER the end, not before: cancelAutoContinue closes a hanging workflow itself whenever it
  // discards ("failed", usage limit) — placed before, the run would end with the wrong reason,
  // and a job queued behind the row would start into a workflow still "running" and count at
  // the gate as the result of the open step.
  cancelAutoContinue(chat.id, { note: T("Workflow cancelled — the scheduled continuation is dropped.") });
  return true;
}

/**
 * The human has decided at the approval card of a dynamic workflow (called by dynworkflows/routes.js BEFORE the
 * decision starts a run or delivers a notice). If the graph step of this chat holds at exactly this card, it runs
 * again: accepting starts the workflow, whose completion notice arrives as a follow-up turn of THE SAME step (every
 * turn in between holds until it has ended — runs/do-run.js holdMs); rejecting delivers the system message whose turn
 * is the step. Only at its end does the gate judge — as after an answered question. The notification counts as
 * settled. Returns whether a step was holding at it.
 */
function dynApprovalDecided(chat, requestId) {
  resolveNotices({ id: chat.id, requestId, kinds: ["question"] });
  const run = store.getWorkflowRun(chat.id);
  const pending = run?.status === "waiting" ? wf.pendingOf(run.cursor) : null;
  if (pending?.kind !== "dyn_approval" || pending.requestId !== requestId) return false;
  store.updateWorkflowRun(chat.id, { status: "running", cursor: wf.clearPending(run.cursor), question: "", note: "" });
  logRunStep(run, "answer", { nodeId: pending.node, nodeTitle: run.nodeTitle, step: run.step, detail: { question: run.question, requestId, dynApproval: true } });
  emitWorkflowRun(chat.id, store.getWorkflowRun(chat.id));
  return true;
}

// ── Hooks and switches of the workflow side (registered in server.js) ──
// What `runs/` would call here directly arrives as a firing or a question of the hook registry; conditions that
// would stand BEFORE the call live in the consumer.
// afterRun/"workflow-gate": after a clean turn the driver advances — only if the run was not parked at the limit and
// a workflow is running. Both come from the payload: doRun reads the state of the run ONCE before firing and decides
// on the target gate with the same reading (reading afterwards, it would see the status set by the gate). The
// rejection is logged to the console, the call is not awaited.
function workflowGateHook({ chat, resultText, parkedAfterOk, workflowRunning }) {
  if (parkedAfterOk || !workflowRunning) return;
  workflowGateAfterRun(chat, resultText).catch((e) => console.error("[workflow] gate:", e?.message || e));
}
// afterRunFailed/"workflow-failed" (abort with code 0, and exit ≠ 0 when not parked): the step gets its error, a
// stopped run halts, a failed one ends.
// Error path of this consumer: if workflowRunFailed throws SYNCHRONOUSLY (a store error, a broken cursor in
// holdWorkflow), the hook frame catches it (`[hooks] afterRunFailed/workflow-failed: …`), the turn ends regularly,
// the server lives — and the workflow run stays behind as a zombie on "running". Whoever does not want the zombie
// catches HERE and calls `finishWorkflow(chat.id, "failed", …)` — that would be a repair with new behaviour. Towards
// the switch (verdictSwitch) a throw still passes THROUGH.
function workflowFailedHook({ chat, code, aborted }) {
  workflowRunFailed(chat, code, { aborted });
}
// Switch "followUpRun"/"workflow-response": if a workflow run is waiting in this chat, the queued message is its
// ANSWER — just like a message via /message; as a turn of its own it would bypass the run. Answer `true` = taken (the
// answer itself continues as fire and forget), `undefined` = no waiting workflow.
// A MESSAGE (cause "message") never answers a gate — it is not the human's decision. In the child chat of a graph run
// it is earmarked and goes along with the next node turn (`true`, no turn of its own); in any other chat it runs as a
// turn of its own (`undefined`).
// If a workflow is waiting for the human in that other chat, it goes back to the head of the queue (`true`, no turn
// next to the waiting run — the same as the queue drain does with such a head); it goes along with the next turn of
// the run or after the answer. In the child chat of an ENDED run it lapses (messageFromQueue).
function followUpRunSwitch({ chat, next }) {
  if (next?.cause === "message") {
    if (messageFromQueue(chat, next)) return true;
    if (store.getWorkflowRun(chat.id)?.status !== "waiting") return undefined;
    putBackMessage(chat.id, next);
    return true;
  }
  if (store.getWorkflowRun(chat.id)?.status !== "waiting") return undefined;
  answerWorkflow(chat, next.prompt)
    .catch((e) => console.error("[workflow] queued answer failed:", e?.message || e));
  return true;
}
// Switch "hold"/"graph-workflow" (asked in do-run.js during preparation, only where the run kind does not hold): if
// a graph workflow is OPEN in this chat — the one notion archive and wait row use too (running OR waiting; asking
// only `running` has been the mistake before) —, the turn holds until its background agents are done and their
// reports are processed in the same turn. Only then does afterRun fire, and completion check, review and the next
// node see the state AFTER the completion notice; the follow-up turn is part of the same run and not a new node
// visit. No open run ⇒ `undefined` (not responsible), never `false`: the chain should be able to keep asking.
// Dynamic workflows need no responder of their own: the holding turn asks the ONE query in runs/background.js, which
// tracks them as a second kind.
function graphHoldSwitch({ chat }) {
  return chat?.id && store.workflowOpenFor(chat.id) ? true : undefined;
}
// Switch "verdict"/"workflow" (resumeJudge): continue a parked workflow verdict where it broke off — first check
// whether the situation is still the same (the state from back then, see parkJudge; if missing, the old, weaker
// check on the status alone applies). `at === "goal"` is the target verdict and stays in runs/ (undefined). Answer
// `false` = the situation no longer fits (discarded, with an outdated state including the history row from
// verdictOutdated), a promise = taken over — the caller awaits it; unknown `at` = false.
function verdictSwitch({ at, chatId, chat, payload, overruled }) {
  if (at === "goal") return undefined;
  if (!!payload?.run && !runStillOur(chatId, payload.run)) return verdictOutdated(chatId);
  const run = store.getWorkflowRun(chatId);
  if (at === "workflow") {
    if (run?.status !== "running" || running.has(chatId)) return false;
    return driveWorkflow(chatId, payload.lastOutput || "", { overruled });
  }
  // Completion gate: the cursor still stands on the node whose turn has already RUN. Here
  // driveWorkflow must NOT take over — that would execute the node a second time (new step, new
  // round) instead of judging the existing output. Hence a separate entry straight into the
  // gate, with exactly the output that was present when parking.
  if (at === "gate") {
    if (run?.status !== "running" || running.has(chatId)) return false;
    // If a gate is holding this state right now (the restart hook, a hook gate after a turn),
    // the call below would be a silent rejection — and it would count as "taken over" here:
    // the judge row would be dropped, a "start anyway" would be used up without a verdict
    // taking place. So discard honestly, with the history row: the holder keeps judging itself
    // and parks anew if needed.
    if (gateRunning(chatId)) return verdictOutdated(chatId);
    return workflowGateAfterRun(chat, payload.lastOutput || "", { overruled });
  }
  if (at === "cap" || at === "review") {
    if (run?.status !== "waiting") return false;
    const g = workflowGraph(run);
    const pending = wf.pendingOf(run.cursor);
    if (!g || pending?.kind !== at) return false;
    // `logged`: the answer row is already in the step history (it was created before the verdict).
    const fn = at === "cap" ? answerCap : answerReview;
    return fn(chat, run, g.graph, pending, payload.answer || "", { logged: true, overruled });
  }
  return false;
}

// ── Resumption after a restart ────────────────────────────────────────────────────────────────────────────
// Hook "restartGraceWorkflows"/"workflow-locks": catch up on the lock. A run that was open BEFORE the locks were
// introduced (or whose lock row is missing) must get it when continuing — otherwise a trigger could send a second run
// into the same repo while this one keeps working. This applies to EVERY open run: in the normal case of a crash
// (turn was still running, active_runs row present) the chat is not in `flows` at all. The safety net including the
// console line stays here.
function workflowLocksHook() {
  try {
    for (const r of store.listOpenWorkflowRuns()) {
      const chat2 = store.getChat(r.chatId);
      const flow = chat2 && store.getWorkflow(r.workflowId);
      if (!flow || store.lockOfRun(r.id)) continue;
      const key = wf.lockKeyFor(flow.lock, { workflowId: flow.id, projectId: chat2.projectId || flow.projectId || "", workspaceId: r.workspaceId || chat2.workspaceId || "", vars: r.cursor?.vars || {} });
      if (key) store.acquireLock(key, { runId: r.id, chatId: r.chatId, workflowId: flow.id, workflowName: flow.name, workspaceId: r.workspaceId || chat2.workspaceId || "" });
    }
  } catch (e) { console.error("[resume] lock:", e?.message || e); }
}
// Hook "restartGraceWorkflows"/"workflow-runs" (registered behind the locks): drive the runs interrupted between two
// steps (`flows`, computed in resume.js — they depend on `running`, `compacting` and the active_runs).
function workflowRunsHook({ flows }) {
  for (const r of flows) {
    // Chat gone: the run stays as history but is closed (nothing to continue).
    const chat = store.getChat(r.chatId);
    if (!chat) { try { store.abandonWorkflowRuns(r.chatId, store.CHAT_DELETED_NOTE); } catch {} continue; }
    // Two different situations, and the difference costs a whole step:
    //  (a) The turn of the cursor node was already DONE (its row is closed), only the gate did
    //      not get to advance the cursor. Then driveWorkflow must NOT take over — it would
    //      execute the node a second time, side effects included.
    //  (b) Otherwise continue as usual — but WITH the last output: without it a condition
    //      judges "(no previous step)" after the restart, that is, nothing.
    const output = lastOutputValue(r.id);
    const rows = (() => { try { return store.listRunSteps(r.id); } catch { return []; } })();
    const lastStep = [...rows].reverse().find((x) => x.kind === "step");
    const gateOpen = Boolean(lastStep && lastStep.nodeId && lastStep.nodeId === (r.cursor?.at || "")
      && (lastStep.detail?.ok === true));
    if (gateOpen) {
      workflowGateAfterRun(chat, output).catch((e) => console.error("[resume] workflow gate", r.chatId, "failed:", e?.message || e));
    } else {
      driveWorkflow(r.chatId, output).catch((e) => console.error("[resume] workflow", r.chatId, "failed:", e?.message || e));
    }
  }
}
// Hook "restartGraceAbandoned"/"workflow-abandoned": a run that is given up after `attempts` resumptions. A
// workflow run of this chat would otherwise stay behind as a zombie on "running" (the flows list was computed when
// the active_runs row still existed, so nobody drives it in this process any more), and its LOCK would block every
// further start of the same workflow until someone cancels by hand. Safety net and console line as before.
function workflowAbandonedHook({ chat, attempts }) {
  try {
    if (store.getWorkflowRun(chat.id)?.status === "running") {
      finishWorkflow(chat.id, "failed", T`Gave up after ${attempts} attempts — the step could not be resumed.`);
    }
  } catch (e) { console.error("[resume] closing workflow run:", e?.message || e); }
}

export { answerCap, answerReview, answerWorkflow, cancelWorkflow, dynApprovalDecided, followUpRunSwitch, gateRunning, graphHoldSwitch, holdWorkflow, skipWorkflowStep, verdictSwitch, workflowAbandonedHook, workflowFailedHook, workflowGateAfterRun, workflowGateHook, workflowRunsHook, workflowRunFailed, workflowLocksHook };
