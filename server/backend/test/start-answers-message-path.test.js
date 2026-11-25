// Where the main agent gets hold of something that runs on in the background, it is also told how to write to it — the
// send route accepts a message to each of them (communication/send.js, address.js), and an agent that is not told falls back
// on stopping and starting anew (measured in a chat: "the agents in a workflow have no channel for messages", the workflow
// was restarted to change one instruction). One check per kind of target:
//   subagent         the system prompt of the main run (cbase_agent always runs in the background; its line names the follow-up)
//   wf:<runId>:<n>   the start answer of cbase_dynamic_workflow (dynworkflows/run.js `note`) — here, through the real route
//   graph:<startId>  the start answer of a graph workflow in the background (workflows/graph-start.js `end`) — in
//                    test/graph-background.test.js "main seam", which starts one for real
// The named address is read with the send route's own parser, so the text cannot name a form the route does not accept.
//
// Counter-tests (which sabotage turns which test red):
//   - the sentence with cbase_agent_send and "wf:<runId>:<n>" struck from the note in dynworkflows/run.js => "workflow" falls;
//   - the note names "wf:<taskId>:<n>" instead of the runId                                                => "workflow" falls;
//   - "follow up with `cbase_agent_send`" struck from the HANDING OFF line of runs/system-prompt.js       => "subagent" falls.
import assert from "node:assert/strict";
import test from "node:test";

import { json, waitForTruthy, withAgentsServer } from "./agent-harness.mjs";
import { readAddress } from "../electron/server/communication/address.js";
import { buildSystemPrompt } from "../electron/server/runs/system-prompt.js";
import * as store from "../electron/server/store.js";

// The address a text names after cbase_agent_send — in English ("to") and in German ("an"), the gate runs in German.
const namedAddress = (text) => (String(text).match(/cbase_agent_send (?:to|an) "([^"]+)"/) || [])[1];

test("workflow: the start answer names the way to each of its agents, in the form the send route reads", async () => {
  await withAgentsServer(async ({ base, chat }) => {
    const script = "export const meta = { name: 'message-path', description: 'Start answer', phases: [{ title: 'Read' }] }\nlog('ok')\n";
    // Opted in for this chat (Ultracode), otherwise the start waits for the human's approval card and names nothing yet.
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ ultracode: true }) });
    const r = await json(`${base}/api/chats/${chat.id}/dyn-workflows/run`, { method: "POST", body: JSON.stringify({ script }) });
    assert.equal(r.status, "started", JSON.stringify(r));
    const named = namedAddress(r.note);
    assert.ok(named, `the note names no address after cbase_agent_send: ${r.note}`);
    assert.deepEqual(readAddress(named.replace("<n>", "1")), { kind: "wf", runId: r.runId, n: 1 });
    assert.match(r.note, /cbase_agents_list/, "it says where the agents' numbers stand");
    await waitForTruthy(() => store.readDynRun(r.runId)?.status !== "running", `run ${r.runId} ends`);
  });
});

test("subagent: the main run's system prompt names the follow-up through cbase_agent_send", () => {
  const prompt = buildSystemPrompt("");
  const line = prompt.split("\n").find((l) => l.includes("`cbase_agent` starts a subagent"));
  assert.ok(line, "the HANDING OFF line is missing");
  assert.match(line, /follow up with `cbase_agent_send`/);
});
