// Agent communication: teardown of the old tools at the seams that no name guard sees.
//
//   (1) Retrieval -> booking: the view "chat" with summarize calls ONE sealed oneshot, and its consumption stands as a usage_events
//       row with source 'retrieval' and agent_id 'channel_status' at the reader's chat (fake CLI with `usage`). `input` counts only
//       fresh tokens (11), `cached` = read + write (3), as in the other subscription rows.
//   (2) A channel delivery that was queued (persisted) with the old reply path gets the new sentence on restart - in memory AND in
//       the table (channels/delivery.js preamblesRefresh).
//   (3) ONE channel read: GET /api/chats/:id/channels/:channelId and the view "channel" return the same body; POST /channel-status
//       is gone.
//
// Counter-tests: retrieval.js without `atConsumption` => (1) red (no row); delivery.js channelRestartGrace without the
// preamblesRefresh() call => (2) red; channels/routes.js with its own body and a /channel-status route => (3) red at the 404
// expectation.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { db } from "../electron/server/store/db.js";
import { pendingRunInputs, persistRunInputs } from "../electron/server/runs/state.js";
import { channelRestartGrace } from "../electron/server/channels/delivery.js";
import { json, makeChat, makeWorkspace, ok, withServer } from "./server-harness.mjs";

const read = (base, chatId, q = {}) => json(`${base}/api/chats/${chatId}/communication?${new URLSearchParams(q)}`);

test("(1) retrieval -> booking: the summary on retrieval books its consumption with source 'retrieval' and agent_id 'channel_status'", async () => {
  await withServer(async ({ base, wsPath, root }) => {
    const ws = await makeWorkspace(base, "Retrieval", wsPath);
    const reader = await makeChat(base, ws.id);
    const target = await makeChat(base, ws.id);
    store.addMessage(target.id, "user", "Build the till.");
    store.addMessage(target.id, "assistant", "Till is up.");
    // A fake CLI of its own for exactly this oneshot: it reports `usage` in the result object like the real one. withServer resets
    // CLAUDE_BIN at the end; here it is switched only for the duration of the call.
    const bin = path.join(root, "fake-claude-retrieval");
    fs.writeFileSync(bin, `#!${process.execPath}\nlet s = ""; process.stdin.on("data", (d) => { s += d; }); process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ result: "The till is up.", usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 }, modelUsage: { "retrieval-model": {} } })); process.exit(0); });\n`);
    fs.chmodSync(bin, 0o755);
    const prior = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = bin;
    let r;
    try { r = await read(base, reader.id, { view: "chat", chatId: target.id, summarize: true }); }
    finally { process.env.CLAUDE_BIN = prior; }
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.summary, "The till is up.");
    const rows = db.prepare("SELECT provider, billing, input, output, cached, chat_id AS chatId, source, agent_id AS agentId FROM usage_events WHERE source = 'retrieval'").all();
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.deepEqual({ ...rows[0] }, { provider: "claude", billing: "subscription", input: 11, output: 7, cached: 3, chatId: reader.id, source: "retrieval", agentId: "channel_status" });
  });
});

test("(2) a channel delivery queued with the old reply path gets the new one on restart - only cause \"channel\", only the sentence", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Restart", wsPath);
    const chat = await makeChat(base, ws.id);
    const channelId = "0f0e0d0c-0b0a-4908-8706-050403020100";
    // The stored German wording of the old preamble (the migration pattern matches it).
    const oldSentence = `Antworte über cbase_${"channel_send"} (channelId: ${channelId}), wenn eine Antwort erwartet wird — knapp und in der Sache.`;
    pendingRunInputs.set(chat.id, [
      { id: "e1", prompt: `New message in channel "K".\n${oldSentence}\n\n<channel id="${channelId}">...</channel>`, display: "Channel \"K\": a new message", cause: "channel" },
      { id: "e2", prompt: `The user quotes: ${oldSentence}`, display: "x", cause: "user" },
    ]);
    persistRunInputs(chat.id);
    try {
      channelRestartGrace(); // the receiver of the restart hook - without an open channel it does nothing else
      const [channel, user] = pendingRunInputs.get(chat.id);
      assert.ok(channel.prompt.includes(`Reply through cbase_agent_send (to: "channel:${channelId}"), wenn eine Antwort erwartet wird`), channel.prompt);
      assert.ok(!channel.prompt.includes(`cbase_${"channel_send"}`));
      assert.ok(user.prompt.includes(`cbase_${"channel_send"}`), "a user message stays as it is");
      const saved = store.listRunInputs().find((x) => x.chatId === chat.id);
      assert.equal(saved.entries[0].prompt, channel.prompt, "the table carries the new sentence too");
    } finally {
      // In the finally: a leftover queue would hold the server up on close.
      pendingRunInputs.delete(chat.id);
      persistRunInputs(chat.id);
    }
  });
});

test("(3) ONE channel read: GET /channels/:id and the view \"channel\" return the same body; POST /channel-status is gone", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Channel", wsPath);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);
    const k = await ok(`${base}/api/workspaces/${ws.id}/channels`, { method: "POST", body: JSON.stringify({ name: "K", participants: [a.id, b.id], creatorChatId: a.id, cap: 0 }) });
    const sent = await json(`${base}/api/chats/${a.id}/agent/send`, { method: "POST", body: JSON.stringify({ to: `channel:${k.id}`, message: "Status?", from: "agent" }) });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const route = await json(`${base}/api/chats/${b.id}/channels/${k.id}?limit=5`);
    const view = await json(`${base}/api/chats/${b.id}/communication?view=channel&channelId=${k.id}&limit=5`);
    assert.equal(route.status, 200, JSON.stringify(route.body));
    const { view: _s, note: _n, ...body } = view.body;
    assert.deepEqual(route.body, body);
    assert.deepEqual(route.body.messages.map((n) => n.text), ["Status?"]);
    assert.equal((await json(`${base}/api/chats/${a.id}/channels/${k.id}`)).status, 200);
    const third = await makeChat(base, ws.id);
    assert.equal((await json(`${base}/api/chats/${third.id}/channels/${k.id}`)).status, 404, "only a participant reads the channel");
    assert.equal((await json(`${base}/api/chats/${a.id}/channel-status`, { method: "POST", body: JSON.stringify({ chatIds: [b.id] }) })).status, 404, "the status route is removed");
  });
});
