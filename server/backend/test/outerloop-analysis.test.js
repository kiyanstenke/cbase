// The outer-loop analysis route behind `cbase_chat_analysis` — GET /api/chats/:id/outer-loop/analysis?run=<agentId>:<runId>&action=…
// through the real server:
//   (1) the four actions: history (row id per row, tools by default, paging), search (all roles, newest first, excerpt, capped),
//       call (call plus result), notes (only THIS agent's notes about THIS chat); each carries `note`
//   (2) `call` pairs over the ROW, not over the block id: two Codex calls with the same id `item_0` — the result of the second
//       never belongs to the first (Codex restarts its item ids per process)
//   (3) 403 without `run`, with a broken marker, for a finished run, a foreign chat and a foreign agent — before any parameter
//       check; 400 for an unknown action and missing parameters, 404 without a tool call in the row
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/outerloop-analysis.test.js

import assert from "node:assert/strict";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { NOTE } from "../electron/server/communication/read.js";
import { withAgentsServer } from "./agent-harness.mjs";

async function request(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close" } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// History of the observed chat: two conversation rows, then three Codex calls — two of them with the SAME id `item_0` (the first
// without a result before the second), one with an error. Returns the row ids in order.
function seedHistory(chatId) {
  const rows = [
    ["user", "Please rebuild the checkout."],
    ["assistant", "I am rebuilding the checkout now."],
    ["tool", JSON.stringify({ id: "item_0", name: "Bash", detail: "ls", input: { command: "ls" } })],
    ["tool", JSON.stringify({ id: "item_0", name: "Bash", detail: "cat checkout.js", input: { command: "cat checkout.js" } })],
    ["tool_result", JSON.stringify({ id: "item_0", result: "B result: checkout module", isError: false })],
    ["tool", JSON.stringify({ id: "item_1", name: "Bash", detail: "npm test", input: { command: "npm test" } })],
    ["tool_result", JSON.stringify({ id: "item_1", result: "1 test red", isError: true })],
  ];
  return rows.map(([role, text], i) => { store.addMessage(chatId, role, text, 1000 + i); return store.messageStats(chatId).lastId; });
}

test("analysis route: four actions, pairing over the row, 403 outside the own running run", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws } = ctx;
    const otherChat = (await request(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001" }) })).body;
    const newAgent = (id, name) => store.createOuterLoopAgent({ id, workspaceId: ws.id, name, trigger: [{ kind: "quiet", minutes: 5 }], provider: "claude", model: "m" });
    const a = newAgent("a0000000-0000-4000-8000-00000000000a", "Reviewer");
    const b = newAgent("b0000000-0000-4000-8000-00000000000b", "Second");
    store.createOuterLoopRun({ id: "run-a", agentId: a.id, chatId: chat.id, trigger: "quiet" });
    store.createOuterLoopRun({ id: "run-finished", agentId: a.id, chatId: chat.id, trigger: "quiet" });
    store.outerLoopRunEnd("run-finished", { state: "finished" });
    store.createOuterLoopRun({ id: "run-other", agentId: a.id, chatId: otherChat.id, trigger: "quiet" });
    const z = seedHistory(chat.id);
    const A = (q) => request(`${base}/api/chats/${chat.id}/outer-loop/analysis?${new URLSearchParams({ run: `${a.id}:run-a`, ...q })}`);

    // (3) 403 before anything else
    const without = await request(`${base}/api/chats/${chat.id}/outer-loop/analysis?action=history`);
    assert.equal(without.status, 403, "without run");
    for (const [run, what] of [["broken", "marker without colon"], [`${a.id}:`, "without run id"], [`:run-a`, "without agent"],
      [`${a.id}:run-finished`, "finished run"], [`${a.id}:run-other`, "run on another chat"], [`${b.id}:run-a`, "foreign agent"],
      [`${a.id}:exists-not`, "unknown run"]]) {
      const r = await request(`${base}/api/chats/${chat.id}/outer-loop/analysis?${new URLSearchParams({ run, action: "nonexistent" })}`);
      assert.equal(r.status, 403, `${what}: 403 before the action check`);
    }
    // ... and the same run works on its own chat, but not through the path of this chat
    const inOther = await request(`${base}/api/chats/${otherChat.id}/outer-loop/analysis?${new URLSearchParams({ run: `${a.id}:run-other`, action: "history" })}`);
    assert.equal(inOther.status, 200);
    assert.equal(inOther.body.total, 0);
    assert.equal((await A({ action: "nonexistent" })).status, 400);
    assert.equal((await A({})).status, 400, "without action");

    // (1) history
    const v = await A({ action: "history" });
    assert.equal(v.status, 200);
    assert.equal(v.body.note, NOTE);
    assert.deepEqual(v.body.chat, { id: chat.id, title: "Agent-E2E" });
    assert.equal(v.body.total, 7, "tool rows are the default");
    assert.deepEqual(v.body.lines.map((l) => l.row), z, "each row carries its messages.id");
    assert.deepEqual(v.body.lines.map((l) => l.role), ["user", "assistant", "tool", "tool", "tool_result", "tool", "tool_result"]);
    assert.equal(v.body.lines[3].text, "Bash: cat checkout.js", "readable like the chat view");
    const onlyConversation = await A({ action: "history", includeTools: "false" });
    assert.deepEqual(onlyConversation.body.lines.map((l) => l.row), z.slice(0, 2));
    const page = await A({ action: "history", from: "1", limit: "2" });
    assert.deepEqual([page.body.from, page.body.until, page.body.lines.map((l) => l.row)], [1, 3, z.slice(1, 3)]);
    assert.deepEqual((await A({ action: "history", limit: "2" })).body.lines.map((l) => l.row), z.slice(5), "without from: the last ones");
    assert.equal((await A({ action: "history", maxChars: "80" })).body.lines[4].text.length <= 80 + " …[gekürzt]".length, true);

    // (1) search — all roles, newest first, capped
    const s = await A({ action: "search", search: "checkout" });
    assert.equal(s.status, 200);
    assert.deepEqual(s.body.hits.map((t) => t.row), [z[4], z[3], z[1], z[0]], "tool call and result too, newest first");
    assert.equal(s.body.capped, false);
    assert.match(s.body.hits.find((t) => t.row === z[4]).excerpt, /B result: checkout module/);
    const s1 = await A({ action: "search", search: "checkout", limit: "1" });
    assert.deepEqual([s1.body.hits.length, s1.body.capped], [1, true]);
    assert.deepEqual((await A({ action: "search", search: "50%_" })).body.hits, [], "LIKE characters are text");
    assert.equal((await A({ action: "search" })).status, 400);

    // (2) call — paired over the row
    const first = await A({ action: "call", row: String(z[2]) });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.call, { id: z[2], blockId: "item_0", ts: 1002, name: "Bash", detail: "ls", input: { command: "ls" } });
    assert.equal(first.body.result, null, "the first item_0 has NO result — the next one belongs to the second call with the same id");
    const second = await A({ action: "call", row: String(z[3]) });
    assert.deepEqual(second.body.result, { id: z[4], ts: 1004, text: "B result: checkout module", isError: false });
    const third = await A({ action: "call", row: String(z[5]) });
    assert.deepEqual(third.body.result, { id: z[6], ts: 1006, text: "1 test red", isError: true });
    assert.equal((await A({ action: "call", row: String(z[0]) })).status, 404, "a user row is not a call");
    assert.equal((await A({ action: "call", row: "999999" })).status, 404);
    assert.equal((await A({ action: "call" })).status, 400);
    assert.equal((await A({ action: "call", row: "abc" })).status, 400);
    store.addMessage(otherChat.id, "tool", JSON.stringify({ id: "x", name: "Read" }), 2000);
    assert.equal((await A({ action: "call", row: String(store.messageStats(otherChat.id).lastId) })).status, 404, "a row of another chat");

    // (1) notes — only THIS agent's notes about THIS chat, newest first
    store.createOuterLoopNote({ agentId: a.id, chatId: chat.id, runId: "run-finished", text: "First", at: 1 });
    store.createOuterLoopNote({ agentId: b.id, chatId: chat.id, runId: "x", text: "Foreign agent", at: 2 });
    store.createOuterLoopNote({ agentId: a.id, chatId: otherChat.id, runId: "x", text: "Other chat", at: 3 });
    store.createOuterLoopNote({ agentId: a.id, chatId: chat.id, runId: "run-finished", text: "Second", at: 4 });
    const n = await A({ action: "notes" });
    assert.equal(n.status, 200);
    assert.equal(n.body.note, NOTE);
    assert.deepEqual(n.body.notes.map((x) => x.text), ["Second", "First"]);
    assert.deepEqual((await A({ action: "notes", limit: "1" })).body.notes.map((x) => x.text), ["Second"]);
    // A `running` row counts as open work (/api/runs/active `open.outerLoop`) — the runs of this test have no core, so end them
    // here, otherwise the harness waits for quiet on them.
    store.abortOuterLoopRuns("test end");

  });
});
