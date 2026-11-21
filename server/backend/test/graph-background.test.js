// Graph workflows in the background: `background: true` starts the workflow AT ONCE in a Coding chat of its own, the child chat
// (workflows/graph-start.js backgroundStart). It inherits the settings of the orchestrator, stands in no chat list
// (store/chats.js listChats), carries `parentChatId` (GET /api/chats/:id), reads only its own attachment folder (the attachments of
// the announcement are copied there) and follows the orchestrator: its open run is the orchestrator's background work (archive 409
// "graphWorkflow", runs/background.js setGraphSource), archiving it alone is not possible (400), and deleting the orchestrator stops
// it and takes it along (chats/routes.js DELETE -> stopKindRuns, chats/erase.js closeChats). `/stop` on the orchestrator lets it keep
// running. A child starts no further one in the background (400 `kind`). Two children under the same lock: the second waits
// (`waiting_lock`) and starts as soon as the first ends.
//
// Main seam via `withAgentsServer`. The fake main agent files every text under prompts.jsonl, on "GS[<tag>]:{json}§" calls
// `cbase_workflow_start` over the REAL cbase MCP server (result under `gs-<tag>.jsonl`), holds at "GATE:<x>" (outside a workflow step)
// or "HALT:<x>" (in the text of a step) at the gate and answers a step with "ERLEDIGT …", everything else with "Gestartet.".
//
// Counter-tests (each run once):
//   - the filter `id NOT IN (… graph_starts …)` struck from store/chats.js listChats => "main seam" red (the child chat is in the list);
//   - `setGraphSource(graphRunsOpen)` struck from server.js => "main seam" red (the archive accepts the orchestrator);
//   - `withChildren` bypassed in chats/erase.js closeChats => "main seam" red (the child chat survives its orchestrator);
//   - in wakeGraphStarts the chat of the row (the orchestrator) asked instead of the child chat => "lock" hangs: there the orchestrator
//     deliberately holds a turn at the gate while the first child ends — without it the probe would stay green.
// No deadline in the test itself: a hang reports every 30 s what it waits for.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import * as store from "../electron/server/store.js";
import { DIRS } from "../electron/server/app-state.js";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import { running } from "../electron/server/runs/state.js";
import { backgroundWork } from "../electron/server/runs/background.js";
import { streams } from "../electron/server/runtime/sse.js";

const MAIN = `
  fs.appendFileSync(path.join(LOCATION, "prompts.jsonl"), JSON.stringify({ text }) + "\\n");
  const step = String(text).includes("[cbase workflow");
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
  const hold = (String(text).match(/HALT:(\\w+)/) || [])[1];
  if (hold && step) await gate(hold);
  const wait = (String(text).match(/GATE:(\\w+)/) || [])[1];
  if (wait && !step) await gate(wait);
  finished();
  say({ type: "result", result: step ? "ERLEDIGT " + String(text).replace(/\\s+/g, " ").slice(0, 80) : "Gestartet.", session_id: "s-main" });`;

const claude = fakeClaude({ main: MAIN });

async function raw(url, method = "GET", body = undefined) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json", Connection: "close" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const send = (base, chatId, text) => raw(`${base}/api/chats/${chatId}/message`, "POST", { text });
const startAt = (base, chatId, body) => raw(`${base}/api/chats/${chatId}/graph-workflows/start`, "POST", body);
const archive = (base, chatId) => raw(`${base}/api/chats/${chatId}/archive`, "PUT", { archived: true });

// A workflow `s -> n1 -> e` without a completion gate (a verdict would be a oneshot, which these fakes do not play).
function newWorkflow(ws, name, text = "WORK") {
  const now = Date.now();
  const w = store.createWorkflow({ id: crypto.randomUUID(), workspaceId: ws.id, name, createdAt: now, updatedAt: now, graph: {
    nodes: [{ id: "s", type: "start", title: "Start" }, { id: "n1", type: "instruction", title: "Step", text }, { id: "e", type: "end", title: "End" }],
    edges: [{ from: "s", to: "n1" }, { from: "n1", to: "e" }],
  } });
  return store.updateWorkflow(w.id, { run: { doneAll: false } });
}
async function toolResults(root, tag, n = 1) {
  const file = path.join(root, `gs-${tag}.jsonl`);
  const rows = await waitForTruthy(() => { const z = readJsonl(file); return z.length >= n ? z : null; }, `tool result ${tag} (${n})`);
  return rows.map(({ t }) => {
    assert.ok(!t.startsWith("ERROR "), t);
    return JSON.parse(t);
  });
}
const rowInState = (startId, status) => waitForTruthy(() => { const z = store.graphStart(startId); return z?.status === status ? z : null; }, `row ${startId} -> ${status}`);
const runFinished = (runId) => waitForTruthy(() => { const r = store.getWorkflowRunById(runId); return r && !store.workflowOpen(r) ? r : null; }, `run ${runId} finished`);
const stepTexts = (runId) => store.listRunSteps(runId).filter((s) => s.kind === "step").map((s) => JSON.stringify(s.detail));
const listenIds = async (base, ws, archive = "including") => (await json(`${base}/api/chats?workspaceId=${ws.id}&archive=${archive}`)).map((c) => c.id);

function stream(chatId) {
  const events = [];
  const reader = { write(row) { for (const z of String(row).split("\n")) if (z.startsWith("data: ")) { try { events.push(JSON.parse(z.slice(6))); } catch { /* no JSON */ } } } };
  if (!streams.has(chatId)) streams.set(chatId, new Set());
  streams.get(chatId).add(reader);
  return { events, close: () => streams.get(chatId)?.delete(reader) };
}

// ── Main seam ────────────────────────────────────────────────────────────────────────────────────────────────────

test("main seam: child chat arises and runs, is missing from the list, carries parentChatId and the copied attachments; idempotency; /stop on the orchestrator lets it run; archive 409; deleting takes it along", async () => {
  await withAgentsServer(async ({ base, ws, chat, root, gate }) => {
    const w = newWorkflow(ws, "Back Ground", "BACK HALT:k");
    const orch = store.getChat(chat.id);
    // An attachment of the message lies in the attachment folder of the orchestrator — the announcement carries its absolute path.
    const attachment = path.join(DIRS.attachments, chat.id, "note.txt");
    fs.mkdirSync(path.dirname(attachment), { recursive: true });
    fs.writeFileSync(attachment, "NOTE-CONTENT");
    const s = stream(chat.id);
    try {
      const text = `In the background please GS[a]:{"workflow":"back-ground","input":"please at the back","background":true}§ GATE:o`;
      deliverUserPrompt(orch, { prompt: text, display: text, cause: "user",
        announcement: { id: "ann-h", workflows: [{ workflowId: w.id, shortName: "back-ground", name: w.name }], attachments: [attachment] } });
      const [r] = await toolResults(root, "a");
      await gate.reached("o");
      const { start } = r;
      assert.equal(start.background, true);
      assert.equal(start.state, "running", JSON.stringify(start));
      assert.notEqual(start.chatId, chat.id, "the run happens in the child chat");
      assert.match(r.hint, /Gestartet im Hintergrund \(eigener Chat\)\. Am Ende kommt eine <task-notification>/);
      const childId = start.chatId;
      const row = store.graphStart(start.startId);
      assert.equal(row.childChatId, childId);
      assert.equal(row.chatId, chat.id);
      assert.equal(row.status, "started");
      assert.equal(store.getWorkflowRunById(row.runId).chatId, childId, "the run belongs to the child chat");
      assert.ok(!store.getWorkflowRun(chat.id), "no workflow runs in the orchestrator");
      // Idempotency — the same call once more creates neither a row nor a child.
      const still = await startAt(base, chat.id, { workflow: "back-ground", input: "please at the back", background: true });
      assert.equal(still.status, 200, JSON.stringify(still.body));
      assert.equal(still.body.already, true);
      assert.equal(still.body.start.startId, start.startId);
      assert.equal(store.graphStartsOf(chat.id).length, 1);

      // The child chat: inherits the settings, is named like the workflow, without a project (the orchestrator has none), without a folder.
      const child = store.getChat(childId);
      assert.equal(child.kind, "normal");
      assert.equal(child.title, "Back Ground");
      assert.equal(child.titled, true);
      assert.equal(child.workspaceId, ws.id);
      assert.equal(child.projectId, null);
      assert.equal(child.folderId, null);
      for (const k of ["provider", "model", "permissionMode", "profile"]) assert.equal(child[k], orch[k], k);
      assert.equal((await json(`${base}/api/chats/${childId}`)).parentChatId, chat.id);
      assert.equal((await json(`${base}/api/chats/${chat.id}`)).parentChatId, null, "the field is always there");
      // Not in the chat list — on no archive page. Precondition: it has rows, otherwise its emptiness alone would keep it out.
      assert.ok(store.listMessages(childId).length > 0, "precondition: the child chat has rows");
      for (const page of ["without", "including", "only"]) assert.ok(!(await listenIds(base, ws, page)).includes(childId), page);
      assert.ok((await listenIds(base, ws)).includes(chat.id));

      // Its node turn runs — with the copied attachment (the child chat reads only its own folder).
      await gate.reached("k");
      assert.ok(running.has(childId), "the step of the child chat runs");
      const copy = path.join(DIRS.attachments, childId, "note.txt");
      assert.equal(fs.readFileSync(copy, "utf8"), "NOTE-CONTENT");
      assert.deepEqual(row.attachments, [copy]);
      const stepPrompt = readJsonl(path.join(root, "prompts.jsonl")).map((p) => p.text).find((t) => t.includes("BACK"));
      assert.ok(stepPrompt?.includes(copy), "the input names the new path");
      assert.ok(!stepPrompt.includes(attachment), "not that of the orchestrator");

      // The background work of the orchestrator — and the event on ITS stream with the child as run chat.
      assert.deepEqual(backgroundWork(chat.id).map((h) => [h.kind, h.startId, h.childChatId]), [["graphWorkflow", start.startId, childId]]);
      assert.ok(s.events.some((e) => e.subtype === "graph_run" && e.run?.startId === start.startId && e.run.chatId === childId), "event graph_run");

      // /stop on the orchestrator (its turn stands at the gate) lets the child run.
      assert.equal((await raw(`${base}/api/chats/${chat.id}/stop`, "POST")).status, 200);
      await waitForTruthy(() => !running.has(chat.id), "turn of the orchestrator finished");
      assert.ok(running.has(childId), "the step of the child keeps running");
      assert.equal(store.getWorkflowRunById(row.runId).status, "running");
      assert.equal(store.graphStart(start.startId).status, "started");

      // Archive: not the orchestrator while the child runs; never the child alone.
      const ar = await archive(base, chat.id);
      assert.equal(ar.status, 409, JSON.stringify(ar.body));
      assert.deepEqual(ar.body.open.map((o) => o.reason), ["graphWorkflow"]);
      assert.equal(ar.body.open[0].text, "Ein Graph-Workflow läuft im Hintergrund");
      const ak = await archive(base, childId);
      assert.equal(ak.status, 400);
      assert.match(ak.body.error, /Ein Hintergrund-Lauf wird nicht einzeln archiviert — archiviere den Chat, der ihn gestartet hat\./);
      assert.equal(store.getChat(chat.id).archivedAt, null);

      // Deleting the orchestrator: first the child run (cancelled, its turn stopped), then both chats and all rows.
      const del = await raw(`${base}/api/chats/${chat.id}`, "DELETE");
      assert.equal(del.status, 200, JSON.stringify(del.body));
      assert.equal((await raw(`${base}/api/chats/${childId}`)).status, 404);
      assert.equal((await raw(`${base}/api/chats/${chat.id}`)).status, 404);
      assert.equal(store.getWorkflowRunById(row.runId).status, "cancelled");
      assert.equal(store.graphStart(start.startId), null, "no row any more");
      assert.equal(store.graphStartOfChild(childId), null);
      assert.ok(!running.has(childId));
      assert.ok(!fs.existsSync(path.join(DIRS.attachments, childId)), "the attachment folder of the child is gone");
      assert.deepEqual(backgroundWork(chat.id), []);
      gate.open("k");
      gate.open("o");
    } finally { s.close(); }
  }, { claude });
});

// ── One level ────────────────────────────────────────────────────────────────────────────────────────────────────

test("child in child: a child chat starts no further one in the background (400 kind) — in the foreground it may", async () => {
  await withAgentsServer(async ({ base, ws, chat, root, gate }) => {
    newWorkflow(ws, "Short", "SHORT");
    const r0 = await send(base, chat.id, `/workflow:short GS[a]:{"workflow":"short","input":"one","background":true}§`);
    assert.equal(r0.status, 202, JSON.stringify(r0.body));
    const [r] = await toolResults(root, "a");
    const childId = r.start.chatId;
    const z = await rowInState(r.start.startId, "started");
    assert.equal((await runFinished(z.runId)).status, "done");
    assert.match(stepTexts(z.runId)[0], /SHORT/);
    // The human writes an announcement in the child chat (opened via the card); its turn stands at the gate.
    const r1 = await send(base, childId, "/workflow:short again GATE:x");
    assert.equal(r1.status, 202, JSON.stringify(r1.body));
    await gate.reached("x");
    const kk = await startAt(base, childId, { workflow: "short", input: "two", background: true });
    assert.equal(kk.status, 400, JSON.stringify(kk.body));
    assert.equal(kk.body.reason, "kind");
    assert.equal(kk.body.error, "Ein Hintergrund-Lauf startet keinen weiteren im Hintergrund — starte im Vordergrund.");
    assert.equal(store.graphStartsOf(childId).length, 0, "nothing created");
    const front = await startAt(base, childId, { workflow: "short", input: "three" });
    assert.equal(front.status, 201, JSON.stringify(front.body));
    assert.equal(front.body.start.background, false);
    assert.equal(front.body.start.chatId, childId);
    assert.equal((await raw(`${base}/api/chats/${childId}/graph-workflows/${encodeURIComponent(front.body.start.startId)}/stop`, "POST", {})).status, 200);
    gate.open("x");
    await waitForTruthy(() => !running.has(childId), "turn of the child finished");
  }, { claude });
});

// ── Waiting queue ────────────────────────────────────────────────────────────────────────────────────────────────

test("lock: two children on the same subject — the second waits (waiting_lock) and starts as soon as the first ends, even while the orchestrator runs", async () => {
  await withAgentsServer(async ({ base, ws, chat, root, gate }) => {
    newWorkflow(ws, "Lock Flow", "LOCK HALT:h");
    const r1 = await send(base, chat.id, `/workflow:lock-flow GS[a]:{"workflow":"lock-flow","input":"one","background":true}§`);
    assert.equal(r1.status, 202, JSON.stringify(r1.body));
    const [a] = await toolResults(root, "a");
    const za = await rowInState(a.start.startId, "started");
    await gate.reached("h");
    await waitForTruthy(() => !running.has(chat.id), "first turn of the orchestrator finished");
    // The second start: the same lock (without a project the workspace) — it waits. The orchestrator holds at the gate meanwhile.
    const r2 = await send(base, chat.id, `/workflow:lock-flow GS[b]:{"workflow":"lock-flow","input":"two","background":true}§ GATE:o`);
    assert.equal(r2.status, 202, JSON.stringify(r2.body));
    const [b] = await toolResults(root, "b");
    assert.equal(b.start.state, "waiting_lock", JSON.stringify(b.start));
    assert.match(b.hint, /^Angenommen im Hintergrund \(eigener Chat\) — er wartet auf „Lock Flow“ und startet dann von selbst\./);
    const zb = store.graphStart(b.start.startId);
    assert.notEqual(zb.childChatId, za.childChatId, "every start has its own child chat");
    assert.equal(zb.reason, "wartet auf „Lock Flow“", "the holder is the first child (it is named like the workflow)");
    assert.ok(!store.getWorkflowRun(zb.childChatId), "no run yet in the second child");
    assert.deepEqual(backgroundWork(chat.id).map((h) => h.startId), [za.id, zb.id], "both open, the waiting one included");
    await gate.reached("o");
    // The first child ends — its run end wakes the queue although the orchestrator is just running a turn.
    gate.open("h");
    assert.equal((await runFinished(za.runId)).status, "done");
    const gb = await rowInState(zb.id, "started");
    assert.ok(running.has(chat.id), "the orchestrator was still running when the second child started");
    assert.equal(store.getWorkflowRunById(gb.runId).chatId, zb.childChatId);
    assert.equal((await runFinished(gb.runId)).status, "done");
    assert.match(stepTexts(gb.runId)[0], /two/);
    assert.deepEqual(backgroundWork(chat.id), [], "both finished — nothing open any more");
    gate.open("o");
    await waitForTruthy(() => !running.has(chat.id), "second turn of the orchestrator finished");
  }, { claude });
});
