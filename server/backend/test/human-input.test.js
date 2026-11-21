// The human input of a turn as ONE reading (runs/human-input.js humanInput). Main seam: real server, real routes, fake
// Claude from the agent harness. Each turn of the fake stands at a gate whose name its input carries ("GATE:x") - reading
// happens while the turn waits there; no time window into which a glance has to fall.
//
// The cases: bundle of two user messages => both; channel turn => empty; schedule turn => empty; queue user, channel,
// user => the first turn only the first; a user message injected into the running run belongs to it; an invented cause =>
// empty (although the run drives it as "user"). Also: a run without a given input (graph step, restart - the open
// classifications) => empty.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import * as store from "../electron/server/store.js";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import { startRun } from "../electron/server/runs/do-run.js";
import { humanInput } from "../electron/server/runs/human-input.js";

const claude = fakeClaude({
  main: `
  const name = (String(text).match(/GATE:(\\w+)/) || [])[1] || ("t" + turn);
  await gate(name);
  finished();
  say({ type: "result", result: "ok " + name, session_id: "s-main" });`,
});

const send = (base, chatId, text) =>
  json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });
// The pid waiting at a gate - same pid means: the same process, the message was injected.
const pidAt = (root, name) => fs.readFileSync(path.join(root, "gates", `${name}.waiting`), "utf8").trim();
const deliver = (chatId, text, cause) =>
  deliverUserPrompt(store.getChat(chatId), { prompt: text, display: text, ...(cause === undefined ? {} : { cause }) });

test("bundle of two user messages, injected at the turn transition => both, and only them", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForIdle }) => {
    assert.equal(humanInput(chat.id), null, "before the first turn none runs - unknown, not empty");
    await send(base, chat.id, "First question GATE:a");
    await gate.reached("a");
    assert.deepEqual(humanInput(chat.id), ["First question GATE:a"]);

    const two = await send(base, chat.id, "Second GATE:b");
    const three = await send(base, chat.id, "Third");
    assert.equal(two.queued && three.queued, true, "both wait behind the running turn");
    gate.open("a");
    await gate.reached("b");
    assert.equal(pidAt(root, "b"), pidAt(root, "a"), "the bundle went into the SAME process (injection), no new run");
    assert.deepEqual(humanInput(chat.id), ["Second GATE:b", "Third"],
      "the injected bundle is the human input of the new turn - both messages, without that of the previous one");
    gate.open("b");
    await waitForIdle();
    assert.equal(humanInput(chat.id), null, "after the run end no turn runs any more");
  }, { claude });
});

test("steering bundles into a NEW run => both messages", async () => {
  await withAgentsServer(async ({ base, chat, gate, waitForIdle }) => {
    await send(base, chat.id, "Start GATE:s0");
    await gate.reached("s0");
    await send(base, chat.id, "Correction one GATE:s1");
    await send(base, chat.id, "Correction two");
    const r = await json(`${base}/api/chats/${chat.id}/control`, { method: "POST", body: "{}" });
    assert.equal(r.sent, 2, JSON.stringify(r));
    await gate.reached("s1");
    assert.deepEqual(humanInput(chat.id), ["Correction one GATE:s1", "Correction two"]);
    gate.open("s1");
    await waitForIdle();
  }, { claude });
});

test("queue user, channel, user => the first turn delivers only the first message, the channel turn nothing", async () => {
  await withAgentsServer(async ({ base, chat, gate, waitForIdle }) => {
    await send(base, chat.id, "Lead-in GATE:v");
    await gate.reached("v");
    await send(base, chat.id, "User one GATE:n1");
    const k = deliver(chat.id, "Channel in between GATE:k", "channel");
    assert.equal(k.queued, true, JSON.stringify(k));
    await send(base, chat.id, "User two GATE:n2");

    gate.open("v");
    await gate.reached("n1");
    assert.deepEqual(humanInput(chat.id), ["User one GATE:n1"], "the channel entry cuts off the bundle");
    gate.open("n1");
    await gate.reached("k");
    assert.deepEqual(humanInput(chat.id), [], "a channel turn has no human input");
    gate.open("k");
    await gate.reached("n2");
    assert.deepEqual(humanInput(chat.id), ["User two GATE:n2"]);
    gate.open("n2");
    await waitForIdle();
  }, { claude });
});

test("schedule, channel, invented and missing cause => empty; without a given input => empty", async () => {
  await withAgentsServer(async ({ chat, gate, waitForIdle }) => {
    const cases = [
      // Schedule first: the counter-test ("every cause counts") turns the schedule case red here, the channel case above.
      ["Schedule GATE:zp", "schedule"],
      ["Channel alone GATE:ka", "channel"],
      // The run drives an unknown cause as "user" (do-run.js) - the reading still does not count it.
      ["Invented GATE:er", "invented"],
      // Without a cause deliverUserPrompt drives it as "user" (handover, ticked item) - not typed, not counted.
      ["Without cause GATE:oa", undefined],
    ];
    for (const [text, cause] of cases) {
      const r = deliver(chat.id, text, cause);
      assert.equal(r.queued, false, `${text}: starts at once on a free chat`);
      const name = text.match(/GATE:(\w+)/)[1];
      await gate.reached(name);
      assert.deepEqual(humanInput(chat.id), [], `${cause ?? "(without)"}: no human input`);
      if (cause === "invented") {
        const kind = store.listActiveRuns().find((x) => x.chatId === chat.id)?.kind;
        assert.equal(kind, "chat", "the counter-proof: the run itself drives the invented cause as \"user\"");
      }
      gate.open(name);
      await waitForIdle();
    }
    // A run start without inputs - this is how the graph driver starts its steps (doRun without cause => "user").
    startRun(store.getChat(chat.id), "Graph step GATE:gs");
    await gate.reached("gs");
    assert.deepEqual(humanInput(chat.id), []);
    gate.open("gs");
    await waitForIdle();
    // The other side on the same path: an explicitly human cause counts.
    deliver(chat.id, "Typed GATE:gt", "user");
    await gate.reached("gt");
    assert.deepEqual(humanInput(chat.id), ["Typed GATE:gt"]);
    gate.open("gt");
    await waitForIdle();
  }, { claude });
});
