// A new chat only on sending — the server side.
//
// The clients open "New chat" as a draft and create it only on the first send. The server turns this into a promise that does not
// hang on every client: a chat WITHOUT a single row in `messages` (any role) is in no list the clients read — `GET /api/chats` on
// every `archive=` page and the number `chatCount` at `GET /api/chat-folders` —, but stays open through `GET /api/chats/:id`. The
// first row brings it into the list. Nothing is deleted. The agents' tools still see every chat — shown here through the view
// `chats` of `GET /api/chats/:id/communication` (cbase_agents_list).
//
// Counter-tests (each shown red once and taken back):
//   `onlyWithMessage: true` removed in chats/routes.js chatListRoute        ⇒ "Coding …" red (the empty chat is in the list)
//   the same at `store.chatFolderCounts` in chatFolderRoutes                ⇒ "Queued …" red (chatCount counts the empty one)
//   `onlyWithMessage` on by default in store/chats.js listChats             ⇒ "Coding …" red (the agents' view loses it)
//   the `run_inputs` part of WITH_MESSAGE_OR_QUEUED_SQL removed
//   (the filter that looked at `messages` only)                             ⇒ "Queued …" red (the chat is missing in both)
//
// Scheduled jobs: a chat that carries a job is in the list even EMPTY — it is created with the job, written to only at the first
// appointment — and is no candidate of the auto archive. Counter-tests (each shown red once and taken back):
//   the part `OR chats.job_id IS NOT NULL` removed in WITH_MESSAGE_OR_QUEUED_SQL ⇒ "Scheduled …" red (list and chatCount)
//   `AND c.job_id IS NULL` removed in AUTO_ARCHIVE_SQL                      ⇒ "Scheduled …" red (the job chat becomes a candidate)
//
// A queued FIRST message (e.g. under the project lock, runs/queue.js `locked: true`) writes its row into `messages` only at the
// start — until then it exists only in the queue (`pendingRunInputs`, mirrored in `run_inputs`). Such a chat belongs in the lists,
// otherwise nobody finds it again.
//
// Run alone: CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/chat-list-without-empty.test.js

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { MODEL, json, makeChat, makeWorkspace, ok, withServer } from "./server-harness.mjs";
import * as store from "../electron/server/store.js";
import { pendingRunInputs, persistRunInputs } from "../electron/server/runs/state.js";

const ids = (list) => list.map((c) => c.id);
const archive = (base, id) => json(`${base}/api/chats/${id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });

test("Coding: an empty chat is on no page of GET /api/chats and counts in no folder, stays open through GET /api/chats/:id, and the first row (any role) brings it into the list — the agents' view sees it all along", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Draft", wsPath);
    const full = await makeChat(base, ws.id);
    store.addMessage(full.id, "user", "First question");
    const empty = await makeChat(base, ws.id);
    const list = async (q = "") => ids(await ok(`${base}/api/chats?workspaceId=${ws.id}${q}`));

    for (const q of ["", "&archive=without", "&archive=including", "&stats=1"]) {
      const l = await list(q);
      assert.ok(l.includes(full.id), `${q || "default"}: the described chat is in the list`);
      assert.equal(l.includes(empty.id), false, `${q || "default"}: the empty chat is NOT in the list`);
    }
    const open = await json(`${base}/api/chats/${empty.id}`);
    assert.equal(open.status, 200, "GET /api/chats/:id still returns the empty chat (it is open)");
    assert.equal(open.body.id, empty.id);
    assert.equal(open.body.archiveReason, null, "active ⇒ archiveReason null");

    // The folder count counts what the list below shows.
    const f = await ok(`${base}/api/chat-folders`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, name: "Folder" }) });
    for (const c of [full, empty]) await ok(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ folderId: f.id }) });
    const count = async (q = "") => (await ok(`${base}/api/chat-folders?workspaceId=${ws.id}${q}`)).find((x) => x.id === f.id)?.chatCount;
    assert.equal(await count(), 1, "chatCount counts only the described chat");

    // The agents' tools stay as they are: cbase_agents_list (view chats) still reads the empty chat.
    const view = await ok(`${base}/api/chats/${full.id}/communication?view=chats`);
    assert.ok(view.chats.some((c) => c.id === empty.id), `the agents' view names the empty chat: ${JSON.stringify(view.chats.map((c) => c.id))}`);
    assert.ok(ids(store.listChats(ws.id)).includes(empty.id), "without the option the store still reads every chat");

    // The first row — here one of the assistant, ANY role counts — brings it into the list and into the count.
    store.addMessage(empty.id, "assistant", "Ready.");
    assert.ok((await list()).includes(empty.id), "with its first row it is in the list");
    assert.equal(await count(), 2);

    // The archive shows no empty ones either: an empty chat can be archived (no open work), but is not shown there.
    const empty2 = await makeChat(base, ws.id);
    assert.equal((await archive(base, empty2.id)).status, 200);
    assert.equal(typeof store.getChat(empty2.id).archivedAt, "number", "it is archived");
    assert.equal((await list("&archive=only")).includes(empty2.id), false, "archive=only: the empty one is not in the archive");
    assert.equal((await list("&archive=including")).includes(empty2.id), false, "archive=including likewise");
    assert.equal((await archive(base, full.id)).status, 200);
    assert.deepEqual(await list("&archive=only"), [full.id], "the described one is in the archive");
  });
});

test("Queued: a chat whose FIRST message is only in the queue (no row in messages yet) is in GET /api/chats and in chatCount — when dismissed it drops out again", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Queued", wsPath);
    const coding = await makeChat(base, ws.id);
    const f = await ok(`${base}/api/chat-folders`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, name: "Folder" }) });
    await ok(`${base}/api/chats/${coding.id}`, { method: "PATCH", body: JSON.stringify({ folderId: f.id }) });
    const codingList = async () => ids(await ok(`${base}/api/chats?workspaceId=${ws.id}`));
    const count = async () => (await ok(`${base}/api/chat-folders?workspaceId=${ws.id}`)).find((x) => x.id === f.id)?.chatCount;
    // As runs/queue.js enqueueRunInput queues (deliverUserPrompt, `locked` branch): entry in the map, mirror to run_inputs.
    const enqueue = (chatId, text) => {
      pendingRunInputs.set(chatId, [{ id: crypto.randomUUID(), prompt: text, display: text, attachments: [], cause: "user", causeSpecified: true, silent: false }]);
      persistRunInputs(chatId);
    };
    const dismiss = (chatId) => { pendingRunInputs.delete(chatId); persistRunInputs(chatId); };
    try {
      assert.equal((await codingList()).includes(coding.id), false, "empty before ⇒ not in the list");
      enqueue(coding.id, "First question, queued");
      assert.equal(store.listMessages(coding.id).length, 0, "the user row appears only at the start");

      assert.ok((await codingList()).includes(coding.id), "Coding: the queued chat is in the list");
      assert.equal(await count(), 1, "chatCount counts it");

      // Dismissed (cancelRunInput empties the queue) and still without a row ⇒ a draft again, in no list.
      dismiss(coding.id);
      assert.equal((await codingList()).includes(coding.id), false, "without input and without a row outside again");
      assert.equal(await count(), 0);
    } finally {
      dismiss(coding.id);
    }
  });
});

test("Scheduled: a chat with a job is in GET /api/chats and in chatCount even when empty and is no candidate of the auto archive; deleting the job leaves the chat (it stays), and deleting the workspace empties both tables", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Scheduled", wsPath);
    const neighbor = await makeWorkspace(base, "Neighbor", `${wsPath}-neighbor`);
    const now = Date.now();
    const job = (wid, id) => store.createScheduledJob({ id, workspaceId: wid, instructions: "Enter working hours.", cadence: "workdays", plan: { clockTime: "22:00" }, cron: "0 22 * * 1-5", timeZone: "Europe/Berlin", nextAt: now + 60_000, createdAt: now });
    const chatWith = (wid, jobId, title) => store.createChat({ id: crypto.randomUUID(), workspaceId: wid, title, provider: "claude", model: MODEL, permissionMode: "bypassPermissions", jobId, createdAt: now, updatedAt: now });
    const a = job(ws.id, crypto.randomUUID());
    const chat = chatWith(ws.id, a.id, "Working hours");
    const b = job(neighbor.id, crypto.randomUUID());
    chatWith(neighbor.id, b.id, "Neighbor job");
    const list = async () => ids(await ok(`${base}/api/chats?workspaceId=${ws.id}`));

    assert.equal(store.listMessages(chat.id).length, 0, "the job chat is empty");
    assert.equal(store.getChat(chat.id).jobId, a.id, "mapChat carries the binding");
    assert.equal(store.jobOfTheChat(chat.id)?.id, a.id, "the binding reads from both sides");
    assert.equal(store.getScheduledJob(a.id).chatId, chat.id);
    assert.ok((await list()).includes(chat.id), "the empty job chat is in the list");
    const empty = await makeChat(base, ws.id);
    assert.equal((await list()).includes(empty.id), false, "an empty chat without a job stays out (counterpart)");
    const f = await ok(`${base}/api/chat-folders`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, name: "Appointments" }) });
    await ok(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ folderId: f.id }) });
    const count = async () => (await ok(`${base}/api/chat-folders?workspaceId=${ws.id}`)).find((x) => x.id === f.id)?.chatCount;
    assert.equal(await count(), 1, "chatCount counts the empty job chat");

    // One job, one chat: the partial index holds it in the database; empty means NULL and does not collide.
    assert.throws(() => chatWith(ws.id, a.id, "Second"), /UNIQUE/, "a second chat with the same job is rejected");
    assert.equal(store.updateChat(empty.id, { jobId: "" }).jobId, null, "an empty value writes NULL");

    // Auto archive: silent for long, with a row — the job chat is still no candidate, a chat without a job is.
    store.addMessage(chat.id, "assistant", "Entered.", now - 1000);
    store.addMessage(empty.id, "assistant", "Ready.", now - 1000);
    const candidates = ids(store.autoArchiveCandidates(now + 365 * 86_400_000));
    assert.equal(candidates.includes(chat.id), false, "the job chat does not archive itself");
    assert.ok(candidates.includes(empty.id), "a silent chat without a job is a candidate (counterpart)");

    // Runs belong to the job.
    const run = store.createScheduledRun({ jobId: a.id, workspaceId: ws.id, chatId: chat.id, cause: "tick", scheduledAt: now, entryId: "e-1" });
    assert.deepEqual(store.openScheduledRuns(a.id).map((l) => l.id), [run.id]);
    assert.equal(store.updateScheduledRun(run.id, { status: "ok", short: "Done." }).status, "ok");
    assert.deepEqual(store.openScheduledRuns(a.id), []);
    assert.deepEqual(store.listScheduledRuns(a.id).map((l) => l.id), [run.id]);

    // Deleting the job: the chat stays, loses the binding, and with that the auto archive applies again.
    const second = job(ws.id, crypto.randomUUID());
    const chat2 = chatWith(ws.id, second.id, "Weekly");
    store.addMessage(chat2.id, "assistant", "Report.", now - 1000);
    store.createScheduledRun({ jobId: second.id, workspaceId: ws.id, chatId: chat2.id });
    assert.deepEqual(store.deleteScheduledJob(second.id), { deleted: true, chatId: chat2.id });
    assert.equal(store.getScheduledJob(second.id), null);
    assert.deepEqual(store.listScheduledRuns(second.id), [], "the runs fall with it");
    assert.equal(store.getChat(chat2.id)?.jobId, null, "the chat stays and loses the binding");
    assert.ok(ids(store.autoArchiveCandidates(now + 365 * 86_400_000)).includes(chat2.id), "without a job it is a candidate again");

    // Deleting the workspace: both tables empty for it, the neighbor keeps its job.
    const dw = await fetch(`${base}/api/workspaces/${ws.id}`, { method: "DELETE", headers: { Connection: "close" } });
    assert.equal(dw.status, 200, await dw.text());
    assert.deepEqual(store.listScheduledJobs(ws.id), [], "no jobs left in the deleted workspace");
    assert.deepEqual(store.listScheduledRuns(a.id), [], "no runs left");
    assert.deepEqual(store.listScheduledJobs(neighbor.id).map((x) => x.id), [b.id], "the neighbor keeps its job");
  });
});
