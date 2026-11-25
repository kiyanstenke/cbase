// What cbase writes into a RUNNING Claude process carries `isSynthetic: true` exactly when no human typed it
// (providers/connectors/claude.js userMsg, runs/queue.js injectEntry/injectNextRunInput, runs/do-run.js agent reports and
// wakeup). Since Claude Code 2.1.332 the CLI counts an unmarked line in the middle of a turn as the user's own words where
// it fetches no feature flags — a completion notice, an event or an agent's message must not pass as the user's request,
// and a human's follow-up must not lose that standing. Main seam with the agent harness: real server and queue, only the
// CLI is faked; the fake logs per turn whether the stdin line carried the field.
//
// Counter-tests (which sabotage turns which test red):
//   - userMsg ignores `synthetic` (never sets the field)            => "event" falls;
//   - userMsg always sets the field                                 => both fall (the first input carries it);
//   - queue.js computes `synthetic` over the cause without humanFrom (e.g. `true` constant) => "human" falls.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import * as store from "../electron/server/store.js";

const MAIN = `
  fs.appendFileSync(path.join(LOCATION, "lines.jsonl"), JSON.stringify({ text, synthetic: msg.isSynthetic === true }) + "\\n");
  const gateName = (String(text).match(/GATE:(\\w+)/) || [])[1];
  if (gateName) await gate(gateName);
  say({ type: "assistant", message: { id: "c-" + turn + "-" + Date.now(), content: [{ type: "text", text: "ok" }] } });
  finished();
  say({ type: "result", result: "ok", session_id: "main-session" });`;
const claude = fakeClaude({ main: MAIN, sub: "finished();" });

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const lines = (root) => readJsonl(path.join(root, "lines.jsonl"));
const lineWith = (root, word) => lines(root).find((l) => l.text.includes(word));

test("human: a follow-up typed while the turn runs goes into the process WITHOUT the field; the first input never carries it", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, gate } = ctx;
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Lead-in GATE:h" });
    await gate.reached("h");
    const queued = await post(`${base}/api/chats/${chat.id}/message`, { text: "Human follow-up" });
    assert.equal(queued.queued, true, "waits behind the running turn");
    gate.open("h");
    await ctx.waitForTruthy(() => lineWith(root, "Human follow-up"), "the injected human turn");
    await ctx.waitForIdle();
    assert.equal(lines(root).length, 2, "ONE process, two turns — the follow-up was injected, not a new run");
    assert.equal(lineWith(root, "Lead-in").synthetic, false, "first input");
    assert.equal(lineWith(root, "Human follow-up").synthetic, false, "human");
  }, { claude });
});

test("event: an input no human typed goes into the running process WITH the field", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, gate } = ctx;
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Lead-in GATE:e" });
    await gate.reached("e");
    deliverUserPrompt(store.getChat(chat.id), { prompt: "Monitor event arrived", display: "Monitor event arrived", cause: "event" });
    gate.open("e");
    await ctx.waitForTruthy(() => lineWith(root, "Monitor event arrived"), "the injected event turn");
    await ctx.waitForIdle();
    assert.equal(lines(root).length, 2, "ONE process, two turns — the event was injected, not a new run");
    assert.equal(lineWith(root, "Lead-in").synthetic, false, "first input");
    assert.equal(lineWith(root, "Monitor event arrived").synthetic, true, "event");
  }, { claude });
});
