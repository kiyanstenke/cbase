// Safety net for the agent lifetime: a background agent outlives its main turn, so everything that asks "is the chat
// running?" to detect work (idle gate and idle reaper via `busy` in /api/runs/active, archive, "active runs" pill)
// must still see it. A coding chat does not hold its turn (default `hold: false`); the fake agent waits behind its
// gate file while the turn is already over.
//
// Counter-test: compute `busy` in runs/routes.js without the agents => the second test reports `busy:false` after
// the turn ended.
import assert from "node:assert/strict";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { runKindProvider, runKindDefault } from "../electron/server/runs/hooks.js";

// The run kinds that explicitly registered "hold" are all gone. What remains is the default, and none of the removed
// kinds may silently come back.
test("holding is a question to the run kind: none is registered any more, the default does not hold", async () => {
  await withAgentsServer(async () => {
    for (const gone of ["administrator", "manager-agent", "pipeline", "context", "ingest"]) {
      assert.throws(() => runKindProvider(gone), /unknown run kind/, `${gone}: no provider any more`);
    }
    // The default itself: a coding chat does NOT hold its turn for its subagents.
    assert.equal(runKindDefault({ id: "coding", workspaceId: "no-workspace", kind: "coding", permissionMode: "" }).hold, false);
  }, { claude: fakeClaude() });
});

// The main agent starts ONE background agent and ends its turn at once; the subagent waits at the gate "sub".
const agentSurvivesTurn = fakeClaude({
  sub: `
    await gate("sub");
    say({ type: "assistant", message: { id: "sub-1", content: [{ type: "text", text: "Finding after the gate" }] } });
    finished();
    say({ type: "result", result: "Finding after the gate", session_id: "sub-session" });`,
  main: `
  if (!text.startsWith("<task-notification>")) { // the completion notice is a run of its own (turn 1)
    say({ type: "assistant", message: { id: "main-1", content: [{ type: "tool_use", id: "toolu_bg", name: "mcp__cbase__cbase_agent",
      input: { description: "On the side", prompt: "Take a look.", run_in_background: true } }] } });
    let t = "";
    try { t = textOf(await mcpCall("cbase_agent", { description: "On the side", prompt: "Take a look.", run_in_background: true })); }
    catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: t }] } });
    say({ type: "assistant", message: { id: "main-2", content: [{ type: "text", text: t.startsWith("ERROR") ? t.slice(0, 200) : "Agent running" }] } });
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
});

test("an agent outlives its turn (run kind without hold): busy, own field, pill and archive reason see it", async () => {
  await withAgentsServer(async ({ base, chat, gate, waitForTruthy, waitForIdle }) => {
    // Before: the field is present even when empty — a missing field is not a statement.
    const empty = await json(`${base}/api/runs/active`);
    assert.deepEqual(empty.agents, [], `the field is present when empty: ${JSON.stringify(empty)}`);

    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Start an agent" }) });
    await gate.reached("sub");
    // The turn ends although the agent lives — the chat no longer counts.
    const afterTurn = await waitForTruthy(async () => {
      const r = await json(`${base}/api/runs/active`);
      return r.runs === 0 ? r : null;
    }, "turn end with a live agent");

    assert.equal(afterTurn.busy, true, `a live agent keeps busy: ${JSON.stringify(afterTurn)}`);
    assert.equal(afterTurn.agents.length, 1, JSON.stringify(afterTurn.agents));
    assert.equal(afterTurn.agents[0].chatId, chat.id);
    assert.equal(afterTurn.agents[0].title, "Agent-E2E");
    assert.ok(afterTurn.agents[0].agentId, "the agent carries its id");

    const pill = await json(`${base}/api/active-runs`);
    const row = pill.items.find((it) => it.chatId === chat.id);
    assert.ok(row, `the pill shows the idle chat with its agent: ${JSON.stringify(pill.items)}`);
    assert.equal(row.background.agents, 1);
    assert.equal(row.phase, "waiting");
    assert.equal(row.stoppable, false);

    const res = await fetch(`${base}/api/chats/${chat.id}/archive`, {
      method: "PUT", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ archived: true }),
    });
    const body = await res.json();
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.deepEqual(body.open.map((o) => o.reason), ["agent"], JSON.stringify(body.open));
    assert.match(body.open[0].text, /Hintergrund-Agent/);

    // Gate open: the agent ends and everything is quiet again — busy, field, pill, archive.
    gate.open("sub");
    const still = await waitForIdle();
    const afterwards = await json(`${base}/api/runs/active`);
    assert.deepEqual(afterwards.agents, [], JSON.stringify(afterwards));
    assert.equal((await json(`${base}/api/active-runs`)).items.some((it) => it.chatId === chat.id), false);
    assert.deepEqual((await json(`${base}/api/chats/${chat.id}/archive`)).open, []);
    assert.ok(still);
  }, { claude: agentSurvivesTurn });
});
