// Agent communication: the read route GET /api/chats/:id/communication (communication/read.js) - overview, chat list, chat,
// channel - on the real server. What is readable is decided by ONE predicate (communication/visibility.js).
//
// Counter-tests (which sabotage turns which test red):
//   visibility.js: isChildChat branch removed                          => (2) red (child chat in the list)
//   visibility.js: readableReason with commonChannel again            => (2) and (6) red (a channel made the manager readable)
//   read.js: SUMMARY_CAP 200                                          => (3) red
//   read.js: the project boundary (inside-fence check) back           => (5) red
//   read.js: `note` removed from the view chat                        => (1) red
//   search.js without the note hits in `matching` (withNotes)         => (notes) red (the search did not find the note)
//   the route missing (404)                                           => all red
// A manager chat (legacy only) is readable in NO situation - not even as partner of an approved channel. (2) and (6) check that;
// its channel stays in the overview and in the view channel.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { NOTE, NOTE_SOURCE, readView } from "../electron/server/communication/read.js";
import { json, makeChat, makeWorkspace, ok, withServer } from "./server-harness.mjs";

const read = (base, chatId, q = {}) => json(`${base}/api/chats/${chatId}/communication?${new URLSearchParams(q)}`);

test("read: coding chats yes, child chats never, manager chats never (not even as channel partner), foreign workspace 403 - every view carries note", async () => {
  await withServer(async ({ base, wsPath, root, oneshots }) => {
    const ws = await makeWorkspace(base, "Read", wsPath);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);
    store.addMessage(b.id, "user", "FIRST-MESSAGE of B");
    store.addMessage(b.id, "assistant", "Reply of B");
    const kind = await makeChat(base, ws.id);
    store.createGraphStart({ id: crypto.randomUUID(), chatId: b.id, childChatId: kind.id, workflowId: "wf", workflowName: "WF", shortName: "wf", status: "running" });
    const t = Date.now();
    const mgr = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", agentId: "ag-1", title: "Manager", createdAt: t, updatedAt: t });

    // (1) Reading a coding chat: lines, note; search over the first user message.
    const rb = await read(base, a.id, { view: "chat", chatId: b.id });
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    assert.equal(rb.body.note, NOTE);
    assert.deepEqual(rb.body.lines.map((z) => z.role), ["user", "assistant"]);
    assert.equal(rb.body.total, 2);
    const sheet = await read(base, a.id, { view: "chat", chatId: b.id, from: 1, limit: 1 });
    assert.deepEqual([sheet.body.from, sheet.body.until, sheet.body.lines[0]?.text], [1, 2, "Reply of B"], "paging with from");
    const search = await read(base, a.id, { view: "chats", search: "first-message" });
    assert.deepEqual(search.body.chats.map((c) => c.id), [b.id]);
    assert.equal(search.body.chats[0].firstMessage, "FIRST-MESSAGE of B");
    assert.equal(search.body.note, NOTE);

    // (2) Child chat: never - neither in the list nor readable.
    const all = await read(base, a.id, { view: "chats" });
    assert.ok(!all.body.chats.some((c) => c.id === kind.id), "no child chat in the list");
    assert.ok(!all.body.chats.some((c) => c.id === a.id), "not the reader itself");
    assert.equal((await read(base, a.id, { view: "chat", chatId: kind.id })).status, 403);
    // Manager chat: without a channel neither listed nor readable ...
    assert.ok(!all.body.chats.some((c) => c.id === mgr.id));
    assert.equal((await read(base, a.id, { view: "chat", chatId: mgr.id })).status, 403);
    // ... and as partner of an existing channel neither; the channel itself is in the overview, and the view channel reads it. A
    // channel with a manager chat can no longer be created (409, channels/lifecycle.js) - the legacy sits in the store.
    const k = store.createChannel({ id: crypto.randomUUID(), workspaceId: ws.id, name: "K", status: "open", cap: 0, creatorChatId: mgr.id, createdAt: Date.now() });
    for (const chatId of [mgr.id, a.id]) store.addChannelParticipants(k.id, { chatId });
    assert.equal((await read(base, a.id, { view: "chat", chatId: mgr.id })).status, 403, "not readable even with a channel");
    assert.ok(!(await read(base, a.id, { view: "chats" })).body.chats.some((c) => c.id === mgr.id), "not listed even with a channel");
    const ue = await read(base, a.id);
    assert.equal(ue.body.view, "summary");
    assert.deepEqual(ue.body.channelPartner.map((x) => x.channelId), [k.id]);
    assert.deepEqual(Object.keys(ue.body.workflowAgents), ["entries", "hint"], "named empty contribution");
    assert.deepEqual(ue.body.graphRuns.entries, []);
    // The contribution `notes` names the source and the foreign-text hint; without a note each chat shows its first user message.
    assert.equal(ue.body.notes.source, NOTE_SOURCE);
    assert.match(ue.body.notes.hint, /Fremdtext/);
    assert.equal(ue.body.chats.find((c) => c.id === b.id)?.firstMessage, "FIRST-MESSAGE of B");
    assert.equal(typeof ue.body.agents.types, "number");
    const kl = await read(base, a.id, { view: "channel", channelId: k.id });
    assert.equal(kl.status, 200, JSON.stringify(kl.body));
    assert.equal(kl.body.note, NOTE);
    assert.equal((await read(base, b.id, { view: "channel", channelId: k.id })).status, 404, "only a participant reads the channel");

    // Summary on retrieval (retrieval.js): ONE sealed oneshot (the fake CLI answers "Title"), not stored.
    const prior = oneshots().length;
    const zs = await read(base, a.id, { view: "chat", chatId: b.id, summarize: true });
    assert.equal(zs.status, 200, JSON.stringify(zs.body));
    assert.equal(typeof zs.body.summary, "string", JSON.stringify(zs.body));
    assert.equal(zs.body.note, NOTE);
    assert.equal(oneshots().length, prior + 1, "exactly one model call");

    // Foreign workspace => 403.
    const ws2 = await makeWorkspace(base, "Foreign", path.join(root, "foreign"));
    const f = await makeChat(base, ws2.id);
    const rf = await read(base, a.id, { view: "chat", chatId: f.id });
    assert.equal(rf.status, 403);
    assert.match(rf.body.error, /anderen Workspace/);
    assert.equal((await read(base, a.id, { view: "nonexistent" })).status, 400);
  });
});

test("read: the overview is capped at 20 and says \"N more\"", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Cap", wsPath);
    const reader = await makeChat(base, ws.id);
    for (let i = 0; i < 23; i++) await makeChat(base, ws.id);
    const r = await read(base, reader.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // (3) 23 other chats: 20 shown, 3 more - and the cap is stated.
    assert.equal(r.body.chats.length, 20);
    assert.equal(r.body.cap, 20);
    assert.equal(r.body.additional, 3);
    assert.match(r.body.hint, /3 weitere/);
    assert.equal((await read(base, reader.id, { view: "chats", limit: 200 })).body.chats.length, 23, "the chat list shows all");
  });
});

test("read: from a project network (fence context) overview and list show the chats of ALL projects of the workspace, and reading across works", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Fence", wsPath);
    const reader = await makeChat(base, ws.id);
    const inside = await makeChat(base, ws.id);
    const outside = await makeChat(base, ws.id);
    // A fence context that names the chats of the project - the route no longer asks it.
    const fence = { identifier: "p/main", chatInProject: (id) => id === reader.id || id === inside.id };
    const url = (q) => new URL(`${base}/x?${new URLSearchParams(q)}`);
    const ue = await readView(store.getChat(reader.id), url({}), fence);
    // (5) across project and instance boundaries.
    assert.deepEqual(ue.body.chats.map((c) => c.id).sort(), [inside.id, outside.id].sort());
    assert.deepEqual((await readView(store.getChat(reader.id), url({ view: "chats" }), fence)).body.chats.map((c) => c.id).sort(), [inside.id, outside.id].sort());
    assert.equal((await readView(store.getChat(reader.id), url({ view: "chat", chatId: outside.id }), fence)).status, 200);
    assert.equal((await readView(store.getChat(reader.id), url({ view: "chat", chatId: inside.id }), fence)).status, 200);
    // Without a fence (B itself) the same reader sees both.
    assert.deepEqual((await readView(store.getChat(reader.id), url({ view: "chats" }), null)).body.chats.map((c) => c.id).sort(), [inside.id, outside.id].sort());
  });
});

test("read (6): a manager conversation is readable in no state of its channel - waiting, rejected, approved and closed alike, in no view", async () => {
  await withServer(async ({ base, wsPath, waitForQuiet }) => {
    const ws = await makeWorkspace(base, "Partner", wsPath);
    const a = await makeChat(base, ws.id);
    const t = Date.now();
    const mgr = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", agentId: "ag-1", title: "Manager", createdAt: t, updatedAt: t });
    store.addMessage(mgr.id, "assistant", "SECRET from facts and Teams");
    // The legacy a manager agent created with chat:<A>: a channel in state "waiting" with both participants (a manager chat no
    // longer writes - the send route is 409 - but its legacy is still read).
    assert.equal((await json(`${base}/api/chats/${mgr.id}/agent/send`, { method: "POST", body: JSON.stringify({ to: `chat:${a.id}`, message: "Hello", from: "agent" }) })).status, 409);
    const channel = store.createChannel({ id: crypto.randomUUID(), workspaceId: ws.id, name: "Manager", status: "waiting", cap: 0, creatorChatId: mgr.id, createdAt: Date.now() });
    for (const chatId of [mgr.id, a.id]) store.addChannelParticipants(channel.id, { chatId });
    const r = { body: { channelId: channel.id } };
    const notReadable = async (when) => {
      const rc = await read(base, a.id, { view: "chat", chatId: mgr.id, includeTools: true });
      assert.equal(rc.status, 403, `${when}: ${JSON.stringify(rc.body)}`);
      assert.ok(!(await read(base, a.id, { view: "chats" })).body.chats.some((c) => c.id === mgr.id), `${when}: not in chats`);
      assert.ok(!(await read(base, a.id)).body.chats.some((c) => c.id === mgr.id), `${when}: not in the overview`);
    };
    await notReadable("waiting");
    // Approval (open) does not make the conversation readable, and neither does closing.
    for (const status of ["rejected", "open", "closed"]) {
      store.updateChannel(r.body.channelId, { status });
      await notReadable(status);
    }
    await waitForQuiet();
  });
});

test("read (notes): the summarizer's note replaces the first user message - with source and note; the search finds its text; notes of other outer-loop agents never", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Notes", wsPath);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);
    const c = await makeChat(base, ws.id);
    store.addMessage(b.id, "user", "FIRST-MESSAGE of B");
    store.addMessage(c.id, "user", "FIRST-MESSAGE of C");
    const summarizer = store.outerLoopSummarizer(ws.id);
    assert.ok(summarizer, "the workspace POST seeded the summarizer");
    const other = store.createOuterLoopAgent({ id: crypto.randomUUID(), workspaceId: ws.id, name: "Other", trigger: [{ kind: "quiet", minutes: 5 }], provider: "claude", model: "m" });
    store.createOuterLoopNote({ agentId: summarizer.id, chatId: b.id, runId: "l-old", text: "OLD-NOTE about the till", at: 1 });
    store.createOuterLoopNote({ agentId: summarizer.id, chatId: b.id, runId: "l-new", text: "TILLNOTE: B rebuilds the till", at: 2 });
    store.createOuterLoopNote({ agentId: other.id, chatId: c.id, runId: "l-x", text: "FOREIGNNOTE of another agent", at: 3 });

    // Overview: B carries the newest note (instead of the first message), C without a summarizer note its first message.
    const ue = await read(base, a.id);
    assert.equal(ue.status, 200, JSON.stringify(ue.body));
    assert.equal(ue.body.note, NOTE);
    const eb = ue.body.chats.find((x) => x.id === b.id);
    assert.deepEqual(eb.note, { text: "TILLNOTE: B rebuilds the till", at: 2, source: NOTE_SOURCE, agentId: summarizer.id });
    assert.equal("firstMessage" in eb, false, "the note replaces the first message");
    const ec = ue.body.chats.find((x) => x.id === c.id);
    assert.equal(ec.note, undefined, "the note of another agent never appears");
    assert.equal(ec.firstMessage, "FIRST-MESSAGE of C");
    assert.equal(ue.body.notes.source, NOTE_SOURCE);
    // The list and the header of the view chat likewise.
    const list = await read(base, a.id, { view: "chats" });
    assert.equal(list.body.chats.find((x) => x.id === b.id)?.note?.source, NOTE_SOURCE);
    const rb = await read(base, a.id, { view: "chat", chatId: b.id });
    assert.equal(rb.body.note, NOTE);
    assert.equal(rb.body.chat.note?.text, "TILLNOTE: B rebuilds the till");
    // The search finds the note text (role "note" before the message hits) - not that of the other agent.
    const search = await read(base, a.id, { view: "chats", search: "tillnote" });
    assert.deepEqual(search.body.chats.map((x) => x.id), [b.id]);
    assert.equal(search.body.chats[0].hits?.[0]?.role, "note");
    assert.match(search.body.chats[0].hits[0].excerpt, /TILLNOTE/);
    assert.deepEqual((await read(base, a.id, { view: "chats", search: "foreignnote" })).body.chats, [], "notes of other agents are not in the index");
  });
});
