// Approvals per agent instead of per chat.
//
// An open approval card belongs to the agent that asked for it — main run or subagent, foreground or background —, and does
// so from the request itself: the permission prompt of a subagent's cbase MCP server carries its profile
// (`CBASE_PROFILE_KEY`). Turn end and `/stop` decline the cards of the main run and its foreground agents; an agent's cards go
// when THAT agent ends or is stopped.
//
// Measured over the whole way: real cbase MCP server (`cbase_permission_prompt`), real routes, fake CLI.
//
// Counter-proofs (each shown red once, runs/approvals.js; which sabotage turns which test red):
//   - `clearAgentPermissions` declines chat-wide (without `p.agent?.id === agentId`) => the first test finds the main run's
//     card declined with "Agent stopped".
//   - `clearChatPermissions` does not ask for the background (without `!p.agent?.background`) => the second test finds the
//     background agent's card declined with "Run ended" at the turn end.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";

// Both ask through the MCP server of their OWN run — the main run without a profile, the subagent with one.
const approval = (command) => `await mcpCall("cbase_permission_prompt", { tool_name: "Bash", input: { command: ${JSON.stringify(command)} } }, null)`;
const RESPONSE = "const responseOf = (m) => { try { return JSON.parse(m.result.content[0].text); } catch { return null; } };";

const twoCards = ({ gateBeforeEnd = false } = {}) => fakeClaude({
  sub: `
    ${RESPONSE}
    const d = responseOf(${approval("sub")});
    say({ type: "assistant", message: { id: "sub-1", content: [{ type: "text", text: "Sub: " + (d && d.behavior) }] } });
    finished();
    say({ type: "result", result: "Sub: " + (d && d.behavior), session_id: "sub-session" });`,
  main: `
  if (!text.startsWith("<task-notification>")) { // the completion notice is a run of its own (turn 1)
    say({ type: "assistant", message: { id: "main-1", content: [{ type: "tool_use", id: "toolu_bg", name: "mcp__cbase__cbase_agent",
      input: { description: "On the side", prompt: "Ask.", run_in_background: true } }] } });
    let t = "";
    try { t = textOf(await mcpCall("cbase_agent", { description: "On the side", prompt: "Ask.", run_in_background: true })); }
    catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: t }] } });
    ${gateBeforeEnd ? `await gate("main");` : `${RESPONSE}
    const d = responseOf(${approval("main")});
    say({ type: "assistant", message: { id: "main-2", content: [{ type: "text", text: "Main: " + (d && d.behavior) }] } });`}
  }
  finished();
  say({ type: "result", result: "done", session_id: "main-session" });`,
});

// The chat asks: cbase_permission_prompt stands only in a run whose CLI calls it — Claude outside bypassPermissions
// (toolchain/mcp-config.js approvalOverMcp, marker CBASE_APPROVAL). The harness creates the chat with bypassPermissions; the
// fake CLI calls the tool, like the real one, only in the asking mode.
const asking = (base, chat) => json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ permissionMode: "default" }) });
// The coding cards (row "approval") and their rulings (row "approval_ruling") by command.
function cards(log) {
  const open = new Map();
  for (const m of log) {
    if (m.role !== "approval") continue;
    const k = JSON.parse(m.text);
    open.set(k.input?.command, k.requestId);
  }
  const decide = log.filter((m) => m.role === "approval_ruling").map((m) => JSON.parse(m.text));
  return { open, decide };
}

test("the stop of a subagent declines exactly ITS card — the main run's stays open and can be decided", async () => {
  await withAgentsServer(async ({ base, chat, waitForTruthy, waitForLog, waitForIdle }) => {
    await asking(base, chat);
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Two cards" }) });
    const log = await waitForLog(chat.id, (l) => cards(l).open.size === 2);
    const { open } = cards(log);
    const agents = (await json(`${base}/api/chats/${chat.id}/agents`)).agents;
    assert.equal(agents.length, 1, JSON.stringify(agents));

    const stop = await json(`${base}/api/chats/${chat.id}/agent/stop`, { method: "POST", body: JSON.stringify({ agentId: agents[0].agentId, from: "human" }) });
    assert.equal(stop.ok, true, JSON.stringify(stop));

    // The subagent's card is declined — exactly once, with the wording of a stop.
    const afterStop = await waitForLog(chat.id, (l) => cards(l).decide.some((e) => e.requestId === open.get("sub")));
    const { decide } = cards(afterStop);
    const sub = decide.filter((e) => e.requestId === open.get("sub"));
    assert.equal(sub.length, 1, `the subagent's card is reported exactly once: ${JSON.stringify(decide)}`);
    assert.equal(sub[0].behavior, "deny");
    assert.equal(sub[0].origin, "stop");
    assert.equal(decide.some((e) => e.requestId === open.get("main")), false, `the main run's card is untouched: ${JSON.stringify(decide)}`);

    // The main run's card still stands — the user's decision reaches it.
    const d = await json(`${base}/api/chats/${chat.id}/permission-decision`, { method: "POST", body: JSON.stringify({ requestId: open.get("main"), behavior: "allow" }) });
    assert.equal(d.ok, true, "the main run's card could still be decided after the agent stop");
    const end = await waitForTruthy(async () => {
      const l = await json(`${base}/api/chats/${chat.id}/log`);
      return l.some((m) => m.role === "assistant" && m.text === "Main: allow") ? l : null;
    }, "answer of the main run");
    const main = cards(end).decide.filter((e) => e.requestId === open.get("main"));
    assert.deepEqual(main.map((e) => [e.behavior, e.origin]), [["allow", "user"]], "exactly one ruling, the user's");
    await waitForIdle();
  }, { claude: twoCards() });
});

test("a background agent's card survives the turn end as soon as it survives it (run kind without holding)", async () => {
  await withAgentsServer(async ({ base, chat, gate, waitForTruthy, waitForLog, waitForIdle }) => {
    // A coding chat no longer holds (default) — the test seam for it is gone.

    await asking(base, chat);
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Card in the background" }) });
    const log = await waitForLog(chat.id, (l) => cards(l).open.has("sub"));
    const rid = cards(log).open.get("sub");
    await gate.reached("main");
    gate.open("main");
    await waitForTruthy(async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null), "turn end with an open agent card");

    // The turn end did NOT decline it: no ruling, and the user can still release it.
    const afterTurn = await json(`${base}/api/chats/${chat.id}/log`);
    assert.equal(cards(afterTurn).decide.some((e) => e.requestId === rid), false, JSON.stringify(cards(afterTurn).decide));
    const d = await json(`${base}/api/chats/${chat.id}/permission-decision`, { method: "POST", body: JSON.stringify({ requestId: rid, behavior: "allow" }) });
    assert.equal(d.ok, true, "the background agent's card still stood open after the turn end");
    await waitForIdle();
    const end = await json(`${base}/api/chats/${chat.id}/log`);
    assert.deepEqual(cards(end).decide.filter((e) => e.requestId === rid).map((e) => [e.behavior, e.origin]), [["allow", "user"]]);
  }, { claude: twoCards({ gateBeforeEnd: true }) });
});

// Two ways that the tests above do not enter: the card appears only AFTER the turn end, or its agent switches to the
// background only AFTER the request.
// Counter-proofs (each shown red once; which sabotage turns which test red):
//   - runs/permissions.js without `&& agent?.background !== true` => the third test gets "No running run", without a card.
//   - runs/agents.js onSwitch without `agentCardsIntoTheBackground` => the fourth test finds the card declined with
//     "Run ended" at the turn end.
const responseFile = (root) => { try { return JSON.parse(fs.readFileSync(path.join(root, "response"), "utf8")); } catch { return null; } };
const lateCard = ({ foreground }) => fakeClaude({
  sub: `
    ${RESPONSE}
    ${foreground ? "" : `await gate("sub");`}
    const d = responseOf(${approval("late")});
    fs.writeFileSync(path.join(LOCATION, "response"), JSON.stringify(d));
    finished();
    say({ type: "result", result: "Sub: " + (d && d.behavior), session_id: "sub-session" });`,
  main: `
  if (!text.startsWith("<task-notification>")) {
    const args = { description: "Late", prompt: "Ask.", run_in_background: ${foreground ? "false" : "true"} };
    say({ type: "assistant", message: { id: "main-1", content: [{ type: "tool_use", id: "toolu_s", name: "mcp__cbase__cbase_agent", input: args }] } });
    let t = "";
    try { t = textOf(await mcpCall("cbase_agent", args)); } catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_s", content: t }] } });
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
});

test("a background agent that asks only AFTER the turn end gets a card — no silent rejection", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForTruthy, waitForLog, waitForIdle }) => {
    await asking(base, chat);
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Ask later" }) });
    await gate.reached("sub");
    await waitForTruthy(async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null), "turn end before the request");
    gate.open("sub");

    // Either the card appears (right) or the agent already has its answer (the silent rejection of before).
    const state = await waitForTruthy(async () => {
      const a = responseFile(root);
      if (a) return { response: a };
      const l = await json(`${base}/api/chats/${chat.id}/log`);
      return cards(l).open.has("late") ? { rid: cards(l).open.get("late") } : null;
    }, "card or answer");
    assert.ok(state.rid, `after the turn end a card appears instead of a silent rejection: ${JSON.stringify(state.response)}`);
    const d = await json(`${base}/api/chats/${chat.id}/permission-decision`, { method: "POST", body: JSON.stringify({ requestId: state.rid, behavior: "allow" }) });
    assert.equal(d.ok, true);
    const response = await waitForTruthy(() => responseFile(root), "answer to the subagent");
    assert.equal(response?.behavior, "allow", JSON.stringify(response));
    await waitForIdle();
  }, { claude: lateCard({ foreground: false }) });
});

test("the open card of a foreground agent switches to the background with it and survives the turn end", async () => {
  await withAgentsServer(async ({ base, chat, root, waitForTruthy, waitForLog, waitForIdle }) => {
    await asking(base, chat);
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Foreground with card" }) });
    const log = await waitForLog(chat.id, (l) => cards(l).open.has("late"));
    const rid = cards(log).open.get("late");
    const agents = (await json(`${base}/api/chats/${chat.id}/agents`)).agents;
    assert.equal(agents.length, 1, JSON.stringify(agents));
    const w = await json(`${base}/api/chats/${chat.id}/agent/background`, { method: "POST", body: JSON.stringify({ agentId: agents[0].agentId }) });
    assert.equal(w.background, true, JSON.stringify(w));
    await waitForTruthy(async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null), "turn end after the switch");

    const afterTurn = await json(`${base}/api/chats/${chat.id}/log`);
    assert.equal(cards(afterTurn).decide.some((e) => e.requestId === rid), false,
      `the turn end did not decline the card of the switched agent: ${JSON.stringify(cards(afterTurn).decide)}`);
    const d = await json(`${base}/api/chats/${chat.id}/permission-decision`, { method: "POST", body: JSON.stringify({ requestId: rid, behavior: "allow" }) });
    assert.equal(d.ok, true, "the card still stood open after the turn end");
    const response = await waitForTruthy(() => responseFile(root), "answer to the subagent");
    assert.equal(response?.behavior, "allow", JSON.stringify(response));
    await waitForIdle();
  }, { claude: lateCard({ foreground: true }) });
});

// `/permission-decision` was bound to no chat — every route decided every open card, and "Remember" stored the rule globally,
// even without a card. Now a decision applies only to the card of the route's chat (otherwise 200 with ok:false, as for one
// no longer open), and remembering happens only after the hit.
test("a decision applies only to the card of THIS chat, and \"Remember\" without a hit card remembers nothing", async () => {
  await withAgentsServer(async ({ base, chat, ws, root, waitForTruthy, waitForLog, waitForIdle }) => {
    await asking(base, chat);
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "One card" }) });
    const log = await waitForLog(chat.id, (l) => cards(l).open.has("scope-check"));
    const rid = cards(log).open.get("scope-check");
    const foreign = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
    assert.ok(foreign.id && foreign.id !== chat.id, JSON.stringify(foreign));
    const landscape = await json(`${base}/api/chats/${foreign.id}/permission-decision`, { method: "POST", body: JSON.stringify({ requestId: rid, behavior: "allow", remember: "Bash(scope-check-landscape:*)" }) });
    assert.equal(landscape.ok, false, "a foreign chat does not decide the card");
    const empty = await json(`${base}/api/chats/${chat.id}/permission-decision`, { method: "POST", body: JSON.stringify({ requestId: "exists-not", behavior: "allow", remember: "Bash(scope-check-empty:*)" }) });
    assert.equal(empty.ok, false);
    const rules = (await json(`${base}/api/permission-rules`)).rules || [];
    assert.equal(rules.some((r) => String(r).startsWith("Bash(scope-check-")), false, `without a hit card nothing is remembered: ${JSON.stringify(rules)}`);
    assert.equal(cards(await json(`${base}/api/chats/${chat.id}/log`)).decide.some((e) => e.requestId === rid), false, "the card still stands open");
    const d = await json(`${base}/api/chats/${chat.id}/permission-decision`, { method: "POST", body: JSON.stringify({ requestId: rid, behavior: "allow" }) });
    assert.equal(d.ok, true, "its own chat decides it");
    const response = await waitForTruthy(() => responseFile(root), "answer to the main run");
    assert.equal(response?.behavior, "allow", JSON.stringify(response));
    await waitForIdle();
  }, { claude: fakeClaude({ main: `
  if (!text.startsWith("<task-notification>")) {
    ${RESPONSE}
    const d = responseOf(${approval("scope-check")});
    fs.writeFileSync(path.join(LOCATION, "response"), JSON.stringify(d));
  }
  finished();
  say({ type: "result", result: "done", session_id: "main-session" });` }) });
});
