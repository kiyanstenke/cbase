// Graph workflows, the observer: card current, waking, notifications. Every change of a background run reaches the orchestrator
// (workflows/graph-background.js via the setters at emitWorkflowRun and at every row change). If the run waits for the human, the
// run view says what for (`wait`, graph-wait.js), the orchestrator gets a SILENT hint (does not wake), and for question · cap · done
// · stopped · permission a notification of kind "question" stands at the child chat — resolved as soon as the waiting ends. At the
// end a completion notice comes as a turn of its own of the orchestrator (system message, cause "agent"), unless the agent stopped
// itself. A child chat deleted by hand: row "stopped" (of "erase"), hint, no completion notice.
//
// Main seam via `withAgentsServer`, fake as in graph-background.test.js: "GS[<tag>]:{json}§" calls `cbase_workflow_start` over the
// REAL cbase MCP server; a step with "APPROVAL" asks for a permission via `cbase_permission_prompt` (result under `perm.jsonl`); a
// step answers "ERLEDIGT …", everything else "Gestartet.". A step is only a prompt whose line BEGINS with "[cbase workflow " — the
// completion notice quotes the head in the <result> and is none (otherwise the orchestrator itself would ask, and "permission" ran 240 s).
//
// Counter-tests (each run once) — "hangs" means: the test waits without a deadline for the event that never comes and tears the
// deadline of the suite (red):
//   - `setGraphRunObserver(graphRunSeen)` struck from server.js => "question node" hangs (no event with `wait`, no hint, no completion
//     notice);
//   - `setGraphRowsObserver(graphRowChanged)` struck => "stop" hangs (the waiting row, stopped by the human, reports nothing);
//   - the condition `stopped_of === "agent"` struck in runEnds => "stop" red (a third completion notice);
//   - the two approval hooks struck from server.js => "permission" hangs (the view stays `running`).
// No deadline in the test itself: a hang reports every 30 s what it waits for.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import * as store from "../electron/server/store.js";
import { getMonitorEvents } from "../electron/server/services.js";
import { running } from "../electron/server/runs/state.js";
import { backgroundWork } from "../electron/server/runs/background.js";
import { isCompletionNotice } from "../electron/server/runs/completionNotice.js";
import { streams } from "../electron/server/runtime/sse.js";
import { graphCompletionNotice } from "../electron/server/workflows/graph-background.js";

const MAIN = `
  fs.appendFileSync(path.join(LOCATION, "prompts.jsonl"), JSON.stringify({ text }) + "\\n");
  // Only the real step prompt: its head stands at the START of a line. The completion notice to the orchestrator quotes it in
  // <result>ERLEDIGT [cbase workflow …] APPROVAL … — with "contains" the fake took it for a step, asked for a permission in the
  // orchestrator chat, and "permission" waited twice 120 s for its refusal.
  const step = /^\\[cbase workflow /m.test(String(text));
  const g = text.indexOf("GS[");
  if (g >= 0 && !step) {
    const gtag = text.slice(g + 3, text.indexOf("]:", g));
    const args = JSON.parse(text.slice(text.indexOf("]:", g) + 2, text.indexOf("§", g)));
    const id = "toolu_gs_" + gtag;
    say({ type: "assistant", message: { id: "a-" + gtag + "-" + turn, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_workflow_start", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_workflow_start", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); }
    catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    fs.appendFileSync(path.join(LOCATION, "gs-" + gtag + ".jsonl"), JSON.stringify({ t }) + "\\n");
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  if (step && String(text).includes("APPROVAL")) {
    let d = null;
    try { d = JSON.parse(textOf(await mcpCall("cbase_permission_prompt", { tool_name: "Bash", input: { command: "rm -rf site" } }, null))); } catch {}
    fs.appendFileSync(path.join(LOCATION, "perm.jsonl"), JSON.stringify({ behavior: d && d.behavior }) + "\\n");
  }
  finished();
  say({ type: "result", result: step ? "ERLEDIGT " + String(text).replace(/\\s+/g, " ").slice(0, 80) : "Gestartet.", session_id: "s-main" });`;

const claude = fakeClaude({ main: MAIN });

async function raw(url, method = "GET", body = undefined) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json", Connection: "close" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const send = (base, chatId, text) => raw(`${base}/api/chats/${chatId}/message`, "POST", { text });
const stop = (base, chatId, startId, from) => raw(`${base}/api/chats/${chatId}/graph-workflows/${encodeURIComponent(startId)}/stop`, "POST", { from });

function newWorkflow(ws, name, graph) {
  const now = Date.now();
  const w = store.createWorkflow({ id: crypto.randomUUID(), workspaceId: ws.id, name, createdAt: now, updatedAt: now, graph });
  return store.updateWorkflow(w.id, { run: { doneAll: false } });
}
const linear = (...middle) => ({
  nodes: [{ id: "s", type: "start", title: "Start" }, ...middle, { id: "e", type: "end", title: "End" }],
  edges: [{ from: "s", to: middle[0].id }, ...middle.slice(1).map((n, i) => ({ from: middle[i].id, to: n.id })), { from: middle[middle.length - 1].id, to: "e" }],
});

async function toolResult(root, tag) {
  const file = path.join(root, `gs-${tag}.jsonl`);
  const [{ t }] = await waitForTruthy(() => { const z = readJsonl(file); return z.length ? z : null; }, `tool result ${tag}`);
  assert.ok(!t.startsWith("ERROR "), t);
  return JSON.parse(t);
}
// A background start from an orchestrator turn: message with announcement, the fake calls the tool.
async function background(base, root, chatId, short, tag, input = "go") {
  const r = await send(base, chatId, `/workflow:${short} GS[${tag}]:${JSON.stringify({ workflow: short, input, background: true })}§`);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  return (await toolResult(root, tag)).start;
}
const runFinished = (runId) => waitForTruthy(() => { const r = store.getWorkflowRunById(runId); return r && !store.workflowOpen(r) ? r : null; }, `run ${runId} finished`);
const runWaiting = (runId, pending) => waitForTruthy(() => {
  const r = store.getWorkflowRunById(runId);
  return r?.status === "waiting" && (r.cursor?.pending?.kind || "") === pending ? r : null;
}, `run ${runId} waiting (${pending || "question"})`);
const notices = (chatId) => store.listMessages(chatId).filter((m) => m.role === "user" && isCompletionNotice(m.text)).map((m) => m.text);
const graphHints = (chatId) => store.openHints(chatId).filter((h) => h.source === "graph-workflow");
const waitingNotes = (childId) => getMonitorEvents(0).filter((e) => e.chatId === childId && e.kind === "question" && String(e.requestId || "").startsWith("graph:"));
const turnFree = (chatId) => waitForTruthy(() => !running.has(chatId), `turn of ${chatId} finished`);

function stream(chatId) {
  const events = [];
  const reader = { write(row) { for (const z of String(row).split("\n")) if (z.startsWith("data: ")) { try { events.push(JSON.parse(z.slice(6))); } catch { /* no JSON */ } } } };
  if (!streams.has(chatId)) streams.set(chatId, new Set());
  streams.get(chatId).add(reader);
  return { events, runs: (startId) => events.filter((e) => e.subtype === "graph_run" && e.run?.startId === startId).map((e) => e.run), close: () => streams.get(chatId)?.delete(reader) };
}

// ── Question node, answer, end ───────────────────────────────────────────────────────────────────────────────────

test("question node: event with wait.kind \"question\", silent hint, notification at the child — the answer at the child continues and resolves it, at the end the completion notice as a turn of its own", async () => {
  await withAgentsServer(async ({ base, ws, chat, root }) => {
    newWorkflow(ws, "Color Choice", linear({ id: "a1", type: "ask", title: "Color", text: "Which color should it be?" }, { id: "n1", type: "instruction", title: "Paint", text: "PAINT {{answer}}" }));
    const s = stream(chat.id);
    try {
      const start = await background(base, root, chat.id, "color-choice", "a");
      const childId = start.chatId;
      const z = store.graphStart(start.startId);
      await turnFree(chat.id);
      await runWaiting(z.runId, "");
      // The view says what is being waited for — in the event and in the status tool.
      const ev = await waitForTruthy(() => s.runs(z.id).find((l) => l.state === "waiting"), "event waits");
      assert.equal(ev.wait.kind, "question");
      assert.equal(ev.wait.question, "Which color should it be?");
      assert.equal(ev.wait.nodeId, "a1");
      assert.equal(ev.chatId, childId);
      const snapshot = await raw(`${base}/api/chats/${chat.id}/graph-workflows?startId=${encodeURIComponent(z.id)}`);
      assert.equal(snapshot.body.runs[0].wait.kind, "question");
      // The silent hint — the orchestrator does NOT start for it.
      const h = graphHints(chat.id);
      assert.equal(h.length, 1, JSON.stringify(h));
      assert.match(h[0].text, /Dein Graph-Workflow „Color Choice“ im Hintergrund wartet auf den Menschen \(Frage-Knoten\): Which color should it be\?\. Du antwortest nicht/);
      assert.ok(!running.has(chat.id), "the hint does not wake");
      // The notification at the child chat (bell and push of kind "question").
      const [note] = waitingNotes(childId);
      assert.ok(note, "notification at the child chat");
      assert.equal(note.title, "Wartet: Color Choice");
      assert.equal(note.body, "Which color should it be?");
      assert.ok(!note.resolved);

      // The human answers in the child chat — the run continues, the notification is resolved.
      assert.equal((await send(base, childId, "Blue")).status, 202);
      assert.equal((await runFinished(z.runId)).status, "done");
      assert.equal(waitingNotes(childId)[0].resolved, true, "the notification is resolved");
      assert.equal(waitingNotes(childId).length, 1, "exactly one notification");
      // The completion notice: a turn of its own of the orchestrator, stored as a system message (role user, <task-notification>).
      const [m] = await waitForTruthy(() => { const l = notices(chat.id); return l.length ? l : null; }, "CompletionNotice");
      assert.match(m, /^<task-notification>\n<task-id>gs-/);
      assert.match(m, /<tool-use-id>toolu_gs_a<\/tool-use-id>/);
      assert.match(m, /<status>completed<\/status>/);
      assert.match(m, /<name>Color Choice<\/name>/);
      assert.match(m, /<summary>Graph-Workflow "Color Choice" completed<\/summary>/);
      assert.match(m, /<result>ERLEDIGT .*PAINT Blue/);
      assert.match(m, new RegExp(`<diagnostics>Child chat ${childId}, run ${z.runId}, steps `));
      const file = m.match(/<output-file>([^<]+)<\/output-file>/)[1];
      const content = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepEqual([content.startId, content.status, content.childChatId, content.runId], [z.id, "completed", childId, z.runId]);
      assert.match(content.lastOutput, /PAINT Blue/);
      const turn = await waitForTruthy(() => readJsonl(path.join(root, "prompts.jsonl")).map((p) => p.text).find((t) => t.includes("<task-notification>")), "completion-notice turn");
      assert.match(turn, /cbase-hint[^>]*source="graph-workflow"/, "the turn carries the silent hint");
      await turnFree(chat.id);
      assert.deepEqual(graphHints(chat.id), [], "consumed");
      assert.deepEqual(backgroundWork(chat.id), []);
      assert.equal(s.runs(z.id).at(-1).state, "finished");
      assert.equal(notices(chat.id).length, 1, "exactly one completion notice");
    } finally { s.close(); }
  }, { claude });
});

// ── Round cap and review ─────────────────────────────────────────────────────────────────────────────────────────

test("round cap: \"noch 2\" continues, the next cap is a NEW wait (second notification, the first resolved); \"abschließen\" ends with stopped", async () => {
  await withAgentsServer(async ({ base, ws, chat, root }) => {
    newWorkflow(ws, "Cycle Run", {
      nodes: [{ id: "s", type: "start", title: "Start" }, { id: "n1", type: "instruction", title: "There", text: "THERE", maxVisits: 1 },
        { id: "n2", type: "instruction", title: "Back", text: "BACK", maxVisits: 1 }, { id: "e", type: "end", title: "End" }],
      edges: [{ from: "s", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "n1" }],
    });
    const s = stream(chat.id);
    try {
      const start = await background(base, root, chat.id, "cycle-run", "a");
      const childId = start.chatId;
      const z = store.graphStart(start.startId);
      const r1 = await runWaiting(z.runId, "cap");
      const ev = await waitForTruthy(() => s.runs(z.id).find((l) => l.wait?.kind === "cap"), "event cap");
      assert.equal(ev.state, "waiting");
      assert.equal(ev.wait.cap, 1);
      assert.match(ev.wait.question, /^Runden-Deckel erreicht/);
      await waitForTruthy(() => waitingNotes(childId).length === 1, "first notification");
      assert.equal((await send(base, childId, "noch 2")).status, 202);
      await waitForTruthy(() => { const r = store.getWorkflowRunById(z.runId); return r.status === "waiting" && r.step > r1.step ? r : null; }, "second cap");
      const [first, second] = await waitForTruthy(() => { const l = waitingNotes(childId); return l.length === 2 ? l : null; }, "second notification");
      assert.equal(first.resolved, true, "the first wait is resolved");
      assert.ok(!second.resolved);
      assert.notEqual(first.requestId, second.requestId);
      assert.equal(graphHints(chat.id).length, 2, "one hint per wait");
      assert.equal((await send(base, childId, "abschließen")).status, 202);
      assert.equal((await runFinished(z.runId)).status, "cancelled");
      const [m] = await waitForTruthy(() => { const l = notices(chat.id); return l.length ? l : null; }, "CompletionNotice");
      assert.match(m, /<status>stopped<\/status>/);
      assert.match(m, /<summary>Graph-Workflow "Cycle Run" was stopped<\/summary>/);
      assert.equal(waitingNotes(childId)[1].resolved, true);
      await turnFree(chat.id);
    } finally { s.close(); }
  }, { claude });
});

test("review: hint without a notification of its own (the review reports itself), \"passt\" at the child runs to the end — completion notice completed", async () => {
  await withAgentsServer(async ({ base, ws, chat, root }) => {
    newWorkflow(ws, "Check Run", {
      nodes: [{ id: "s", type: "start", title: "Start" }, { id: "n1", type: "instruction", title: "Build", text: "BUILD" },
        { id: "r1", type: "review", title: "Human checks" }, { id: "e", type: "end", title: "End" }],
      edges: [{ from: "s", to: "n1" }, { from: "n1", to: "r1" }, { from: "r1", to: "e", branch: "ok" }, { from: "r1", to: "n1", branch: "issues" }],
    });
    const s = stream(chat.id);
    try {
      const start = await background(base, root, chat.id, "check-run", "a");
      const childId = start.chatId;
      const z = store.graphStart(start.startId);
      await runWaiting(z.runId, "review");
      const ev = await waitForTruthy(() => s.runs(z.id).find((l) => l.wait?.kind === "review"), "event review");
      assert.equal(ev.wait.round, 1);
      await waitForTruthy(() => graphHints(chat.id).length === 1, "Hint");
      assert.match(graphHints(chat.id)[0].text, /\(Review\)/);
      assert.deepEqual(waitingNotes(childId), [], "no double report");
      assert.ok(getMonitorEvents(0).some((e) => e.chatId === childId && e.kind === "review"), "the review notification itself");
      assert.equal((await send(base, childId, "passt")).status, 202);
      assert.equal((await runFinished(z.runId)).status, "done");
      const [m] = await waitForTruthy(() => { const l = notices(chat.id); return l.length ? l : null; }, "CompletionNotice");
      assert.match(m, /<status>completed<\/status>/);
      await turnFree(chat.id);
    } finally { s.close(); }
  }, { claude });
});

// ── Stop ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test("stop: no notice via the tool; by hand \"stopped\" — also for a row that still waited for the lock", async () => {
  await withAgentsServer(async ({ base, ws, chat, root }) => {
    newWorkflow(ws, "Stop Run", linear({ id: "a1", type: "ask", title: "Question", text: "Continue?" }));
    const a = await background(base, root, chat.id, "stop-run", "a", "one");
    const za = store.graphStart(a.startId);
    await runWaiting(za.runId, "");
    await turnFree(chat.id);
    // B waits for the lock that A holds — the human stops the waiting row (no run).
    const b = await background(base, root, chat.id, "stop-run", "b", "two");
    assert.equal(b.state, "waiting_lock", JSON.stringify(b));
    await turnFree(chat.id);
    assert.equal((await stop(base, chat.id, b.startId, "human")).status, 200);
    const [mb] = await waitForTruthy(() => { const l = notices(chat.id); return l.length ? l : null; }, "completion notice B");
    assert.match(mb, new RegExp(`<task-id>${b.startId}</task-id>`));
    assert.match(mb, /<status>stopped<\/status>/);
    assert.match(mb, /not started/);
    await turnFree(chat.id);
    // A: the agent stops itself — no completion notice, the wait is resolved.
    assert.equal((await stop(base, chat.id, a.startId, "agent")).status, 200);
    assert.equal((await runFinished(za.runId)).status, "cancelled");
    assert.equal(waitingNotes(za.childChatId)[0].resolved, true);
    assert.deepEqual(backgroundWork(chat.id), []);
    // C: runs, the human stops it — the notice names the run.
    const c = await background(base, root, chat.id, "stop-run", "c", "three");
    const zc = store.graphStart(c.startId);
    await runWaiting(zc.runId, "");
    await turnFree(chat.id);
    assert.equal((await stop(base, chat.id, c.startId, "human")).status, 200);
    const all = await waitForTruthy(() => { const l = notices(chat.id); return l.length >= 2 ? l : null; }, "completion notice C");
    await turnFree(chat.id);
    assert.equal(all.length, 2, "B and C — not A");
    assert.match(all[1], new RegExp(`<task-id>${c.startId}</task-id>`));
    assert.match(all[1], new RegExp(`run ${zc.runId}`));
    assert.ok(!notices(chat.id).some((t) => t.includes(a.startId)), "no notice after the agent's stop");
  }, { claude });
});

// ── Permission ───────────────────────────────────────────────────────────────────────────────────────────────────

test("permission: an open request in the child chat turns the running run into \"waiting\" (kind permission) — the decision via /permission-decision ends the wait", async () => {
  await withAgentsServer(async ({ base, ws, chat, root }) => {
    newWorkflow(ws, "Perm Run", linear({ id: "n1", type: "instruction", title: "Clean up", text: "APPROVAL please" }));
    // Asking mode (the child chat inherits it): under bypassPermissions no run is offered cbase_permission_prompt.
    await raw(`${base}/api/chats/${chat.id}`, "PATCH", { permissionMode: "default" });
    const s = stream(chat.id);
    try {
      const start = await background(base, root, chat.id, "perm-run", "a");
      const childId = start.chatId;
      const z = store.graphStart(start.startId);
      const ev = await waitForTruthy(() => s.runs(z.id).find((l) => l.wait?.kind === "permission"), "event permission");
      assert.equal(ev.state, "waiting");
      assert.equal(ev.run.status, "running", "the run itself runs");
      assert.equal(ev.wait.tool, "Bash");
      assert.match(ev.wait.input, /rm -rf site/);
      assert.ok(ev.wait.requestId);
      const [note] = await waitForTruthy(() => { const l = waitingNotes(childId); return l.length ? l : null; }, "notification");
      assert.ok(!note.resolved);
      await waitForTruthy(() => graphHints(chat.id).length === 1, "Hint");
      const d = await raw(`${base}/api/chats/${childId}/permission-decision`, "POST", { requestId: ev.wait.requestId, behavior: "allow" });
      assert.equal(d.status, 200, JSON.stringify(d.body));
      const further = await waitForTruthy(() => s.runs(z.id).find((l, i, all) => i > all.indexOf(ev) && l.state === "running"), "event running again");
      assert.equal(further.wait, null);
      assert.equal(waitingNotes(childId)[0].resolved, true);
      assert.equal((await runFinished(z.runId)).status, "done");
      assert.deepEqual(readJsonl(path.join(root, "perm.jsonl")).map((p) => p.behavior), ["allow"]);
      await waitForTruthy(() => notices(chat.id).length === 1, "CompletionNotice");
      await turnFree(chat.id);
      // The completion notice is no step — the orchestrator asks for no permission (otherwise this turn would hang on it until it was
      // refused: twice 120 s).
      assert.deepEqual(store.listMessages(chat.id).filter((m) => m.role === "approval").map((m) => m.text), [], "the orchestrator itself asked for a permission");
    } finally { s.close(); }
  }, { claude });
});

// ── Child deleted ────────────────────────────────────────────────────────────────────────────────────────────────

test("child deleted: the row becomes \"stopped\" (of \"erase\", without child), the orchestrator gets a hint, no completion notice", async () => {
  await withAgentsServer(async ({ base, ws, chat, root }) => {
    newWorkflow(ws, "Gone Run", linear({ id: "a1", type: "ask", title: "Question", text: "Still there?" }));
    const s = stream(chat.id);
    try {
      const start = await background(base, root, chat.id, "gone-run", "a");
      const childId = start.chatId;
      const z = store.graphStart(start.startId);
      await runWaiting(z.runId, "");
      await turnFree(chat.id);
      await waitForTruthy(() => waitingNotes(childId).length === 1, "notification");
      assert.equal((await raw(`${base}/api/chats/${childId}`, "DELETE")).status, 200);
      const fresh = store.graphStart(z.id);
      assert.deepEqual([fresh.status, fresh.stoppedOf, fresh.childChatId], ["stopped", "erase", null]);
      assert.equal(s.runs(z.id).at(-1).state, "stopped");
      assert.equal(s.runs(z.id).at(-1).chatId, chat.id, "without a child the view shows the chat of the start");
      assert.ok(graphHints(chat.id).some((h) => h.text === "Der Mensch hat den Hintergrund-Lauf „Gone Run“ gelöscht."));
      assert.equal(waitingNotes(childId)[0].resolved, true);
      assert.deepEqual(backgroundWork(chat.id), []);
      assert.deepEqual(notices(chat.id), [], "no completion notice");
      assert.ok(!running.has(chat.id), "the hint does not wake");
    } finally { s.close(); }
  }, { claude });
});

// ── Shape ────────────────────────────────────────────────────────────────────────────────────────────────────────

test("graphCompletionNotice: failed with note, result truncated, worktree with branch, without a call block no <tool-use-id>", () => {
  const z = { id: "gs-1", workflowName: "W <x>", childChatId: "k1", callId: "", worktreePath: "/tmp/wt", worktreeInfo: JSON.stringify({ branch: "cbase/graph-1" }), reason: "", status: "started" };
  const t = graphCompletionNotice(z, { status: "failed", run: { id: "r1", step: 2, total: 3 }, note: "Step broken\nmore", result: "x".repeat(9000), outputPath: "/o/graph-gs-1.json" });
  assert.ok(isCompletionNotice(t));
  assert.ok(!t.includes("<tool-use-id>"));
  assert.match(t, /<summary>Graph-Workflow "W &lt;x&gt;" failed: Step broken<\/summary>/);
  assert.match(t, /\[… truncated — the full output is in the output file\]<\/result>/);
  assert.match(t, /<diagnostics>Child chat k1, run r1, steps 2\/3\. Worktree with changes stays: \/tmp\/wt \(branch cbase\/graph-1\)\.<\/diagnostics>/);
  assert.match(t, /<note>This is a system message about your graph workflow in the background/);
});
