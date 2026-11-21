// Agent communication, chat <-> chat on the real server: POST /api/chats/:id/agent/send to `chat:<id>` from a coding main agent
// (also the node agent of a graph child chat) per the channel table, the delivery (an open question card holds, the archive
// holds), the fence across project boundaries and the full-text search over the view `chats` with `search` (FTS5,
// store/chat-search.js).
//
// The guards:
//   (1) no channel => silent channel (open, cap 0, creator = sender); ping-pong A -> B -> A over channel:<id>
//   (2) channel closed => chat:<id> rejected, no new channel
//   (3) paused => answer "paused", delivered after resuming
//   (4) pause the channel, write, archive the target, resume AND restart => the target stays archived, the cursor stays, a system
//       note at the sender; sending to the archived chat => 409; fetchBack with cause channel/message => no
//   (5) an open question card in the target holds the delivery (coding <-> coding) and is NOT answered - after the human's answer
//       the message comes
//   (6) full-text search - in communication-search.test.js
//   (7) foreign workspace => 403
//   (8) from a project network one reads and writes across project boundaries (fence context and BODY.agentSendInScope)
//   (9) cap by hand on a coding <-> coding channel: paused, but NO wake-up call (that applies only to channels with a manager)
//
// Counter-tests (which sabotage turns which test red):
//   target-chat.js: without the branch "no channel"                 => (1) red
//   target-chat.js: closed channel => new channel                   => (2) red
//   delivery.js: without the archive hold in deliverChannel         => (4) red
//   runs/archive.js: fetchBack without the cause check              => (4) red
//   delivery.js: without the question hold for channels without a manager => (5) red
//   chat-search.js: insert trigger without WHEN                     => (6) red (completion notice and agent message found)
//   projectbox/fence.js: chat branch "only this instance" again     => (8) red
//   delivery.js: cap wake-up call without the manager check         => (9) red
//   chat-search.js: CHAT_SEARCH_EXEMPT without "<cbase-message"     => (6b) red
// That manager and child chats are not found is held by the construction: hits come only from the candidates of the list
// (read.js readableChats - predicate and list), not from a filter of its own.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { readView } from "../electron/server/communication/read.js";
import { sendMessage } from "../electron/server/communication/send.js";
import { _clearArchiveReported, channelInputHolds, channelRestartGrace } from "../electron/server/channels/delivery.js";
import { fetchBack } from "../electron/server/runs/archive.js";
import { BODY } from "../electron/server/projectbox/fence.js";
import { FENCE_TABLE } from "../electron/server/projectbox/fence-table.js";
import { FINISHED_MARKER } from "../electron/server/runs/completionNotice.js";
import { pendingRunInputs } from "../electron/server/runs/state.js";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import { startRun } from "../electron/server/runs/do-run.js";
import { buildMessage, isMessage } from "../electron/server/runs/message-marker.js";
import { json, makeChat, makeWorkspace, ok, waitFor, withServer } from "./server-harness.mjs";

const send = (base, chatId, body) => json(`${base}/api/chats/${chatId}/agent/send`, { method: "POST", body: JSON.stringify(body) });
const enabled = (base, from, target, message) => send(base, from, { to: target, message, from: "agent" });
const cards = async (base, chatId) => (await ok(`${base}/api/chats/${chatId}/log`)).filter((z) => z.role === "channel").map((z) => JSON.parse(z.text));
const hasCard = async (base, chatId, marker, direction = "in") => (await cards(base, chatId)).some((k) => k.direction === direction && String(k.text).includes(marker));
const channelsBetween = (a, b) => store.listChannelsOfChat(a).filter((k) => store.getChannelParticipants(k.id, b));
const archive = (base, chatId, archived = true) => ok(`${base}/api/chats/${chatId}/archive`, { method: "PUT", body: JSON.stringify({ archived }) });

test("(1) coding -> coding without a channel: silent channel (open, cap 0, creator = sender); ping-pong A -> B -> A; the node agent of a child chat writes too", async () => {
  await withServer(async ({ base, wsPath, waitForQuiet }) => {
    const ws = await makeWorkspace(base, "Ping", wsPath);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);

    const r1 = await enabled(base, a.id, `chat:${b.id}`, "MARKER-PING");
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.ok(["delivered", "after_turn"].includes(r1.body.state), r1.body.state);
    const k = store.getChannel(r1.body.channelId);
    assert.equal(k.status, "open");
    assert.equal(k.cap, 0, "cap 0 = no cap");
    assert.equal(k.creatorChatId, a.id);
    assert.deepEqual(store.listChannelParticipants(k.id).map((t) => t.chatId).sort(), [a.id, b.id].sort());
    await waitForQuiet();
    assert.equal(await hasCard(base, b.id, "MARKER-PING"), true, "B has the message");

    // A second message goes through the SAME channel.
    const r2 = await enabled(base, a.id, `chat:${b.id}`, "MARKER-TWO");
    assert.equal(r2.body.channelId, k.id);
    await waitForQuiet();
    // Pong: B replies through channel:<id> - and chat:<A> hits the same channel too.
    const r3 = await enabled(base, b.id, `channel:${k.id}`, "MARKER-PONG");
    assert.equal(r3.status, 200, JSON.stringify(r3.body));
    await waitForQuiet();
    assert.equal(await hasCard(base, a.id, "MARKER-PONG"), true, "A has the reply");
    const r4 = await enabled(base, b.id, `chat:${a.id}`, "MARKER-PONG2");
    assert.equal(r4.body.channelId, k.id);
    assert.equal(channelsBetween(a.id, b.id).length, 1, "exactly one channel");
    await waitForQuiet();

    // The node agent of a graph child chat writes to other chats - but a child chat is never a target.
    const kind = await makeChat(base, ws.id);
    store.createGraphStart({ id: crypto.randomUUID(), chatId: b.id, childChatId: kind.id, workflowId: "wf", workflowName: "WF", shortName: "wf", status: "running" });
    const r5 = await enabled(base, kind.id, `chat:${a.id}`, "MARKER-KIND");
    assert.equal(r5.status, 200, JSON.stringify(r5.body));
    const r6 = await enabled(base, a.id, `chat:${kind.id}`, "to the child");
    assert.equal(r6.status, 403, JSON.stringify(r6.body));
    await waitForQuiet();
  });
});

test("(2) closed => rejected without a new channel; (3) paused => \"paused\" and delivery after resuming; (7) foreign workspace 403; a manager chat without a channel is no target", async () => {
  await withServer(async ({ base, wsPath, waitForQuiet }) => {
    const ws = await makeWorkspace(base, "State", wsPath);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);
    const r1 = await enabled(base, a.id, `chat:${b.id}`, "first");
    const channelId = r1.body.channelId;
    await waitForQuiet();

    // (3) paused
    await ok(`${base}/api/channels/${channelId}/pause`, { method: "POST", body: JSON.stringify({ reason: "test" }) });
    const r3 = await enabled(base, a.id, `chat:${b.id}`, "MARKER-PAUSED");
    assert.equal(r3.status, 200, JSON.stringify(r3.body));
    assert.equal(r3.body.state, "paused");
    assert.match(r3.body.text, /pausiert — wird nach dem Fortsetzen zugestellt/);
    assert.equal(await hasCard(base, b.id, "MARKER-PAUSED"), false);
    await ok(`${base}/api/channels/${channelId}/resume`, { method: "POST", body: JSON.stringify({}) });
    await waitForQuiet();
    assert.equal(await hasCard(base, b.id, "MARKER-PAUSED"), true, "delivered after resuming");

    // (2) closed
    await ok(`${base}/api/channels/${channelId}/close`, { method: "POST", body: JSON.stringify({ reason: "test" }) });
    const count = store.listChannels(ws.id).length;
    const r2 = await enabled(base, a.id, `chat:${b.id}`, "after closing");
    assert.equal(r2.status, 409, JSON.stringify(r2.body));
    assert.equal(r2.body.state, "denied");
    assert.match(r2.body.error, /abgewiesen: Kanal closed/);
    assert.equal(store.listChannels(ws.id).length, count, "no new channel");
    assert.equal(channelsBetween(a.id, b.id).length, 1);

    // A manager conversation without a channel is no new target (not readable => 403), and nothing arises.
    const t = Date.now();
    const mgr = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", agentId: "ag-1", createdAt: t, updatedAt: t });
    const rm = await enabled(base, a.id, `chat:${mgr.id}`, "to the manager");
    assert.equal(rm.status, 403, JSON.stringify(rm.body));
    assert.equal(store.listChannels(ws.id).length, count);

    // (7) foreign workspace
    fs.mkdirSync(`${wsPath}-2`, { recursive: true });
    const ws2 = await makeWorkspace(base, "Foreign", `${wsPath}-2`);
    const x = await makeChat(base, ws2.id);
    const r7 = await enabled(base, a.id, `chat:${x.id}`, "foreign");
    assert.equal(r7.status, 403, JSON.stringify(r7.body));
    assert.match(r7.body.error, /anderen Workspace/);
    assert.equal(store.listChannels(ws2.id).length, 0);
    await waitForQuiet();
  });
});

test("(4) archive: pause, write, archive the target, resume AND restart => the target stays archived, the cursor stays, a note at the sender; send => 409", async () => {
  await withServer(async ({ base, wsPath, waitForQuiet }) => {
    const ws = await makeWorkspace(base, "Archive", wsPath);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);
    const channelId = (await enabled(base, a.id, `chat:${b.id}`, "first")).body.channelId;
    await waitForQuiet();
    await ok(`${base}/api/channels/${channelId}/pause`, { method: "POST", body: JSON.stringify({ reason: "test" }) });
    assert.equal((await enabled(base, a.id, `chat:${b.id}`, "MARKER-ARCHIVE")).body.state, "paused");
    await archive(base, b.id);
    assert.ok(store.getChat(b.id).archivedAt);
    const cursor = store.getChannelParticipants(channelId, b.id).cursor;

    await ok(`${base}/api/channels/${channelId}/resume`, { method: "POST", body: JSON.stringify({}) });
    await waitForQuiet();
    channelRestartGrace();
    await waitForQuiet();
    assert.ok(store.getChat(b.id).archivedAt, "the target stays archived");
    assert.equal(await hasCard(base, b.id, "MARKER-ARCHIVE"), false, "no card at the archived target");
    assert.equal(store.getChannelParticipants(channelId, b.id).cursor, cursor, "the cursor stays");
    const notes = (await cards(base, a.id)).filter((k) => k.systemKind === "archived");
    assert.equal(notes.length, 1, "exactly one system note at the sender (also after resume AND restart)");
    // Its own identifier (the out card of the same sender carries the same seq), messageId stays null.
    assert.equal(notes[0].noteId, `archive:${b.id}:${store.getChannel(channelId).lastSeq}`, JSON.stringify(notes[0]));
    assert.equal(notes[0].messageId, null);
    // Also after a restart (the pre-filter in memory is empty) no second note.
    _clearArchiveReported();
    channelRestartGrace();
    await waitForQuiet();
    assert.equal((await cards(base, a.id)).filter((k) => k.systemKind === "archived").length, 1, "exactly one note after the restart too");

    // Sending to the archived chat - through chat: and through channel: - is 409, nothing is stored.
    const seq = store.getChannel(channelId).lastSeq;
    const r1 = await enabled(base, a.id, `chat:${b.id}`, "one more");
    assert.equal(r1.status, 409, JSON.stringify(r1.body));
    const r2 = await enabled(base, a.id, `channel:${channelId}`, "one more");
    assert.equal(r2.status, 409, JSON.stringify(r2.body));
    assert.equal(store.getChannel(channelId).lastSeq, seq);

    // The human brings B back: bringing it back delivers by itself (hook on chat restore) - no further cause.
    await archive(base, b.id, false);
    await waitForQuiet();
    assert.equal(await hasCard(base, b.id, "MARKER-ARCHIVE"), true, "delivered after being brought back");

    // fetchBack (doRun) does NOT bring back for cause channel/message, but does for the user.
    const c = await makeChat(base, ws.id);
    await archive(base, c.id);
    assert.equal(fetchBack(c.id, { cause: "channel" }), false);
    assert.equal(fetchBack(c.id, { cause: "message" }), false);
    assert.ok(store.getChat(c.id).archivedAt);
    assert.equal(fetchBack(c.id, { cause: "user" }), true);
    assert.equal(store.getChat(c.id).archivedAt ?? null, null);
    await waitForQuiet();
  });
});

test("(5) an open question card in the target holds the delivery (coding <-> coding) and is NOT answered; after the human's answer the message comes", async () => {
  await withServer(async ({ base, wsPath, waitForQuiet }) => {
    const ws = await makeWorkspace(base, "Card", wsPath);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);
    const requestId = `rq-${crypto.randomUUID()}`;
    store.addMessage(b.id, "ask", JSON.stringify({ requestId, questions: [{ question: "Which color?", header: "Color", options: [] }] }));
    const r = await enabled(base, a.id, `chat:${b.id}`, "MARKER-CARD");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, "earmarked", JSON.stringify(r.body));
    await waitForQuiet();
    const log = await ok(`${base}/api/chats/${b.id}/log`);
    assert.equal(log.some((z) => z.role === "ask_answer"), false, "the card is NOT answered");
    assert.equal(await hasCard(base, b.id, "MARKER-CARD"), false, "not delivered");
    assert.equal(store.getChannelParticipants(r.body.channelId, b.id).cursor, 0);

    // The human answers - after that (run end) the channel message comes.
    await ok(`${base}/api/chats/${b.id}/ask-answer`, { method: "POST", body: JSON.stringify({ requestId, answers: [{ text: "Blue" }] }) });
    await waitForQuiet();
    assert.equal(await hasCard(base, b.id, "MARKER-CARD"), true, "delivered after the answer");
  });
});

test("(8) fence: from a project network one reads and writes across project and instance boundaries; the old row chat-history stays in the project", async () => {
  await withServer(async ({ base, wsPath, waitForQuiet }) => {
    const ws = await makeWorkspace(base, "Fence", wsPath);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);
    store.addMessage(b.id, "assistant", "Tool state from project B");
    // The fence context as projectbox/fence.js gives it to the route: a is in the project, b is not.
    const fence = { identifier: "p/main", chatInProject: (id) => id === a.id };
    const url = (q) => new URL(`${base}/x?${new URLSearchParams(q)}`);
    const reader = store.getChat(a.id);
    assert.deepEqual((await readView(reader, url({}), fence)).body.chats.map((c) => c.id), [b.id]);
    assert.deepEqual((await readView(reader, url({ view: "chats" }), fence)).body.chats.map((c) => c.id), [b.id]);
    assert.equal((await readView(reader, url({ view: "chat", chatId: b.id, includeTools: "1" }), fence)).status, 200);
    const r = await sendMessage({ chat: reader, body: { to: `chat:${b.id}`, message: "across the border", from: "agent" }, fence });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitForQuiet();

    // The table: "chat-communication" no longer checks ?chatId against the project; "chat-history" stays with the project; the body
    // of "chat-agent-send" lets chat:<id> of any instance through (the route checks the workspace).
    const row = (f) => FENCE_TABLE.find((z) => z.family === f);
    assert.equal(row("chat-communication").query?.chatId, undefined);
    assert.match(row("chat-history").pattern, /:chatInProject/);
    assert.equal(BODY.agentSendInScope({}, { to: "chat:anywhere", from: "agent" }, { params: { chat: "c1" } }), null);
    for (const f of ["project-accesses", "workspace-accesses"]) assert.ok(row(f), f);
    assert.equal(row("workspace-accesses").rule, "rejected");
  });
});

test("(9) cap by hand on a coding <-> coding channel: paused with a note, but no wake-up call at the creator", async () => {
  await withServer(async ({ base, wsPath, waitForQuiet, turns }) => {
    const ws = await makeWorkspace(base, "Cap", wsPath);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);
    const k = await ok(`${base}/api/workspaces/${ws.id}/channels`, { method: "POST", body: JSON.stringify({ name: "K", participants: [a.id, b.id], creatorChatId: a.id, cap: 1 }) });
    const prior = turns().length;
    const r = await enabled(base, a.id, `channel:${k.id}`, "MARKER-CAP");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, "paused");
    await waitForQuiet();
    assert.equal(store.getChannel(k.id).pauseReason, "Cap");
    assert.ok((await cards(base, a.id)).some((x) => x.systemKind === "cap"), "the note is there");
    assert.equal(turns().slice(prior).some((x) => String(x.text).includes("Deckel erreicht")), false, "no wake-up call");
  });
});

// The list of kinds that do not belong in the index is bound to the markers (the data layer does not import runs/ and carries
// them as a literal): FINISHED_MARKER always, MESSAGE_MARKER as soon as runs/message-marker.js exists.
test("(6b) binding: CHAT_SEARCH_EXEMPT carries FINISHED_MARKER and MESSAGE_MARKER", async () => {
  assert.ok(store.CHAT_SEARCH_EXEMPT.includes(FINISHED_MARKER), FINISHED_MARKER);
  let message = null;
  try { message = await import("../electron/server/runs/message-marker.js"); } catch (e) { if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e; }
  const marker = message?.MESSAGE_MARKER ?? "<cbase-message";
  assert.ok(store.CHAT_SEARCH_EXEMPT.includes(marker), marker);
});

// ── Channel delivery ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(10) channel to a graph child chat: open run => the answer names the node route (\"earmarked\"); ended run => 409, nothing stored, the buffer holds, the cursor stays, no turn", async () => {
  await withServer(async ({ base, wsPath, waitForQuiet, turns }) => {
    const ws = await makeWorkspace(base, "Ended", wsPath);
    const parent = await makeChat(base, ws.id);
    const kind = await makeChat(base, ws.id);
    const startId = crypto.randomUUID();
    store.createGraphStart({ id: startId, chatId: parent.id, childChatId: kind.id, workflowId: "wf", workflowName: "WF-ended", shortName: "wfk", background: true, status: "earmarked" });
    // The node agent writes to the parent chat - a channel arises silently.
    const r1 = await enabled(base, kind.id, `chat:${parent.id}`, "MARKER-FROM-NODE");
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    const channelId = r1.body.channelId;
    await waitForQuiet();

    // The run is open, no node turn runs => earmarked, and the answer says exactly that.
    const r2 = await enabled(base, parent.id, `channel:${channelId}`, "MARKER-EARMARKED");
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.state, "earmarked", JSON.stringify(r2.body));
    assert.match(r2.body.text, /geht an den nächsten Node/);
    assert.equal(store.graphMessages(kind.id, { status: "earmarked" }).length, 1);
    await waitForQuiet();

    // Buffered while the run is open - then it ends (started without an open run = finished).
    await ok(`${base}/api/channels/${channelId}/pause`, { method: "POST", body: JSON.stringify({ reason: "test" }) });
    assert.equal((await enabled(base, parent.id, `channel:${channelId}`, "MARKER-BUFFERED")).body.state, "paused");
    store.changeGraphStart(startId, { status: "started" });
    const cursor = store.getChannelParticipants(channelId, kind.id).cursor;
    const seq = store.getChannel(channelId).lastSeq;
    const remembered = store.graphMessages(kind.id).length;

    // The tool and the old send route => 409 with the sentence from the graph target, nothing is stored.
    const r3 = await enabled(base, parent.id, `channel:${channelId}`, "MARKER-AFTER-END");
    assert.equal(r3.status, 409, JSON.stringify(r3.body));
    assert.equal(r3.body.error, "Der Workflow „WF-ended“ läuft nicht mehr.");
    const r4 = await json(`${base}/api/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify({ chatId: parent.id, text: "MARKER-OLD-ROUTE" }) });
    assert.equal(r4.status, 409, JSON.stringify(r4.body));
    assert.equal(store.getChannel(channelId).lastSeq, seq, "nothing stored");

    // Resume: the buffer holds at the ended run - no card, the cursor stays, nothing earmarked, no turn in the child chat.
    await ok(`${base}/api/channels/${channelId}/resume`, { method: "POST", body: JSON.stringify({}) });
    channelRestartGrace();
    await waitForQuiet();
    assert.equal(store.getChannelParticipants(channelId, kind.id).cursor, cursor, "the cursor stays");
    assert.equal(await hasCard(base, kind.id, "MARKER-BUFFERED"), false, "no card");
    assert.equal(store.graphMessages(kind.id).length, remembered, "nothing earmarked");
    assert.equal(turns().some((t) => String(t.text).includes("MARKER-BUFFERED")), false, "no turn");
  });
});

test("(11) the target runs, a channel message is queued, the target poses a question card and ends => no channel turn until the human's answer, then exactly one, each card once", async () => {
  await withServer(async ({ base, wsPath, waitForQuiet, turns }) => {
    const ws = await makeWorkspace(base, "Hold", wsPath);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);
    await enabled(base, a.id, `chat:${b.id}`, "first");
    await waitForQuiet();
    await ok(`${base}/api/chats/${b.id}/message`, { method: "POST", body: JSON.stringify({ text: "STAY-OPEN" }) });
    await waitFor(() => turns().some((t) => String(t.text).includes("STAY-OPEN")), "the turn of B runs");
    const r = await enabled(base, a.id, `chat:${b.id}`, "MARKER-QUEUED");
    assert.equal(r.body.state, "after_turn", JSON.stringify(r.body));
    assert.equal((pendingRunInputs.get(b.id) || []).filter((e) => e.cause === "channel").length, 1, "queued");
    // The turn poses a card (cbase_ask writes this row) and ends.
    const requestId = `rq-${crypto.randomUUID()}`;
    store.addMessage(b.id, "ask", JSON.stringify({ requestId, questions: [{ question: "Which color?", header: "Color", options: [] }] }));
    // The same question holds an agent message (cause "message") - a human's entry passes.
    assert.equal(channelInputHolds(b.id, { id: "x", cause: "message" }), true);
    assert.equal(channelInputHolds(b.id, { id: "y", cause: "user" }), false);
    await ok(`${base}/api/chats/${b.id}/stop`, { method: "POST", body: "{}" });
    await waitForQuiet();
    const channelTurns = () => turns().filter((t) => String(t.text).includes("MARKER-QUEUED")).length;
    assert.equal(channelTurns(), 0, "no channel turn while the card is open");
    assert.equal((pendingRunInputs.get(b.id) || []).length, 1, "the entry waits");

    await ok(`${base}/api/chats/${b.id}/ask-answer`, { method: "POST", body: JSON.stringify({ requestId, answers: [{ text: "Blue" }] }) });
    await waitForQuiet();
    assert.equal(channelTurns(), 1, "exactly one channel turn after the answer");
    assert.equal(channelInputHolds(b.id, { id: "x", cause: "message" }), false, "answered - nothing holds any more");
    assert.equal((await cards(base, b.id)).filter((k) => k.direction === "in" && String(k.text).includes("MARKER-QUEUED")).length, 1, "the card exactly once");
  });
});

test("(12) no run in the archive from a machine delivery; a silent agent message without a card is an error; the marker at the human input is defused", async () => {
  await withServer(async ({ base, wsPath, waitForQuiet, turns }) => {
    const ws = await makeWorkspace(base, "Catcher", wsPath);
    const c = await makeChat(base, ws.id);
    await archive(base, c.id);
    // Cause "channel" to an archived chat => nothing queued, no turn, it stays in the archive.
    const r = deliverUserPrompt(store.getChat(c.id), { prompt: "MARKER-K10", display: "MARKER-K10", cause: "channel", silent: true });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.archived, true);
    assert.equal(pendingRunInputs.get(c.id), undefined, "nothing queued");
    await waitForQuiet();
    assert.equal(turns().some((t) => String(t.text).includes("MARKER-K10")), false, "no turn");
    assert.ok(store.getChat(c.id).archivedAt, "stays in the archive");
    // ... and the catcher in doRun for a route that starts past deliverUserPrompt.
    startRun(store.getChat(c.id), "MARKER-K10b", { cause: "message" });
    await waitForQuiet();
    assert.equal(turns().some((t) => String(t.text).includes("MARKER-K10b")), false, "no turn from doRun");
    assert.ok(store.getChat(c.id).archivedAt, "stays in the archive");

    // Silent + cause "message" + the display IS the message => programming error.
    const d = await makeChat(base, ws.id);
    const n = buildMessage({ from: "X", address: "chat:x", text: "without a card" });
    assert.throws(() => deliverUserPrompt(store.getChat(d.id), { prompt: n, display: n, cause: "message", silent: true }), /silent only with a card of its own/);

    // The human types a text that begins like an agent message - it stays his message.
    const raw = `<cbase-message from="X" kind="agent" address="chat:1">\nMARKER-K3\n</cbase-message>`;
    await ok(`${base}/api/chats/${d.id}/message`, { method: "POST", body: JSON.stringify({ text: raw }) });
    await waitForQuiet();
    const row = store.listMessages(d.id).find((m) => m.role === "user" && m.text.includes("MARKER-K3"));
    assert.ok(row, "the row is there");
    assert.equal(isMessage(row.text), false, "no agent message");
    assert.equal(row.text.trim(), raw);
    // Queued it is an input of the human: dismissible - also with the completion-notice marker.
    await ok(`${base}/api/chats/${d.id}/message`, { method: "POST", body: JSON.stringify({ text: "STAY-OPEN" }) });
    await waitFor(() => turns().some((t) => String(t.text).includes("STAY-OPEN")), "the turn of D runs");
    const q = await ok(`${base}/api/chats/${d.id}/message`, { method: "POST", body: JSON.stringify({ text: `${FINISHED_MARKER}\nMARKER-K3b` }) });
    assert.ok(q.entryId, JSON.stringify(q));
    assert.equal((await json(`${base}/api/chats/${d.id}/message/queue/${q.entryId}`, { method: "DELETE" })).status, 200, "dismissible");
    await ok(`${base}/api/chats/${d.id}/stop`, { method: "POST", body: "{}" });
    await waitForQuiet();
  });
});

test("(13) closed => reopen (only from \"closed\"); publicChannel names archived and questionOpen; the out card names its counterpart", async () => {
  await withServer(async ({ base, wsPath, waitForQuiet }) => {
    const ws = await makeWorkspace(base, "Reopen", wsPath);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);
    const r1 = await enabled(base, a.id, `chat:${b.id}`, "MARKER-FIRST");
    const channelId = r1.body.channelId;
    await waitForQuiet();
    // The out card at A names B - in the history and in the 201 of the old send route.
    const name = (store.getChat(b.id).title || "Chat").trim();
    const output = (await cards(base, a.id)).find((k) => k.direction === "out" && k.text === "MARKER-FIRST");
    assert.deepEqual(output?.recipient, { chatId: b.id, name }, JSON.stringify(output));
    const r201 = await ok(`${base}/api/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify({ chatId: a.id, text: "MARKER-ROUTE" }) });
    assert.deepEqual(r201.recipient, { chatId: b.id, name });
    await waitForQuiet();

    // Open => 409; closed => open, note "opened" at both, the same channel carries again.
    assert.equal((await json(`${base}/api/channels/${channelId}/open`, { method: "POST", body: "{}" })).status, 409);
    await ok(`${base}/api/channels/${channelId}/close`, { method: "POST", body: JSON.stringify({ reason: "test" }) });
    assert.equal((await enabled(base, a.id, `chat:${b.id}`, "closed")).status, 409);
    const on = await ok(`${base}/api/channels/${channelId}/open`, { method: "POST", body: "{}" });
    assert.equal(on.status, "open", JSON.stringify(on));
    assert.equal(on.agentsSinceHuman, 0);
    assert.ok(Array.isArray(on.participants), "shape as for pause/resume (publicChannel)");
    for (const id of [a.id, b.id]) assert.ok((await cards(base, id)).some((k) => k.systemKind === "opened"), `note at ${id}`);
    const r2 = await enabled(base, a.id, `chat:${b.id}`, "MARKER-AGAIN");
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.channelId, channelId);
    assert.equal(channelsBetween(a.id, b.id).length, 1, "no second channel");
    await waitForQuiet();
    assert.equal(await hasCard(base, b.id, "MARKER-AGAIN"), true);
    // rejected => 409.
    store.updateChannel(channelId, { status: "rejected" });
    assert.equal((await json(`${base}/api/channels/${channelId}/open`, { method: "POST", body: "{}" })).status, 409);
    store.updateChannel(channelId, { status: "open" });

    // Per participant `archived` and `questionOpen`.
    const participants = async () => new Map((await ok(`${base}/api/channels/${channelId}`)).participants.map((t) => [t.chatId, t]));
    let t = await participants();
    assert.equal(t.get(b.id).archived, false);
    assert.equal(t.get(b.id).questionOpen, false);
    store.addMessage(b.id, "ask", JSON.stringify({ requestId: `rq-${crypto.randomUUID()}`, questions: [{ question: "?", header: "", options: [] }] }));
    await archive(base, a.id);
    t = await participants();
    assert.equal(t.get(b.id).questionOpen, true);
    assert.equal(t.get(a.id).archived, true);
    assert.equal(t.get(a.id).questionOpen, false);
  });
});
