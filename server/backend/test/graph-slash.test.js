// `/workflow:` at the message route: a message with `/workflow:<short name>` is checked on sending (workflows/slash-workflow.js,
// called in runs/routes.js messageChatRoutes), rewritten for the model and carries its announcement - so that
// `cbase_workflow_start` succeeds in the same turn. A refusal stores nothing, assigns no title and starts no run. The typed
// `/name` of a dynamic workflow is covered by dynworkflows-slash.test.js.
//
// Main seam via `withAgentsServer`: the fake main agent stores EVERY text it gets under prompts.jsonl (so it shows what the
// model reads and that a refusal never reaches the CLI), calls `cbase_workflow_start` through the REAL cbase MCP server on
// "GS[<tag>]:{json}§" and stores the result under `gs-<tag>`; "GATE:<x>" holds it at the gate.
//
// Counter-tests (which sabotage turns which test red):
//   - drop `announcement: graph.announcement` from deliverUserPrompt in runs/routes.js  => "Success", "Two mentions" and "Queued" red
//     (the tool answers 403 `announcement`);
//   - drop the earmarked start from the "open" check in workflows/slash-workflow.js  => "Refusals" red;
//   - replace `graph.prompt` by `text`  => "Success" and "Two mentions" red (the CLI would see a leading `/workflow:`).

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import * as store from "../electron/server/store.js";
import { DIRS } from "../electron/server/app-state.js";
import { announcementText, graphSlash, mentions } from "../electron/server/workflows/slash-workflow.js";

const claude = fakeClaude({
  main: `
  fs.appendFileSync(path.join(LOCATION, "prompts.jsonl"), JSON.stringify({ text }) + "\\n");
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

async function raw(url, method = "GET", body = undefined) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json", Connection: "close" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const send = (base, chatId, body) => raw(`${base}/api/chats/${chatId}/message`, "POST", body);
const prompts = (root) => readJsonl(path.join(root, "prompts.jsonl")).map((z) => z.text);
const userRows = (chatId) => store.listMessages(chatId).filter((m) => m.role === "user").map((m) => m.text);

// A graph with a start node and a first step - the "First step" sentence comes from it.
const GRAPH = {
  nodes: [
    { id: "s", type: "start", title: "Start" },
    { id: "n1", type: "instruction", title: "Plan", text: "Plan the order.\nCarefully." },
    { id: "e", type: "end", title: "End" },
  ],
  edges: [{ from: "s", to: "n1" }, { from: "n1", to: "e" }],
};
const newWorkflow = (ws, name, { createdAt = Date.now(), projectId = null, description = "", graph = undefined } = {}) =>
  store.createWorkflow({ id: crypto.randomUUID(), workspaceId: ws.id, projectId, name, description, graph, createdAt, updatedAt: createdAt });
const newChat = (base, ws, extra = {}) => json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({
  workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions", ...extra,
}) });

async function toolResult(root, tag) {
  const file = path.join(root, `gs-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  const t = fs.readFileSync(file, "utf8");
  assert.ok(!t.startsWith("ERROR "), t);
  return JSON.parse(t);
}

// ── Units ────────────────────────────────────────────────────────────────────────────────────────────────────

test("mentions: lowercase, once per name, in order; empty without a mention", () => {
  assert.deepEqual(mentions("/workflow:Review please /workflow:order-ship, and /workflow:REVIEW."), ["review", "order-ship"]);
  assert.deepEqual(mentions(""), []);
  assert.deepEqual(mentions("path/workflow:x"), []);
});

// Quotes from the history stand as "> " lines BEFORE the own message (web quotes module, iOS chat view model quotes). A
// mention inside is no announcement by the human. Counter-test: counting quote lines => both tests red (unit: ["ship"];
// route: prompt rewritten, start 201, quote with an unknown name 404).
const quoted = (quote, own) => `${quote.split("\n").map((z) => `> ${z}`).join("\n")}\n\n${own}`;

test("mentions: a quote line never counts - the own lines do", () => {
  assert.deepEqual(mentions(quoted("If you like, start /workflow:ship afterwards - it builds and rolls out.", "What exactly would that do? Please do NOT start anything yet.")), []);
  assert.deepEqual(mentions(quoted("first /workflow:a\n/workflow:b", "/workflow:c please")), ["c"]);
  assert.deepEqual(mentions("  > indented /workflow:a\nand /workflow:b"), ["b"], "indented it is still a quote");
  assert.deepEqual(mentions("a > /workflow:b"), ["b"], "a \">\" in the middle of the line does not make it a quote");
});

test("quote lines at the route: a quoted /workflow: is no announcement, a quoted unknown name no refusal", async () => {
  await withAgentsServer(async ({ base, ws, chat, root, gate, waitForIdle }) => {
    newWorkflow(ws, "Ship", { createdAt: 1000, description: "ships it", graph: GRAPH });
    const text = quoted("If you like, start /workflow:ship afterwards - it builds and rolls out.", "What exactly would that do? Please do NOT start anything yet. GATE:z");
    const r = await send(base, chat.id, { text });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await gate.reached("z");
    const p = prompts(root).at(-1);
    assert.ok(!p.includes("[cbase: The human starts"), `the prompt was rewritten into the announcement: ${JSON.stringify(p.slice(0, 120))}`);
    const s = await raw(`${base}/api/chats/${chat.id}/graph-workflows/start`, "POST", { workflow: "ship", input: "x" });
    assert.equal(s.status, 403, `a quoted name released the start: ${JSON.stringify(s.body)}`);
    assert.equal(s.body.reason, "announcement");
    gate.open("z");
    await waitForIdle();

    const u = await send(base, chat.id, { text: quoted("A name like /workflow:deploy-prod would be conceivable.", "What do you mean?") });
    assert.equal(u.status, 202, `a quoted unknown name made the answer unsendable: ${JSON.stringify(u.body)}`);
    await waitForTruthy(() => prompts(root).length >= 2, "the second turn");
    await waitForIdle();
    assert.deepEqual(store.graphStartsOf(chat.id), []);
    assert.equal(userRows(chat.id).length, 2, "both answers are in the history");
  }, { claude });
});

test("announcementText: name, short name, description, first step (<= 400 characters, one line), message, instruction", () => {
  const t = announcementText([
    { name: "Order → Ship", shortName: "order-ship", description: "Ships it.", graph: GRAPH },
    { name: "Empty", shortName: "empty", description: "", graph: { nodes: [], edges: [] } },
    { name: "Lang", shortName: "lang", description: "x", graph: { nodes: [{ id: "s", type: "start" }, { id: "a", type: "instruction", text: "y".repeat(500) }], edges: [{ from: "s", to: "a" }] } },
  ], "/workflow:order-ship now");
  const rows = t.split("\n");
  assert.equal(rows[0], "[cbase: The human starts these graph workflows with /workflow:]");
  assert.equal(rows[1], "- \"Order → Ship\" (workflow: order-ship) — Ships it. First step: \"Plan\": Plan the order. Carefully.");
  assert.equal(rows[2], "- \"Empty\" (workflow: empty) — no description.", "without a first step the sentence is dropped");
  assert.equal(rows[3], `- "Lang" (workflow: lang) — x. First step: ${"y".repeat(399)}…`);
  assert.equal(rows[4], "[Their message]");
  assert.equal(rows[5], "/workflow:order-ship now");
  assert.match(rows[6], /^Start every named workflow with cbase_workflow_start \(workflow = short name\)\./);
  assert.match(rows[6], /Then end your turn with ONE line\. If you do not start, say why in one line\.$/);
});

// ── Refusals ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("refusals: kind, name, foreign, open (running, waiting, earmarked) - each with status and reason, without history row, without title, without spawn", async () => {
  await withAgentsServer(async ({ base, ws, chat, root, waitForQuiet }) => {
    const ship = newWorkflow(ws, "Order → Ship", { createdAt: 1000, graph: GRAPH });
    newWorkflow(ws, "Review", { createdAt: 2000 });
    const project = await json(`${base}/api/workspaces/${ws.id}/projects`, {
      method: "POST", body: JSON.stringify({ name: "Checkout", path: path.join(root, "workspace", "till") }),
    });
    // Only "Order → Ship" is adopted in the project - "Review" stands only in the workspace-wide list.
    store.setWorkflowEnabled(project.id, "Order → Ship", true);
    const projChat = await newChat(base, ws, { projectId: project.id });
    const manager = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", title: "Manager", createdAt: Date.now(), updatedAt: Date.now() });

    const expect = async (chatId, text, status, reason, pattern) => {
      const title = store.getChat(chatId).title;
      const r = await send(base, chatId, { text });
      assert.equal(r.status, status, `${text}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.reason, reason, text);
      assert.match(r.body.error, pattern);
      assert.match(r.body.error, /nichts wurde gesendet|Nichts wurde gesendet/);
      assert.deepEqual(userRows(chatId), [], `${text}: no history row`);
      assert.equal(store.getChat(chatId).title, title, `${text}: no title`);
    };
    // A manager chat is read-only (409 before the switch, runs/manager-lock.js); the kind refusal is carried by an app-agent chat.
    const locked = await send(base, manager.id, { text: "/workflow:order-ship now" });
    assert.equal(locked.status, 409, JSON.stringify(locked.body));
    assert.equal(locked.body.managerLocked, true);
    assert.deepEqual(userRows(manager.id), [], "manager chat: no history row");
    const service = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "service", title: "Service", createdAt: Date.now(), updatedAt: Date.now() });
    // An old app-agent chat is read-only (runs/only-readable.js): over HTTP the lock (409) catches before the switch;
    // the kind refusal of the switch itself is held by the direct call.
    const old = await send(base, service.id, { text: "/workflow:order-ship now" });
    assert.deepEqual([old.status, old.body.onlyReadable], [409, true], JSON.stringify(old.body));
    assert.deepEqual(userRows(service.id), [], "app-agent chat: no history row");
    const kind = graphSlash(store.getChat(service.id), { text: "/workflow:order-ship now" });
    assert.deepEqual([kind?.status, kind?.body?.reason], [400, "kind"], JSON.stringify(kind));
    assert.match(kind.body.error, /nur im Coding-Chat/);
    await expect(chat.id, "/workflow:doesnotexist now", 404, "name", /„\/workflow:doesnotexist“ gibt es in diesem Chat nicht/);
    // A known mention next to an unknown one makes the whole message unsendable.
    await expect(chat.id, "/workflow:order-ship and /workflow:doesnotexist", 404, "name", /doesnotexist/);
    await expect(projChat.id, "/workflow:review now", 404, "foreign", /„\/workflow:review“ gehört nicht zu diesem Chat/);
    // In the project chat the adopted workflow hits (otherwise this would be a 202 and no refusal).
    assert.equal(graphSlash(store.getChat(projChat.id), { text: "/workflow:order-ship" }).announcement.workflows[0].workflowId, ship.id);

    // Open: a running run, a WAITING one (a mention is then no answer), an earmarked start.
    const run = store.startWorkflowRun({ id: crypto.randomUUID(), chatId: chat.id, workflowId: ship.id, workflowName: ship.name, workspaceId: ws.id });
    await expect(chat.id, "/workflow:review now", 409, "open", /schon ein Workflow offen \(„Order → Ship“\)/);
    store.updateWorkflowRunById(run.id, { status: "waiting" });
    await expect(chat.id, "/workflow:review now", 409, "open", /erst beenden oder abbrechen/);
    store.updateWorkflowRunById(run.id, { status: "done" });
    const z = store.createGraphStart({ id: `gs-${crypto.randomUUID()}`, chatId: chat.id, workflowId: ship.id, workflowName: ship.name, shortName: "order-ship", status: "earmarked" });
    await expect(chat.id, "/workflow:review now", 409, "open", /„Order → Ship“/);
    store.changeGraphStart(z.id, { status: "stopped" });

    await waitForQuiet();
    assert.deepEqual(prompts(root), [], "the CLI got nothing");
  }, { claude });
});

// ── Success ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("success: the model reads the rewritten prompt, the bubble the typed line, the title is the workflow name, the tool succeeds with the attachments of the message", async () => {
  await withAgentsServer(async ({ base, ws, root, gate, waitForIdle }) => {
    const ship = newWorkflow(ws, "Order → Ship", { createdAt: 1000, description: "Ships it", graph: GRAPH });
    const c = await newChat(base, ws);
    assert.equal(c.title, "New chat");
    const attDir = path.join(DIRS.attachments, c.id);
    fs.mkdirSync(attDir, { recursive: true });
    fs.writeFileSync(path.join(attDir, "plan.txt"), "Plan");
    const attachment = path.join(attDir, "plan.txt");

    const typed = `/workflow:Order-Ship please deliver GS[a]:{"workflow":"order-ship","input":"please deliver"}§ GATE:a`;
    const r = await send(base, c.id, { text: typed, attachments: [{ file: "plan.txt", name: "plan.txt" }] });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const e = await toolResult(root, "a");
    await gate.reached("a");
    assert.equal(e.start.state, "earmarked", JSON.stringify(e));
    const row = store.graphStart(e.start.startId);
    assert.equal(row.workflowId, ship.id);
    assert.deepEqual(row.attachments, [attachment], "the attachments of the message go to the workflow");

    const [p] = prompts(root);
    assert.ok(!p.trimStart().startsWith("/"), `the CLI sees no leading slash: ${JSON.stringify(p.slice(0, 80))}`);
    assert.ok(p.startsWith("[cbase: The human starts these graph workflows with /workflow:]\n"), p);
    assert.match(p, /- "Order → Ship" \(workflow: order-ship\) — Ships it\. First step: "Plan": Plan the order\. Carefully\./);
    assert.ok(p.includes(`[Their message]\n${typed}\n`), "the message stands in it verbatim");
    assert.ok(p.includes(`[Attached files — read them first with the Read tool:]\n- ${attachment}`), "the model sees the attachments as well");

    assert.deepEqual(userRows(c.id), [typed], "the bubble shows the typed line");
    assert.equal(store.getChat(c.id).title, "Order → Ship", "the workflow name is the title, as with a manual start");
    gate.open("a");
    await waitForIdle();
  }, { claude });
});

test("two mentions give ONE announcement with two entries; doubled and uppercase counts once; both are startable in the turn", async () => {
  await withAgentsServer(async ({ base, ws, chat, root, gate, waitForIdle }) => {
    const ship = newWorkflow(ws, "Order → Ship", { createdAt: 1000 });
    const review = newWorkflow(ws, "Review", { createdAt: 2000 });
    const g = graphSlash(store.getChat(chat.id), { text: "/workflow:REVIEW and /workflow:order-ship, then /workflow:review" });
    assert.deepEqual(g.announcement.workflows, [
      { workflowId: review.id, shortName: "review", name: "Review" },
      { workflowId: ship.id, shortName: "order-ship", name: "Order → Ship" },
    ]);
    assert.equal(g.title, "Review");
    assert.equal(graphSlash(store.getChat(chat.id), { text: "only an attachment" }), null, "no announcement without a mention");

    const r = await send(base, chat.id, { text: `/workflow:review /workflow:order-ship GS[b]:{"workflow":"review","input":"R"}§ GATE:b` });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const e = await toolResult(root, "b");
    await gate.reached("b");
    assert.equal(e.start.workflowId, review.id);
    // The second announced one is reachable (403 would mean "not announced") - in the foreground only already taken.
    const second = await raw(`${base}/api/chats/${chat.id}/graph-workflows/start`, "POST", { workflow: "order-ship" });
    assert.equal(second.body.reason, "open", JSON.stringify(second.body));
    assert.equal(prompts(root)[0].split("\n").filter((z) => z.startsWith("- \"")).length, 2);
    gate.open("b");
    await waitForIdle();
  }, { claude });
});

test("queued behind a turn at the gate: the announcement travels along, the tool succeeds in the next turn", async () => {
  await withAgentsServer(async ({ base, ws, chat, root, gate, waitForIdle }) => {
    newWorkflow(ws, "Order → Ship", { createdAt: 1000 });
    await send(base, chat.id, { text: "Lead-in GATE:v" });
    await gate.reached("v");
    const r = await send(base, chat.id, { text: `/workflow:order-ship GS[q]:{"workflow":"order-ship","input":"later"}§` });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.queued, true, "queued during a turn");
    gate.open("v");
    const e = await toolResult(root, "q");
    assert.equal(e.start.state, "earmarked");
    assert.equal(e.start.input, "later");
    await waitForIdle();
  }, { claude });
});

test("a turn without a tool call creates no row", async () => {
  await withAgentsServer(async ({ base, ws, chat, root, waitForIdle }) => {
    newWorkflow(ws, "Order → Ship", { createdAt: 1000 });
    const r = await send(base, chat.id, { text: "/workflow:order-ship rather not" });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await waitForTruthy(() => prompts(root).length >= 1, "the turn");
    await waitForIdle();
    assert.deepEqual(store.graphStartsOf(chat.id), []);
  }, { claude });
});
