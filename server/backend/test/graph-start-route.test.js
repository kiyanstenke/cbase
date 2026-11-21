// Graph starts: POST /api/chats/:id/graph-workflows/start earmarks ONLY on announcement, every start is visible through
// list, stop and the `graph_run` event, and the close path clears the rows.
//
// Main seam via `withAgentsServer`: the fake main agent calls `cbase_workflow_start` through the REAL cbase MCP server in a
// turn ("GS[<tag>]:{json}§"), stores the result under `gs-<tag>` and then holds at the gate ("GATE:<x>"). The input of the
// turn carries its announcement via `deliverUserPrompt(…, { announcement })`. The refusals are driven by the test directly
// at the route WHILE the turn stands at the gate (over MCP only the text would come back, not the `reason`).
//
// Counter-tests (which sabotage turns which test red):
//   - put the idempotency (point 8) behind the "open" check (point 7)  => "main seam" red (the same start again gives 409
//     `open` instead of 200 `already`);
//   - drop `store.deleteGraphStartsFor(id)` in chats/erase.js:tidyUp  => "delete" red;
//   - drop the comparison via the CURRENT short name  => "main seam" red (after renaming 403 `announcement`).

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import * as store from "../electron/server/store.js";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import { streams } from "../electron/server/runtime/sse.js";
import { inputWithAttachments, graphRunView } from "../electron/server/workflows/graph-start.js";

const claude = fakeClaude({
  main: `
  const tag = (String(text).match(/GATE:(\\w+)/) || [])[1] || ("t" + turn);
  const g = text.indexOf("GS[");
  if (g >= 0) {
    const gtag = text.slice(g + 3, text.indexOf("]:", g));
    const args = JSON.parse(text.slice(text.indexOf("]:", g) + 2, text.indexOf("§", g)));
    const id = "toolu_gs_" + gtag;
    say({ type: "assistant", message: { id: "a-" + gtag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_workflow_start", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_workflow_start", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); }
    catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    fs.writeFileSync(path.join(LOCATION, "gs-" + gtag), t);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  if (String(text).includes("GATE:")) await gate(tag);
  finished();
  say({ type: "result", result: "ok " + tag, session_id: "s-main" });`,
});

// Raw sending - status and body are the statement here.
async function raw(url, method = "GET", body = undefined) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json", Connection: "close" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const startAt = (base, chatId, body) => raw(`${base}/api/chats/${chatId}/graph-workflows/start`, "POST", body);
const stop = (base, chatId, startId, body = {}) => raw(`${base}/api/chats/${chatId}/graph-workflows/${encodeURIComponent(startId)}/stop`, "POST", body);

const entry = (w, shortName) => ({ workflowId: w.id, shortName, name: w.name });
const announcement = (id, workflows, attachments = []) => ({ id, workflows, attachments });
const deliver = (chatId, text, a) =>
  deliverUserPrompt(store.getChat(chatId), { prompt: text, display: text, cause: "user", ...(a ? { announcement: a } : {}) });
const newWorkflow = (ws, name, createdAt) =>
  store.createWorkflow({ id: crypto.randomUUID(), workspaceId: ws.id, name, createdAt, updatedAt: createdAt });
const newChat = (base, ws) => json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({
  workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions",
}) });

// The stream of a chat, recorded in-process (no open socket that the finally would have to close).
function stream(chatId) {
  const events = [];
  const reader = { write(row) { for (const z of String(row).split("\n")) if (z.startsWith("data: ")) { try { events.push(JSON.parse(z.slice(6))); } catch { /* not JSON */ } } } };
  if (!streams.has(chatId)) streams.set(chatId, new Set());
  streams.get(chatId).add(reader);
  return { events, close: () => streams.get(chatId)?.delete(reader) };
}
const graphRuns = (events, startId) => events.filter((e) => e.type === "harness" && e.subtype === "graph_run" && e.run?.startId === startId).map((e) => e.run);

async function toolResult(root, tag) {
  const file = path.join(root, `gs-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  const t = fs.readFileSync(file, "utf8");
  assert.ok(!t.startsWith("ERROR "), t);
  return JSON.parse(t);
}

// ── Units ────────────────────────────────────────────────────────────────────────────────────────────────────

test("inputWithAttachments: without attachments the text, with attachments the same list as the manual start", () => {
  assert.equal(inputWithAttachments("please", []), "please");
  assert.equal(inputWithAttachments("please"), "please");
  assert.equal(inputWithAttachments("please", ["/a/b.png", "", 3, "/c.pdf"]),
    "please\n\n[Attached files — read them first with the Read tool:]\n- /a/b.png\n- /c.pdf");
  assert.equal(inputWithAttachments("", ["/a.png"]), "[Attached files — read them first with the Read tool:]\n- /a.png");
});

// ── Main seam ────────────────────────────────────────────────────────────────────────────────────────────────────

test("main seam: the main agent earmarks on announcement (201, row, event); each refusal with its reason; idempotency; list; stop", async () => {
  await withAgentsServer(async ({ base, ws, chat, root, gate, waitForIdle }) => {
    const ship = newWorkflow(ws, "Order → Ship", 1000);
    const review = newWorkflow(ws, "Review", 2000);
    const s = stream(chat.id);
    try {
      deliver(chat.id, `Go GS[a]:{"workflow":"order-ship","input":"please deliver"}§ GATE:a`,
        announcement("an1", [entry(ship, "order-ship"), entry(review, "review")], ["/tmp/creation.png"]));
      const r = await toolResult(root, "a");
      await gate.reached("a");
      const { start } = r;
      assert.equal(start.state, "earmarked");
      assert.equal(start.name, "Order → Ship");
      assert.equal(start.shortName, "order-ship");
      assert.equal(start.workflowId, ship.id);
      assert.equal(start.input, "please deliver");
      assert.equal(start.chatId, chat.id);
      assert.equal(start.background, false);
      assert.equal(start.run, null);
      assert.equal(start.endedAt, null);
      assert.deepEqual(r.alreadyStarted, []);
      assert.match(r.hint, /Vorgemerkt/);
      const row = store.graphStart(start.startId);
      assert.equal(row.status, "earmarked");
      assert.equal(row.announcementId, "an1");
      assert.equal(row.callId, "toolu_gs_a", "the call block of the tool");
      assert.deepEqual(row.attachments, ["/tmp/creation.png"], "the attachments of the announcement");
      await waitForTruthy(() => graphRuns(s.events, start.startId).length >= 1, "event graph_run");
      assert.equal(graphRuns(s.events, start.startId)[0].state, "earmarked");

      // 8. The same start again - via the short name, the id, uppercase, with "/workflow:" in front.
      for (const workflow of ["order-ship", ship.id, "/workflow:Order-Ship"]) {
        const b = await startAt(base, chat.id, { workflow, input: "please deliver" });
        assert.equal(b.status, 200, `${workflow}: ${JSON.stringify(b.body)}`);
        assert.equal(b.body.already, true);
        assert.equal(b.body.start.startId, start.startId);
      }
      // 7. Another foreground start (other input, other workflow) is open.
      for (const body of [{ workflow: "order-ship", input: "different" }, { workflow: "review" }]) {
        const o = await startAt(base, chat.id, body);
        assert.equal(o.status, 409, JSON.stringify(o.body));
        assert.equal(o.body.reason, "open");
        assert.match(o.body.error, /„Order → Ship“/);
      }
      // 3. Not announced - the text names the announced ones.
      const no = await startAt(base, chat.id, { workflow: "nope" });
      assert.equal(no.status, 403);
      assert.equal(no.body.reason, "announcement");
      assert.match(no.body.error, /Angesagt: order-ship, review\./);
      // Form.
      assert.equal((await startAt(base, chat.id, {})).body.reason, "workflow");
      assert.equal((await startAt(base, chat.id, { workflow: "review", input: 3 })).body.reason, "input");
      assert.equal((await startAt(base, chat.id, { workflow: "review", background: "yes" })).body.reason, "form");
      // 5. Too long (checked before 7: otherwise it would say "open"); exactly at the cap it is not too long.
      const lang = await startAt(base, chat.id, { workflow: "order-ship", input: "x".repeat(16001) });
      assert.equal(lang.status, 400);
      assert.equal(lang.body.reason, "input");
      assert.equal((await startAt(base, chat.id, { workflow: "order-ship", input: "x".repeat(16000) })).body.reason, "open");
      // 6. Worktree only with a project - this chat has none (project without repo, creating and cleaning up:
      //    graph-worktree-run.test.js; the background: graph-background.test.js).
      const wt = await startAt(base, chat.id, { workflow: "order-ship", worktree: true });
      assert.equal(wt.status, 400);
      assert.equal(wt.body.reason, "project");
      assert.equal(wt.body.error, "Ein eigener Worktree braucht ein Projekt — dieser Chat hat keins. Starte ohne worktree.");
      // Renamed between sending and call - the CURRENT short name hits via the id, that of the announcement still does too.
      store.updateWorkflow(ship.id, { name: "Renamed" });
      for (const workflow of ["renamed", "order-ship"]) {
        const b = await startAt(base, chat.id, { workflow, input: "please deliver" });
        assert.equal(b.status, 200, `${workflow}: ${JSON.stringify(b.body)}`);
        assert.equal(b.body.already, true);
      }
      // 4. The id is no longer in the effective set (deleted) - checked before "input" and "open".
      store.deleteWorkflow(review.id);
      const way = await startAt(base, chat.id, { workflow: "review", input: "x".repeat(16001) });
      assert.equal(way.status, 404);
      assert.equal(way.body.reason, "name");
      assert.match(way.body.error, /„Review“/);

      // List and single query.
      const list = await raw(`${base}/api/chats/${chat.id}/graph-workflows`);
      assert.equal(list.status, 200);
      assert.deepEqual(list.body.runs.map((l) => l.startId), [start.startId], "exactly one row - the idempotency created no second one");
      const one = await raw(`${base}/api/chats/${chat.id}/graph-workflows?startId=${encodeURIComponent(start.startId)}`);
      assert.equal(one.body.runs[0].startId, start.startId);
      const foreign = await raw(`${base}/api/chats/${chat.id}/graph-workflows?startId=gs-never`);
      assert.equal(foreign.status, 404);
      assert.equal(foreign.body.reason, "unknown");
      assert.equal((await stop(base, chat.id, "gs-never")).body.reason, "unknown");
      const wrongOf = await stop(base, chat.id, start.startId, { from: "robot" });
      assert.equal(wrongOf.status, 400);
      assert.equal(wrongOf.body.reason, "from");

      // Stop (without `from` "human" applies), a second one is already over. STILL in the turn: the turn end redeems an
      // earmarked start - what is stopped here is the earmark, not a run.
      const st = await stop(base, chat.id, start.startId);
      assert.equal(st.status, 200, JSON.stringify(st.body));
      assert.equal(st.body.run.state, "stopped");
      assert.equal(st.body.run.stoppedOf, "human");
      assert.equal(typeof st.body.run.endedAt, "number");
      assert.equal(store.graphStart(start.startId).status, "stopped");
      await waitForTruthy(() => graphRuns(s.events, start.startId).some((l) => l.state === "stopped"), "event for the stop");
      const two = await stop(base, chat.id, start.startId);
      assert.equal(two.status, 409);
      assert.equal(two.body.reason, "to_end");

      gate.open("a");
      await waitForIdle();
      // The stopped earmark does not start at the turn end.
      assert.equal(store.graphStart(start.startId).status, "stopped");
      assert.deepEqual(store.listWorkflowRuns({ chatId: chat.id }), []);
      // 2. Without a turn nothing starts - not even on the announcement of the previous one.
      const without = await startAt(base, chat.id, { workflow: "order-ship", input: "please deliver" });
      assert.equal(without.status, 409);
      assert.equal(without.body.reason, "no_turn");
    } finally {
      s.close();
    }
  }, { claude });
});

test("bundle with two announcements: the start belongs to the announcement that names it; after a stop a new input starts, alreadyStarted names the stopped one", async () => {
  await withAgentsServer(async ({ base, ws, chat, root, gate, waitForIdle }) => {
    const ship = newWorkflow(ws, "Order → Ship", 1000);
    const review = newWorkflow(ws, "Review", 2000);
    deliver(chat.id, "Lead-in GATE:b0");
    await gate.reached("b0");
    assert.equal(deliver(chat.id, "First", announcement("q1", [entry(ship, "order-ship")])).queued, true);
    assert.equal(deliver(chat.id, `GS[b]:{"workflow":"review","input":"R"}§ GATE:b1`, announcement("q2", [entry(review, "review")])).queued, true);
    gate.open("b0");
    const r = await toolResult(root, "b");
    await gate.reached("b1");
    const first = store.graphStart(r.start.startId);
    assert.equal(first.announcementId, "q2", "only q2 names \"review\"");
    assert.equal(first.workflowId, review.id);
    // The other announced workflow is reachable (403 would be "not announced") - only already taken in the foreground.
    assert.equal((await startAt(base, chat.id, { workflow: "order-ship", input: "S" })).body.reason, "open");
    const st = await stop(base, chat.id, first.id, { from: "agent" });
    assert.equal(st.body.run.stoppedOf, "agent");
    // The stopped one counts for the idempotency (only "dismissed" does not) - the same start again is `already`.
    const again = await startAt(base, chat.id, { workflow: "review", input: "R" });
    assert.equal(again.status, 200);
    assert.equal(again.body.already, true);
    assert.equal(again.body.start.state, "stopped");
    const fresh = await startAt(base, chat.id, { workflow: "review", input: "R2", callId: "toolu_x" });
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
    assert.deepEqual(fresh.body.alreadyStarted.map((l) => [l.startId, l.state]), [[first.id, "stopped"]]);
    assert.equal(store.graphStart(fresh.body.start.startId).callId, "toolu_x");
    assert.deepEqual((await raw(`${base}/api/chats/${chat.id}/graph-workflows`)).body.runs.map((l) => l.startId),
      [fresh.body.start.startId, first.id], "newest first");
    gate.open("b1");
    await waitForIdle();
  }, { claude });
});

test("run view: started follows the run, without a run stopped; the stop of an open run cancels it", async () => {
  await withAgentsServer(async ({ base, ws }) => {
    const ship = newWorkflow(ws, "Order → Ship", 1000);
    const c = await newChat(base, ws);
    const row = (status, runId = null) => {
      const z = store.createGraphStart({ id: `gs-${crypto.randomUUID()}`, chatId: c.id, workflowId: ship.id, workflowName: ship.name,
        shortName: "order-ship", input: "x".repeat(500), status });
      return runId ? store.changeGraphStart(z.id, { runId }) : z;
    };
    const runItem = (status) => {
      const run = store.startWorkflowRun({ id: crypto.randomUUID(), chatId: c.id, workflowId: ship.id, workflowName: ship.name, workspaceId: ws.id });
      return status === "running" ? run : store.updateWorkflowRunById(run.id, { status });
    };
    for (const [status, state] of [["done", "finished"], ["failed", "failed"], ["cancelled", "stopped"], ["running", "running"], ["waiting", "waiting"]]) {
      const run = runItem(status);
      const view = graphRunView(row("started", run.id));
      assert.equal(view.state, state, status);
      assert.equal(view.run.id, run.id);
      assert.equal(view.endedAt === null, ["running", "waiting"].includes(state), `${status}: endedAt only at the end`);
    }
    const withoutRun = graphRunView(row("started", "wr-never"));
    assert.equal(withoutRun.state, "stopped");
    assert.equal(withoutRun.run, null);
    for (const s of ["earmarked", "waiting_lock", "waiting_storage", "dismissed", "stopped"]) {
      const z = row(s);
      assert.equal(graphRunView(z).state, s);
      // The end of a run wakes the waiting queue: a left-over `waiting_lock` row would start a run in THIS chat at the
      // stop below. The view is checked, the row gets out of the way.
      if (s !== "dismissed" && s !== "stopped") store.changeGraphStart(z.id, { status: "dismissed" });
    }
    const short = row("earmarked");
    assert.equal(graphRunView(short).input.length, 400, "the view carries at most 400 characters of input");
    store.changeGraphStart(short.id, { status: "dismissed" });

    // The youngest run of the chat waits: the stop cancels it (cancelWorkflow).
    const open = row("started", store.getWorkflowRun(c.id).id);
    assert.equal(graphRunView(open).state, "waiting");
    const st = await stop(base, c.id, open.id, { from: "agent" });
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.equal(st.body.run.state, "stopped");
    assert.equal(st.body.run.stoppedOf, "agent");
    assert.equal(store.getWorkflowRun(c.id).status, "cancelled");
    assert.equal((await stop(base, c.id, open.id)).body.reason, "to_end");
    // An older, still "running" run that is not the youngest of the chat is not hit via cancelWorkflow.
    assert.equal((await stop(base, c.id, row("started", store.listWorkflowRuns({ chatId: c.id, status: "running" })[0].id).id)).body.reason, "to_end");
    // Cleanup: an open run without a driver would hold up the harness quiet forever.
    for (const r of store.listWorkflowRuns({ chatId: c.id })) if (store.workflowOpen(r)) store.updateWorkflowRunById(r.id, { status: "done" });
  }, { claude });
});

// A manager chat gets the lock (409, runs/manager-lock.js) before the route; the kind check is carried by a chat of a foreign
// kind. Every old app-agent chat (context/ingest/service/workflow) is read-only (runs/only-readable.js, 409 before the route) -
// so the kind check holds an unknown kind, the old service chat the lock.
test("kind: a chat of a foreign kind gets 403 - before any other check, even without a turn; a manager chat and an old app-agent chat the lock (409)", async () => {
  await withAgentsServer(async ({ base, ws }) => {
    const old = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "service", title: "Service", createdAt: Date.now(), updatedAt: Date.now() });
    const ra = await startAt(base, old.id, { workflow: "x" });
    assert.deepEqual([ra.status, ra.body.onlyReadable], [409, true], JSON.stringify(ra.body));
    const d = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "foreign", title: "Foreign", createdAt: Date.now(), updatedAt: Date.now() });
    const r = await startAt(base, d.id, { workflow: "x" });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "kind");
    assert.match(r.body.error, /Hauptagent eines Coding-Chats/);
    const m = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", title: "Manager", createdAt: Date.now(), updatedAt: Date.now() });
    const g = await startAt(base, m.id, { workflow: "x" });
    assert.equal(g.status, 409);
    assert.equal(g.body.managerLocked, true);
  }, { claude });
});

test("delete: the close path clears the starts of the chat, those of the neighbor stay", async () => {
  await withAgentsServer(async ({ base, ws }) => {
    const ship = newWorkflow(ws, "Order → Ship", 1000);
    const way = await newChat(base, ws);
    const neighbor = await newChat(base, ws);
    const create = (chatId) => store.createGraphStart({ id: `gs-${crypto.randomUUID()}`, chatId, workflowId: ship.id,
      workflowName: ship.name, shortName: "order-ship", status: "earmarked" });
    create(way.id);
    create(way.id);
    const stays = create(neighbor.id);
    assert.equal(store.graphStartsOf(way.id).length, 2);
    assert.equal((await raw(`${base}/api/chats/${way.id}`, "DELETE")).status, 200);
    assert.deepEqual(store.graphStartsOf(way.id), []);
    assert.deepEqual(store.graphStartsOf(neighbor.id).map((z) => z.id), [stays.id]);
  }, { claude });
});
