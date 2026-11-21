// SENDING from an outer-loop run (agent communication): POST /api/chats/:id/agent/send with the marker
// `outerLoop: "<agentId>:<runId>"` through the real server (the path the MCP tool takes):
//   (1) the card in the target carries `kind="outer_loop"`, `from` = the agent's name (never the observed chat), address
//       `outerloop:<id>`; no channel; the target answers in a turn of its own; the observed chat itself is reachable
//   (2) 403: without the chosen `cbase_agent_send` (agent OR the run's set), the marker of a finished run, a marker for another
//       chat, `channel:`/`wf:`/`graph:`/subagent, an unreadable chat (other workspace)
//   (3) 409: archived target, target with an open question card — and no card is created
//   (4) 400: `outerloop:<id>` as target — for EVERY sender (outer loop, agent, human); `from: "human"` with a marker; files; empty;
//       404: unknown chat
//
// COUNTER-TESTS (which sabotage turns which test red):
//   communication/target-outer-loop.js checkSendMarker without the check of `agent.tools` => (2) red (sent without choice);
//   communication/send.js without the 400 branch for `outerloop:` => (4) red.
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/outerloop-send.test.js

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { readMessage } from "../electron/server/runs/message-marker.js";
import { json, withAgentsServer } from "./agent-harness.mjs";

const MODEL = "claude-haiku-4-5-20251001";
const SET = { cbase: ["cbase_agents_list", "cbase_agent_send", "cbase_chat_analysis"], builtin: [], extern: [], dropped: { fence: [], approval: [] } };

async function request(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const cards = (chatId) => store.listMessages(chatId).filter((m) => m.role === "user").map((m) => readMessage(m.text)).filter((n) => n?.kind === "outer_loop");

test("sending from the outer loop: card as the agent, chats only, one-way — 403/409/400/404", async () => {
  await withAgentsServer(async ({ base, chat, ws, waitForTruthy }) => {
    // The run rows of this test sit on `running` without a core — they count as open work (/api/runs/active `open.outerLoop`),
    // quiet only comes after the finally. So wait for the chats' turns (`runs` 0) and for the answer itself.
    const turnsTo = async () => (await json(`${base}/api/runs/active`)).runs === 0;
    const newChat = async (title, wsId = ws.id) => {
      const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: wsId, provider: "claude", model: MODEL }) });
      await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
      return c;
    };
    const target = await newChat("Target");
    const archived = await newChat("Archived");
    const withCard = await newChat("With question");
    fs.mkdirSync(`${ws.path}-foreign`);
    const foreignWs = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Foreign", path: `${ws.path}-foreign` }) });
    const foreign = await newChat("Foreign", foreignWs.id);
    const agent = (id, name, tools) => store.createOuterLoopAgent({ id, workspaceId: ws.id, name, trigger: [{ kind: "quiet", minutes: 5 }], provider: "claude", model: MODEL, tools });
    const a = agent("a0000000-0000-4000-8000-0000000000a1", "Reviewer", ["cbase_agents_list", "cbase_agent_send"]);
    const withoutChoice = agent("a0000000-0000-4000-8000-0000000000a2", "No choice", ["cbase_agents_list"]);
    const runs = [
      ["l-a", a.id, chat.id, SET],
      ["l-without-choice", withoutChoice.id, chat.id, SET],
      ["l-without-set", a.id, target.id, { ...SET, cbase: ["cbase_chat_analysis"] }],
      ["l-finished", a.id, withCard.id, SET],
    ];
    for (const [id, agentId, chatId, set] of runs) store.createOuterLoopRun({ id, agentId, chatId, trigger: "quiet", set });
    store.outerLoopRunEnd("l-finished", { state: "finished" });
    const send = (ofChat, marker, body) => request(`${base}/api/chats/${ofChat}/agent/send`, { from: "agent", ...(marker ? { outerLoop: marker } : {}), ...body });
    const channelsPrior = store.listChannels(ws.id).length;
    try {
      // (1) to another chat — the card as the agent
      const r = await send(chat.id, `${a.id}:l-a`, { to: `chat:${target.id}`, message: "Please check the tests." });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(["delivered", "after_turn"].includes(r.body.state), JSON.stringify(r.body));
      await waitForTruthy(() => cards(target.id).length === 1, "card in the target");
      const k = cards(target.id)[0];
      assert.deepEqual({ from: k.from, kind: k.kind, address: k.address }, { from: "Reviewer", kind: "outer_loop", address: `outerloop:${a.id}` });
      assert.match(k.text, /Please check the tests\./);
      assert.notEqual(k.from, "Agent-E2E", "never as the observed chat");
      assert.equal(k.address.includes(chat.id), false, "the address does not name the observed chat");
      await waitForTruthy(async () => store.listMessages(target.id).some((m) => m.role === "assistant") && (await turnsTo()), "answer of the target");
      assert.equal(store.listChannels(ws.id).length, channelsPrior, "no channel");
      // ... and to the observed chat itself
      const itself = await send(chat.id, `${a.id}:l-a`, { to: `chat:${chat.id}`, message: "A note for you." });
      assert.equal(itself.status, 200, JSON.stringify(itself.body));
      await waitForTruthy(() => cards(chat.id).length === 1, "card in the observed chat");
      await waitForTruthy(async () => store.listMessages(chat.id).filter((m) => m.role === "assistant").length > 0 && (await turnsTo()), "answer of the observed chat");

      // (2) 403
      const forbidden = [
        ["without chosen agent_send (agent)", chat.id, `${withoutChoice.id}:l-without-choice`, `chat:${target.id}`],
        ["without agent_send in the run's set", target.id, `${a.id}:l-without-set`, `chat:${chat.id}`],
        ["marker of a finished run", withCard.id, `${a.id}:l-finished`, `chat:${target.id}`],
        ["marker for another chat", target.id, `${a.id}:l-a`, `chat:${chat.id}`],
        ["unknown run", chat.id, `${a.id}:exists-not`, `chat:${target.id}`],
        ["channel:", chat.id, `${a.id}:l-a`, "channel:k1"],
        ["wf:", chat.id, `${a.id}:l-a`, "wf:w1"],
        ["graph:", chat.id, `${a.id}:l-a`, "graph:g1"],
        ["subagent", chat.id, `${a.id}:l-a`, "agent-1"],
        ["chat of another workspace", chat.id, `${a.id}:l-a`, `chat:${foreign.id}`],
      ];
      for (const [what, ofChat, marker, to] of forbidden) {
        const x = await send(ofChat, marker, { to, message: "x" });
        assert.equal(x.status, 403, `${what}: ${JSON.stringify(x.body)}`);
      }

      // (3) 409 — and no card
      await json(`${base}/api/chats/${archived.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });
      const ar = await send(chat.id, `${a.id}:l-a`, { to: `chat:${archived.id}`, message: "x" });
      assert.equal(ar.status, 409, JSON.stringify(ar.body));
      store.addMessage(withCard.id, "ask", JSON.stringify({ requestId: "r-1", questions: [{ question: "Which variant?", options: [{ label: "A" }, { label: "B" }] }] }));
      const mk = await send(chat.id, `${a.id}:l-a`, { to: `chat:${withCard.id}`, message: "x" });
      assert.equal(mk.status, 409, JSON.stringify(mk.body));
      assert.equal(cards(archived.id).length + cards(withCard.id).length, 0, "rejected means: no card");

      // (4) 400 and 404
      for (const [what, marker, body] of [
        ["outerloop: als Ziel (Outer Loop)", `${a.id}:l-a`, { to: `outerloop:${a.id}`, message: "x" }],
        ["outerloop: als Ziel (Agent ohne Marke)", null, { to: `outerloop:${a.id}`, message: "x" }],
        ["outerloop: als Ziel (Mensch)", null, { to: `outerloop:${a.id}`, message: "x", from: "human" }],
        ["from human with marker", `${a.id}:l-a`, { to: `chat:${target.id}`, message: "x", from: "human" }],
        ["files", `${a.id}:l-a`, { to: `chat:${target.id}`, message: "x", files: ["a.txt"] }],
        ["empty", `${a.id}:l-a`, { to: `chat:${target.id}`, message: "  " }],
      ]) {
        const x = await send(chat.id, marker, body);
        assert.equal(x.status, 400, `${what}: ${JSON.stringify(x.body)}`);
      }
      const unknown = await send(chat.id, `${a.id}:l-a`, { to: "chat:exists-not", message: "x" });
      assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
      assert.equal(cards(target.id).length, 1, "none of it arrived"
);
    } finally {
      for (const [id] of runs) store.outerLoopRunEnd(id, { state: "finished" });
    }
  });
});
