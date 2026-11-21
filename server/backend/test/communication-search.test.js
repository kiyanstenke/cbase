// Agent communication: the full-text search over the view `chats` with `search` (store/chat-search.js, communication/search.js,
// communication/read.js) and its description (mcp/tools/agents.js):
//   (6)  only readable chats, without completion notices and agent messages; the backlog is brought along in batches; deleting
//        clears the INDEX itself (read IN the index, not through chatSearchHits, which joins `messages` - without the delete
//        trigger that check would stay green)
//   (S1) a chat with over 1000 hits displaces no other; `total` is right; per chat three hits, `hitsTotal` when there are more -
//        and the description names both fields
//   (S2) a database with an outdated trigger wording is recreated on start and brought along
//   (S3) the user row of a turn with cause "event"/"channel" is not in the index, the human's is
//   (S4) the excerpt finds a word that matches only through diacritics
//   (S5) the times of the hits are in wall time
//   (S6) a search on an incomplete index starts the backfill; throttled after a failure
//   (S7) description = execution: tool and tool primer name full text, hits and indexIncomplete
//
// Counter-tests (which sabotage turns which test red):
//   chat-search.js: delete trigger messages_fts_ad removed                       => (6) red (ids still in the index)
//   queue.js: `cause` removed from addMessage                                    => (S3) red (event text found)
//   (S1) with only ONE chat in the list; (S2) with a completely reported index under the old rule.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import * as store from "../electron/server/store.js";
import * as dbModule from "../electron/server/store/db.js";
import { readView } from "../electron/server/communication/read.js";
import * as search from "../electron/server/communication/search.js";
import { FINISHED_MARKER } from "../electron/server/runs/completionNotice.js";
import { CAUSES } from "../electron/server/runs/state.js";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import { toolPrimer } from "../electron/server/toolchain/tool-catalog.js";
import * as agentsTools from "../electron/mcp/tools/agents.js";
import { makeChat, makeWorkspace, ok, withServer } from "./server-harness.mjs";

const { bringAlongChatSearch } = search;
const url = (base, q) => new URL(`${base}/x?${new URLSearchParams(q)}`);
const searchIn = async (base, readerId, word) => (await readView(store.getChat(readerId), url(base, { view: "chats", search: word }))).body;
const list = agentsTools.agentTools.find((t) => t.name === "cbase_agents_list");
const MAIN = { depth: 0, workflowAgent: "", onlySubagents: false, writePermission: "no", withAgent: true, schedule: false };
const inIndex = (word) => dbModule.db.prepare("SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ?").all(`"${word}"*`).map((r) => r.id);

test("(6) full-text search: only readable chats, without completion notice and agent message, the backlog in batches, deleting clears the index itself", async () => {
  await withServer(async ({ base, wsPath, waitForQuiet }) => {
    const ws = await makeWorkspace(base, "Search", wsPath);
    const reader = await makeChat(base, ws.id);
    const c = await makeChat(base, ws.id);
    const d = await makeChat(base, ws.id);
    const kind = await makeChat(base, ws.id);
    store.createGraphStart({ id: crypto.randomUUID(), chatId: c.id, childChatId: kind.id, workflowId: "wf", workflowName: "WF", shortName: "wf", status: "running" });
    const t = Date.now();
    const mgr = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", agentId: "ag-1", createdAt: t, updatedAt: t });
    store.addMessage(c.id, "user", "Please check the magicword filter in the till module");
    store.addMessage(c.id, "assistant", "Done: the magicword is now in the configuration.");
    store.addMessage(d.id, "assistant", "Nothing on that here.");
    store.addMessage(d.id, "user", "<task-notification>\n<summary>Magicword from a subagent</summary>\n</task-notification>");
    store.addMessage(d.id, "user", "<cbase-message from=\"X\" kind=\"agent\" address=\"chat:1\">\nMagicword from another agent\n</cbase-message>");
    store.addMessage(mgr.id, "assistant", "Magicword in the manager");
    store.addMessage(kind.id, "assistant", "Magicword in the child");
    const s = (word) => searchIn(base, reader.id, word);

    const r = await s("magicword");
    assert.deepEqual(r.chats.map((x) => x.id), [c.id], JSON.stringify(r.chats));
    assert.ok(r.note, "foreign text marked");
    const hits = r.chats[0].hits;
    assert.ok(Array.isArray(hits) && hits.length === 2, JSON.stringify(hits));
    assert.ok(hits.every((x) => /magicword/i.test(x.excerpt) && x.excerpt.length <= 260), JSON.stringify(hits));
    assert.deepEqual(hits.map((x) => x.role).sort(), ["assistant", "user"]);
    assert.equal(r.chats[0].hitsTotal, undefined, "not capped => no hitsTotal");
    // Several words: all must occur.
    assert.deepEqual((await s("magicword configuration")).chats.map((x) => x.id), [c.id]);
    assert.deepEqual((await s("magicword nowhere")).chats.map((x) => x.id), []);

    // The backlog: the index is reset and brought along in batches - until then the view says it is incomplete. "configuration"
    // occurs only in a reply - title and first user message do not find it. The backfill yields a round before each batch: a
    // search right after the start still sees the empty index.
    store.chatSearchResetForTest();
    const run = bringAlongChatSearch({ stack: 2 });
    const half = await s("configuration");
    assert.deepEqual(half.chats.map((x) => x.id), []);
    assert.equal(half.indexIncomplete, true);
    const stack = await run;
    assert.ok(stack >= 2, `brought along in batches (${stack})`);
    const full = await s("configuration");
    assert.deepEqual(full.chats.map((x) => x.id), [c.id]);
    assert.equal(full.indexIncomplete, undefined);

    // Deleting a chat clears its index - read IN the index, not through a query that joins `messages`.
    const ids = dbModule.db.prepare("SELECT id FROM messages WHERE chat_id = ?").all(c.id).map((z) => z.id);
    assert.ok(inIndex("magicword").some((id) => ids.includes(id)), "in the index before");
    await ok(`${base}/api/chats/${c.id}`, { method: "DELETE" });
    assert.deepEqual(inIndex("magicword").filter((id) => ids.includes(id)), [], "no entry left afterwards");
    await waitForQuiet();
  });
});

test("(S1) a chat with over 1000 hits displaces no other; total is right; hitsTotal says it was capped", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Many", wsPath);
    const reader = await makeChat(base, ws.id);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);
    store.addMessage(a.id, "user", "Here we go");
    dbModule.inOneTransaction(() => { for (let i = 0; i < 1100; i += 1) store.addMessage(a.id, "assistant", `deploy ${i}`); });
    store.addMessage(b.id, "user", "Hello");
    // Long and with ONE hit - its rank lies behind each of the 1100 short rows of a.
    store.addMessage(b.id, "assistant", `${"A long report about much else, step by step. ".repeat(40)}At the end: deploy.`);

    const r = await searchIn(base, reader.id, "deploy");
    assert.deepEqual(r.chats.map((x) => x.id).sort(), [a.id, b.id].sort(), JSON.stringify(r.chats.map((x) => x.id)));
    assert.equal(r.total, 2);
    const ea = r.chats.find((x) => x.id === a.id);
    const eb = r.chats.find((x) => x.id === b.id);
    assert.equal(ea.hits.length, 3);
    assert.equal(ea.hitsTotal, 1100, "the per-chat cap says it is one");
    assert.equal(eb.hits.length, 1);
    assert.equal(eb.hitsTotal, undefined);
    assert.match(eb.hits[0].excerpt, /deploy/);
    // The field `search` names every field the view carries here (at the field rather than in the tool description; both are in
    // the same tools/list answer).
    const description = list.inputSchema(MAIN).properties.search.description;
    for (const field of ["hits", "hitsTotal"]) assert.ok(description.includes(field), field);

    // Too many search words: the view says what dropped out.
    const lang = await searchIn(base, reader.id, "deploy aa bb cc dd ee ff gg hh ii jj kk ll"); // 13 words
    assert.equal(lang.searchWordsIgnored, 1);
    assert.match(lang.searchHint, /12/);
  });
});

test("(S2) a database with an outdated trigger wording is recreated on start, the backlog brought along under the NEW rule", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Rule", wsPath);
    const reader = await makeChat(base, ws.id);
    const c = await makeChat(base, ws.id);
    store.addMessage(c.id, "assistant", "Old magicword in a reply");
    // The state of an earlier rule: an insert trigger that takes in everything (and - if there is one - another version).
    const db = dbModule.db;
    db.exec("DROP TRIGGER messages_fts_ai");
    db.exec("CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text); END;");
    try { db.exec("UPDATE messages_fts_state SET rule = 'previous'"); } catch { /* state without version */ }
    store.addMessage(c.id, "user", `${FINISHED_MARKER}\n<summary>Magicword from a subagent</summary>`);
    assert.equal(store.chatSearchHits("magicword", [c.id]).filter((t) => t.role === "user").length, 1, "the old rule took in the completion notice");

    store.initChatSearchSchema();
    assert.equal(store.chatSearchComplete(), false, "recreated => the backlog is brought along");
    assert.match(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_fts_ai'").get()?.sql), /task-notification/);
    await bringAlongChatSearch();
    assert.equal(store.chatSearchComplete(), true);
    const r = await searchIn(base, reader.id, "magicword");
    assert.deepEqual(r.chats.map((x) => x.id), [c.id]);
    assert.deepEqual(r.chats[0].hits.map((t) => t.role), ["assistant"], JSON.stringify(r.chats[0].hits));
    // A second start with the same rule recreates nothing.
    store.initChatSearchSchema();
    assert.equal(store.chatSearchComplete(), true);
  });
});

test("(S3) the user row of a turn with cause event or channel is not in the index, the human's is; causes bound", async () => {
  assert.ok(store.CHAT_SEARCH_CAUSES.every((a) => CAUSES.has(a)), JSON.stringify(store.CHAT_SEARCH_CAUSES));
  await withServer(async ({ base, wsPath, waitForQuiet }) => {
    const ws = await makeWorkspace(base, "Kind", wsPath);
    const reader = await makeChat(base, ws.id);
    const c = await makeChat(base, ws.id);
    deliverUserPrompt(store.getChat(c.id), { prompt: "Wake-up call", display: "Copy magicchest is ready.", cause: "event" });
    await waitForQuiet();
    deliverUserPrompt(store.getChat(c.id), { prompt: "Job", display: "Please check the magicchest" });
    await waitForQuiet();
    store.addMessage(c.id, "user", "Magicchest from a channel", Date.now(), null, "channel");
    const r = await searchIn(base, reader.id, "magicchest");
    const entry = r.chats.find((x) => x.id === c.id);
    assert.ok(entry, JSON.stringify(r.chats));
    const user = (entry.hits || []).filter((t) => t.role === "user");
    assert.deepEqual(user.map((t) => t.excerpt), ["Please check the magicchest"], JSON.stringify(entry.hits));
    // The exemption goes with the chat.
    const ids = dbModule.db.prepare("SELECT id FROM messages WHERE chat_id = ?").all(c.id).map((z) => z.id);
    assert.ok(dbModule.db.prepare("SELECT COUNT(*) AS n FROM messages_fts_exempt").get().n >= 2);
    await ok(`${base}/api/chats/${c.id}`, { method: "DELETE" });
    const rest = dbModule.db.prepare("SELECT id FROM messages_fts_exempt").all().map((z) => z.id).filter((id) => ids.includes(id));
    assert.deepEqual(rest, []);
    await waitForQuiet();
  });
});

test("(S4) the excerpt finds a word that matches only through diacritics", async () => {
  const text = `${"Vorrede ohne Belang. ".repeat(20)}Das Zauberwort gilt für alle Fälle. ${"Nachrede ohne Belang. ".repeat(10)}`;
  const a = search.excerpt(text, ["fur"]);
  assert.ok(a.includes("für"), a);
  assert.ok(search.excerpt(text, ["falle"]).includes("Fälle"));
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Umlaut", wsPath);
    const reader = await makeChat(base, ws.id);
    const c = await makeChat(base, ws.id);
    store.addMessage(c.id, "assistant", text);
    const r = await searchIn(base, reader.id, "fur");
    assert.ok(r.chats.find((x) => x.id === c.id)?.hits?.[0]?.excerpt.includes("für"), JSON.stringify(r.chats));
  });
});

test("(S5) the times of the hits are in wall time like the others", () => {
  const ms = Date.UTC(2026, 9, 4, 10, 30);
  const c = agentsTools.chatTimes({ id: "x", lastActivity: ms, hits: [{ role: "user", at: ms, excerpt: "a" }] });
  assert.match(String(c.lastActivity), /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.equal(c.hits[0].at, c.lastActivity);
  assert.equal(c.hits[0].excerpt, "a");
});

test("(S6) a search on an incomplete index starts the backfill; throttled after a failure", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Backfill", wsPath);
    const reader = await makeChat(base, ws.id);
    const c = await makeChat(base, ws.id);
    store.addMessage(c.id, "assistant", "A magicword");
    store.chatSearchResetForTest();
    assert.equal(search.chatSearchBackfillRunning(), false);
    assert.equal((await searchIn(base, reader.id, "magicword")).indexIncomplete, true);
    assert.equal(search.chatSearchBackfillRunning(), true, "the search started the backfill");
    await bringAlongChatSearch();
    assert.deepEqual((await searchIn(base, reader.id, "magicword")).chats.map((x) => x.id), [c.id]);

    // A batch throws (the state is locked) => the next search does not start again at once.
    store.chatSearchResetForTest();
    dbModule.db.exec("CREATE TRIGGER q3_lock BEFORE UPDATE ON messages_fts_state BEGIN SELECT RAISE(ABORT, 'locked (test)'); END");
    try {
      await bringAlongChatSearch();
      assert.equal(store.chatSearchComplete(), false);
      assert.equal((await searchIn(base, reader.id, "magicword")).indexIncomplete, true);
      assert.equal(search.chatSearchBackfillRunning(), false, "throttled");
    } finally {
      dbModule.db.exec("DROP TRIGGER IF EXISTS q3_lock");
    }
    await bringAlongChatSearch();
    assert.equal(store.chatSearchComplete(), true);
  });
});

test("(S7) tool and tool primer describe the search as it runs", () => {
  // The search is described entirely at the field `search`; the description points there and must not carry the old reading.
  const d = list.description(MAIN);
  assert.doesNotMatch(d, /search \(title and first user message\)/);
  assert.match(d, /at `view` and at the fields/);
  const field = list.inputSchema(MAIN).properties.search.description;
  for (const m of [/full text/, /hits/, /indexIncomplete/, /SAME message/, /word start/]) assert.match(field, m);
  // The tool primer of the read level and the one with the write tool - both carry the same read part.
  for (const choice of [["cbase_agents_list"], ["cbase_agents_list", "cbase_agent_send"]]) {
    const k = toolPrimer(choice);
    assert.match(k, /full text/, choice.join());
    assert.match(k, /indexIncomplete/, choice.join());
    assert.doesNotMatch(k, /search by title and first message,/, choice.join());
  }
});
