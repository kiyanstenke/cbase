// Archive chats automatically.
//
// On the real server (server-harness.mjs): the route `GET|PUT /api/chat-auto-archive` (default without an entry, required fields,
// types and limits, nothing stored on 400), the cycle (`chats/auto-archive.js autoArchiveCycle`, mostly called directly — the
// tick in server.js is only its trigger; "tick …" sets it to 20 ms and waits for the event), the immediate cycle after a PUT that
// switches on or changes the days, the columns `archive_reason`/`restored_at` on all archive and restore paths with
// `archiveReason` in the output, and the event `chat_archive` with `reason: "auto"`.
// A candidate is: a Coding or manager chat without a special role, not a child chat of a graph workflow, active, not pinned,
// with at least one message, and max(last message of ANY role, creation, restore) is `days` days back. Open work holds it back
// — an open question stays open afterwards (never dismissed), and on the automatic path so does an open terminal of the chat bar:
// the tick ends no shell, by hand it works as before.
// The cycle is asynchronous: it begins AFTER the PUT's answer, works in chunks, runs only ONCE at a time (a trigger during a
// running one runs once afterwards; a setting changed between two chunks aborts the running one), and a throwing candidate does
// not stop the others. It waits for its promise or the event — never for a duration.
//
// Counter-tests (each shown red once and taken back):
//   `COALESCE(c.restored_at, 0)` removed in store/chats.js autoArchiveCandidates ⇒ "cycle …" red (the just-restored chat goes at once)
//   `c.created_at` removed there                                                  ⇒ "cycle …" red (the fork goes along)
//   `AND c.pinned = 0` removed there                                              ⇒ "cycle …" red (pinned goes)
//   `dismissQuestion === true &&` removed in chats/archive.js (the question as the
//   only reason is always dismissed)                                              ⇒ "cycle …" red (question closed)
//   the immediate cycle in chats/auto-archive.js setAutoArchive removed           ⇒ "PUT …" red
//   `archive_reason = NULL` removed in store/chats.js fetchChatBack               ⇒ "reason …" red
//   the call `autoArchiveCycle()` in the tick in server.js removed                ⇒ "tick …" hangs (waiting line every 30 s on
//                                                                                    stderr; the emergency brake is the suite deadline)
//   the terminal branch (`reason === "auto"`) in chats/archive.js removed         ⇒ "terminal …" red (archived, shell dead)
//   the cycle in setAutoArchive synchronous again                                 ⇒ "PUT …" red (archived before setAutoArchive returns)
//   the chunk pause in oneCycle removed                                           ⇒ "chunks …" red (no intermediate state)
//   the settings check between two chunks removed                                 ⇒ "chunks …" red (all archived)
//   `if (chain) { afterRun = opts; return chain; }` removed (two chains)          ⇒ "chunks …" red (own promise)
//   `store.autoArchiveCandidate(id, limit)` replaced by the list entry            ⇒ "fresh …" red (pinned goes along)
//   try/catch per candidate removed                                               ⇒ "throwing …" red (the cycle drops, C stays active)
//
// Run alone: CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/chat-auto-archive.test.js

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { MODEL, json, makeChat, makeWorkspace, ok, openStream, withServer } from "./server-harness.mjs";
import { GLOBAL } from "./quiet.mjs";
import * as store from "../electron/server/store.js";
import { db as rawDb } from "../electron/server/store/db.js";
import { openAskOf } from "../electron/server/runs/ask.js";
import { fetchBack, setCopyWork } from "../electron/server/runs/archive.js";
import { copyWorkOf } from "../electron/server/stacks/remove.js";
import { AUTO_ARCHIVE_SETTING, autoArchiveCycle, setAutoArchive } from "../electron/server/chats/auto-archive.js";

const DAY = 86_400_000;
const route = (base) => `${base}/api/chat-auto-archive`;
const put = (base, body) => json(route(base), { method: "PUT", body: JSON.stringify(body) });
const archive = (base, id, archived = true) => json(`${base}/api/chats/${id}/archive`, { method: "PUT", body: JSON.stringify({ archived }) });
const columns = (id) => rawDb.prepare("SELECT archived_at, archive_reason, restored_at FROM chats WHERE id = ?").get(id);
const question = () => ({ requestId: crypto.randomUUID(), questions: [{ header: "Choice", question: "Which option?", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }] });
// A chat with creation time `at` (directly in the store — the route stamps "now").
const agedChat = (wsId, at, fields = {}) => store.createChat({ id: crypto.randomUUID(), workspaceId: wsId, title: fields.title || "Old", provider: "claude", model: MODEL, createdAt: at, updatedAt: at, ...fields });
// Open the global stream and wait for `init` (otherwise the stream barrier would come to nothing, quiet.mjs).
async function globalStreamFor(base) {
  const s = await openStream(`${base}/api/events`);
  await s.waitFor((e) => e.type === "init", "init of the global stream");
  return s;
}
const autoEvents = (s) => s.events.filter((e) => e.type === "chat_archive" && e.reason === "auto");

test("route: without an entry {enabled:false, days:30}; PUT requires both fields, `enabled` boolean, `days` whole number 1–365 — otherwise 400 with wording and nothing stored; the answer is {enabled, days} as stored", async () => {
  await withServer(async ({ base }) => {
    assert.deepEqual(await ok(route(base)), { enabled: false, days: 30 }, "nothing stored ⇒ off, 30 days");
    assert.equal(store.getSetting(AUTO_ARCHIVE_SETTING, ""), "", "GET writes nothing");

    const wrong = [
      [{}, /„enabled“ (fehlt|is missing)/],
      [{ days: 30 }, /„enabled“ (fehlt|is missing)/],
      [{ enabled: null, days: 30 }, /„enabled“ (fehlt|is missing)/],
      [{ enabled: true }, /„days“ (fehlt|is missing)/],
      [{ enabled: false, days: null }, /„days“ (fehlt|is missing)/],
      [{ enabled: "true", days: 30 }, /„enabled“ (muss|must)/],
      [{ enabled: 1, days: 30 }, /„enabled“ (muss|must)/],
      [{ enabled: true, days: "30" }, /„days“ (muss|must)/],
      [{ enabled: true, days: 0 }, /„days“ (muss|must)/],
      [{ enabled: true, days: 366 }, /„days“ (muss|must)/],
      [{ enabled: true, days: 1.5 }, /„days“ (muss|must)/],
      [{ enabled: true, days: -1 }, /„days“ (muss|must)/],
    ];
    for (const [body, wording] of wrong) {
      const r = await put(base, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} ⇒ 400: ${JSON.stringify(r.body)}`);
      assert.match(String(r.body?.error), wording, `${JSON.stringify(body)}: wording`);
    }
    for (const raw of ["[true, 30]", "null", "30"]) {
      const r = await json(route(base), { method: "PUT", body: raw });
      assert.equal(r.status, 400, `body ${raw} ⇒ 400`);
    }
    assert.equal(store.getSetting(AUTO_ARCHIVE_SETTING, ""), "", "no rejected body stored anything");
    assert.deepEqual(await ok(route(base)), { enabled: false, days: 30 });

    // The limits themselves pass; the answer is exactly what was stored.
    assert.deepEqual(await ok(route(base), { method: "PUT", body: JSON.stringify({ enabled: false, days: 1 }) }), { enabled: false, days: 1 });
    assert.deepEqual(await ok(route(base), { method: "PUT", body: JSON.stringify({ enabled: false, days: 365, extra: "x" }) }), { enabled: false, days: 365 });
    assert.deepEqual(await ok(route(base)), { enabled: false, days: 365 });
    assert.deepEqual(JSON.parse(store.getSetting(AUTO_ARCHIVE_SETTING)), { enabled: false, days: 365 }, "JSON {enabled, days}, without foreign fields");

    // An unreadable stored value (by hand in the DB) counts as the default — off is the safe direction.
    store.setSetting(AUTO_ARCHIVE_SETTING, "{broken");
    assert.deepEqual(await ok(route(base)), { enabled: false, days: 30 });
  });
});

test("cycle: archives exactly the old Coding chats with reason \"auto\" (event, archiveReason); pinned, open question, empty, fresh, manager chat, special chat, graph child, fork and just-restored stay; switched off it does nothing", async () => {
  await withServer(async ({ base, wsPath, barrier }) => {
    const ws = await makeWorkspace(base, "Archive tick", wsPath);
    const now = Date.now();
    const OLD = now - 40 * DAY;
    const withRow = (c, at = OLD, role = "user") => { store.addMessage(c.id, role, `Row ${role}`, at); return c; };

    // Must go:
    const old = withRow(agedChat(ws.id, OLD, { title: "Old" }));
    store.addMessage(old.id, "assistant", "Response", OLD + 5);
    const renamed = withRow(agedChat(ws.id, OLD, { title: "Renamed" }));
    await ok(`${base}/api/chats/${renamed.id}`, { method: "PATCH", body: JSON.stringify({ title: "New name" }) }); // updated_at = now — does not count (only messages)
    const forkSource = withRow(agedChat(ws.id, OLD, { title: "Fork source" }));
    const inFolder = withRow(agedChat(ws.id, OLD, { title: "In folder" })); // folders are no exception
    const f = await ok(`${base}/api/chat-folders`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, name: "Folder" }) });
    await ok(`${base}/api/chats/${inFolder.id}`, { method: "PATCH", body: JSON.stringify({ folderId: f.id }) });

    // Must stay:
    const fresh = withRow(agedChat(ws.id, OLD, { title: "Fresh" }), now - DAY);
    const agentRow = withRow(withRow(agedChat(ws.id, OLD, { title: "Agent wrote" })), now - DAY, "assistant"); // any role counts
    const pinned = withRow(agedChat(ws.id, OLD, { title: "Pinned" }));
    store.updateChat(pinned.id, { pinned: 1 });
    const question2 = withRow(agedChat(ws.id, OLD, { title: "Question" }));
    store.addMessage(question2.id, "ask", JSON.stringify(question()), OLD + 1);
    const empty = agedChat(ws.id, OLD, { title: "Empty" });
    // A manager chat is read-only: the auto archive takes only `kind = 'normal'` (store/chats.js).
    const manager = withRow(agedChat(ws.id, OLD, { title: "Manager", kind: "manager" }));
    const administrator = withRow(agedChat(ws.id, OLD, { title: "Administrator", kind: "manager" }));
    store.updateChat(administrator.id, { specialRole: "administrator" });
    const appChat = withRow(agedChat(ws.id, OLD, { title: "Service", kind: "service" }));
    const orchestrator = withRow(await makeChat(base, ws.id), now);
    const childChat = withRow(agedChat(ws.id, OLD, { title: "Child" }));
    store.createGraphStart({ id: `gs-${crypto.randomUUID()}`, chatId: orchestrator.id, childChatId: childChat.id, workflowId: "wf-old",
      workflowName: "Old", shortName: "old", background: true, status: "stopped" });
    const fork = await ok(`${base}/api/chats/${forkSource.id}/fork`, { method: "POST", body: "{}" });
    assert.ok(store.listMessages(fork.id).length >= 1, "the fork carries the old history (timestamps from back then)");
    // Restored: archived by hand and back again — the clock starts anew.
    const back = withRow(agedChat(ws.id, OLD, { title: "Restored" }));
    assert.equal((await archive(base, back.id)).status, 200);
    assert.equal((await archive(base, back.id, false)).status, 200);
    assert.equal(store.getChat(back.id).archivedAt, null);

    const stream = await globalStreamFor(base);
    try {
      // Switched off (default): nothing.
      const out = await autoArchiveCycle();
      assert.deepEqual(out, { enabled: false, days: 30, archived: [], skipped: [], error: [], aborted: null });
      assert.equal(store.getChat(old.id).archivedAt, null, "switched off, everything stays active");

      store.setSetting(AUTO_ARCHIVE_SETTING, JSON.stringify({ enabled: true, days: 30 }));
      const r = await autoArchiveCycle();
      assert.deepEqual([r.error, r.aborted], [[], null]);
      await barrier(stream, GLOBAL);

      const expected = [old, renamed, forkSource, inFolder].map((c) => c.id).sort();
      assert.deepEqual([...r.archived].sort(), expected, "exactly the old candidates");
      assert.deepEqual(r.skipped, [{ chatId: question2.id, open: ["question"] }], "open work holds it back");
      for (const id of expected) {
        const c = await ok(`${base}/api/chats/${id}`);
        assert.equal(typeof c.archivedAt, "number", `${c.title}: archived`);
        assert.equal(c.archiveReason, "auto", `${c.title}: archiveReason auto`);
        assert.equal(columns(id).archive_reason, "auto");
      }
      for (const c of [fresh, agentRow, pinned, question2, empty, manager, administrator, appChat, orchestrator, childChat, fork, back]) {
        assert.equal(store.getChat(c.id).archivedAt, null, `${store.getChat(c.id).title}: stays active`);
      }
      // The question is still open afterwards — nothing dismissed, no answer written.
      assert.ok(openAskOf(question2.id), "the question card is still open");
      assert.equal(store.listMessages(question2.id).at(-1).role, "ask");
      // The folder stays active, only the chat went.
      assert.equal(store.getChatFolder(f.id).archivedAt, null, "folders are never archived automatically");

      // One `chat_archive` per archived chat with reason "auto", kind and workspace.
      const ev = autoEvents(stream);
      assert.deepEqual(ev.flatMap((e) => e.chatIds).sort(), expected, "one event per chat");
      for (const e of ev) {
        assert.equal(e.archived, true);
        assert.equal(e.workspaceId, ws.id);
        assert.deepEqual(e.folderIds, []);
        assert.equal(e.kind, "normal");
      }

      // In the output of the archive list.
      const coding = await ok(`${base}/api/chats?workspaceId=${ws.id}&archive=only`);
      assert.deepEqual(coding.filter((c) => c.archiveReason === "auto").map((c) => c.id).sort(), [old, renamed, forkSource, inFolder].map((c) => c.id).sort());
      // No manager chat went into the archive.
      assert.equal(store.getChat(manager.id).archiveReason ?? null, null, "no manager chat in the archive");

      // A second cycle changes nothing (the question chat is asked again and stays).
      const two = await autoArchiveCycle();
      assert.deepEqual(two.archived, []);
      assert.deepEqual(two.skipped.map((u) => u.chatId), [question2.id]);
    } finally { await stream.close(); }
  });
});

test("PUT: switching on and changing the days trigger a cycle that begins only AFTER the answer; the same value again and switching off trigger nothing", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Immediate", wsPath);
    const now = Date.now();
    const before = (days, title) => { const c = agedChat(ws.id, now - days * DAY, { title }); store.addMessage(c.id, "user", "x", now - days * DAY); return c; };

    // Over the route: switching on ⇒ 200 with what was stored, archiving happens afterwards — waiting for the event.
    const a = before(40, "A");
    const stream = await globalStreamFor(base);
    try {
      assert.deepEqual(await ok(route(base), { method: "PUT", body: JSON.stringify({ enabled: false, days: 30 }) }), { enabled: false, days: 30 });
      assert.deepEqual(await ok(route(base), { method: "PUT", body: JSON.stringify({ enabled: true, days: 30 }) }), { enabled: true, days: 30 });
      const e = await stream.waitFor((x) => x.type === "chat_archive" && x.reason === "auto" && x.chatIds?.includes(a.id), "chat_archive (auto) after the PUT");
      assert.equal(e.archived, true);
      assert.equal(store.getChat(a.id).archiveReason, "auto");
    } finally { await stream.close(); }

    // The decision is made by setAutoArchive (the route only passes through) — directly here, because a cycle that was NOT
    // triggered cannot be shown at the route without a duration. `cycle` is its promise or null.
    const b = before(40, "B");
    let r = setAutoArchive({ enabled: true, days: 30 });
    assert.equal(r.ok, true);
    assert.equal(r.cycle, null, "the same value again ⇒ no trigger (the tick picks it up)");

    const c = before(20, "C");
    r = setAutoArchive({ enabled: true, days: 10 });
    assert.ok(r.cycle instanceof Promise, "days changed ⇒ trigger");
    // Nothing happens in the handler — when setAutoArchive returns (and the route answers), nothing is archived yet; the cycle
    // begins in the next turn of the event loop.
    assert.equal(store.getChat(b.id).archivedAt, null, "not archived yet when setAutoArchive returns");
    const result = await r.cycle;
    assert.deepEqual(result.archived, [b.id, c.id], "… afterwards with the new limit, oldest first");
    assert.equal(store.getChat(c.id).archiveReason, "auto");

    const d = before(40, "D");
    r = setAutoArchive({ enabled: false, days: 5 });
    assert.equal(r.cycle, null, "switching off ⇒ no trigger");
    assert.deepEqual((await autoArchiveCycle()).archived, [], "and the tick does nothing when switched off");
    assert.equal(store.getChat(d.id).archivedAt, null);
  });
});

// An open terminal of the chat bar is open work on the AUTOMATIC path — otherwise the tick would silently end a shell (service,
// build, logs). By hand it stays as it was: the route archives and ends the shell.
test("terminal: an open terminal of the chat bar holds the cycle back (reason \"terminal\", the shell lives); after closing, the chat goes; by hand the route still archives and ends the shell", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Shells", wsPath);
    const OLD = Date.now() - 40 * DAY;
    const x = agedChat(ws.id, OLD, { title: "With shell" });
    const y = agedChat(ws.id, OLD + 1, { title: "By hand" });
    for (const c of [x, y]) store.addMessage(c.id, "user", "x", OLD + 2);
    const all = [];
    const shell = async (chatId) => {
      const r = await json(`${base}/api/workspaces/${ws.id}/terminal`, { method: "POST", body: JSON.stringify({ cols: 80, rows: 24, tag: `chat:${chatId}` }) });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.available, true, `node-pty missing: ${JSON.stringify(r.body)}`);
      all.push(r.body.id);
      return r.body.id;
    };
    const alive = async (id) => (await json(`${base}/api/terminal/${id}/exists`)).body.exists;
    try {
      const tx = await shell(x.id);
      const ty = await shell(y.id);
      store.setSetting(AUTO_ARCHIVE_SETTING, JSON.stringify({ enabled: true, days: 30 }));

      const r1 = await autoArchiveCycle();
      assert.deepEqual(r1.archived, [], "no chat with an open shell goes automatically");
      assert.deepEqual(r1.skipped, [{ chatId: x.id, open: ["terminal"] }, { chatId: y.id, open: ["terminal"] }]);
      assert.equal(await alive(tx), true, "the shell of x lives");
      assert.equal(await alive(ty), true, "the shell of y lives");
      for (const c of [x, y]) assert.equal(store.getChat(c.id).archivedAt, null);

      // By hand (the route, unchanged): archives and ends the shell — the pre-check had counted it.
      assert.equal((await ok(`${base}/api/chats/${y.id}/archive`)).terminals, 1);
      const hand = await archive(base, y.id);
      assert.equal(hand.status, 200, JSON.stringify(hand.body));
      assert.equal(hand.body.terminalsEnded, 1);
      assert.equal(await alive(ty), false, "by hand: the shell is ended");
      assert.equal(store.getChat(y.id).archiveReason, "user");

      // The shell of x closed ⇒ the next cycle takes it.
      assert.equal((await fetch(`${base}/api/terminal/${tx}`, { method: "DELETE" })).ok, true);
      const r2 = await autoArchiveCycle();
      assert.deepEqual([r2.archived, r2.skipped], [[x.id], []]);
      assert.equal(store.getChat(x.id).archiveReason, "auto");
    } finally {
      for (const id of all) await fetch(`${base}/api/terminal/${id}`, { method: "DELETE" }).catch(() => {});
    }
  });
});

// The cycle frees the event loop between chunks, runs only ONCE at a time (a trigger meanwhile comes as a follow-up, no second
// one alongside) and aborts when the setting changes between two chunks — it would otherwise go on archiving with a limit nobody
// wants any more. It is observed per turn of the event loop (setImmediate, no duration): the test runs BETWEEN the chunks.
test("chunks: other code runs between two chunks; a trigger meanwhile gets the same promise (follow-up, no second cycle); a changed setting aborts, the follow-up applies the new one", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Chunks", wsPath);
    const now = Date.now();
    const candidates = [];
    for (let i = 0; i < 7; i++) {
      const at = now - (50 - i) * DAY; // 50 … 44 days old, oldest first
      const c = agedChat(ws.id, at, { title: `H${i}` });
      store.addMessage(c.id, "user", "x", at);
      candidates.push(c.id);
    }
    const archived = () => candidates.filter((id) => store.getChat(id).archivedAt != null);
    const turn = () => new Promise((r) => setImmediate(r));
    store.setSetting(AUTO_ARCHIVE_SETTING, JSON.stringify({ enabled: true, days: 30 }));

    const p = autoArchiveCycle({ chunk: 2 });
    let finished = false;
    p.then(() => { finished = true; }, () => { finished = true; });
    assert.equal(autoArchiveCycle({ chunk: 2 }), p, "a second trigger gets the promise of the running chain");
    // Until the first chunk is through — the test then runs between two chunks.
    while (!finished && archived().length === 0) await turn();
    const between = archived();
    assert.equal(finished, false, "the cycle is not finished after the first chunk");
    assert.ok(between.length > 0 && between.length < candidates.length, `an intermediate state: ${between.length} of ${candidates.length}`);
    assert.deepEqual(between, candidates.slice(0, between.length), "oldest first");

    // Now — between two chunks — a PUT changes the days to 60 (none of the chats is that old).
    const r = setAutoArchive({ enabled: true, days: 60 });
    assert.equal(r.cycle, p, "the PUT's trigger runs as a follow-up of the same chain, not alongside");
    const result = await p;
    assert.deepEqual([result.days, result.archived, result.aborted], [60, [], null], "the promise carries the result of the follow-up");
    assert.deepEqual(archived(), between, "the old cycle aborted at the next chunk — nothing more with 30 days");
  });
});

// Consequence of the chunks: between the candidate list and archiving a later candidate lies a turn of the event loop. Whoever
// was pinned in that gap or got a message is no longer a candidate — the cycle asks each one afresh (store.autoArchiveCandidate,
// the same SQL as the list), immediately before archiving.
test("fresh per candidate: whoever is pinned between two chunks or gets a message stays active", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Fresh", wsPath);
    const now = Date.now();
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const at = now - (50 - i) * DAY;
      const c = agedChat(ws.id, at, { title: `F${i}` });
      store.addMessage(c.id, "user", "x", at);
      ids.push(c.id);
    }
    const turn = () => new Promise((r) => setImmediate(r));
    store.setSetting(AUTO_ARCHIVE_SETTING, JSON.stringify({ enabled: true, days: 30 }));
    const p = autoArchiveCycle({ chunk: 2 });
    let finished = false;
    p.then(() => { finished = true; }, () => { finished = true; });
    while (!finished && ids.every((id) => store.getChat(id).archivedAt == null)) await turn();
    assert.equal(finished, false, "between two chunks");
    assert.deepEqual(ids.map((id) => store.getChat(id).archivedAt != null), [true, true, false, false], "the first chunk is through");
    // In the gap: F2 is pinned, F3 gets a message.
    store.updateChat(ids[2], { pinned: 1 });
    store.addMessage(ids[3], "assistant", "Still here.");
    const result = await p;
    assert.deepEqual(result.archived, [ids[0], ids[1]], "only the first chunk");
    assert.equal(store.getChat(ids[2]).archivedAt, null, "pinned ⇒ stays");
    assert.equal(store.getChat(ids[3]).archivedAt, null, "new message ⇒ stays");
  });
});

// A candidate whose check throws costs only itself. The throw comes from a real source of the check — the hook for the reason
// "copy" (runs/archive.js setCopyWork, which project-lock.test.js also uses).
test("throwing candidate: if the check throws for ONE chat, the cycle goes on archiving the others, names it in `error` and in the log (with chat id)", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Throw", wsPath);
    const now = Date.now();
    const before = (days, title) => { const c = agedChat(ws.id, now - days * DAY, { title }); store.addMessage(c.id, "user", "x", now - days * DAY); return c; };
    const a = before(50, "A");
    const b = before(45, "B — throws");
    const c = before(40, "C");
    store.setSetting(AUTO_ARCHIVE_SETTING, JSON.stringify({ enabled: true, days: 30 }));
    const rows = [];
    const errorPrior = console.error;
    setCopyWork((chatId) => { if (chatId === b.id) throw new Error("copy row unreadable"); return null; });
    console.error = (...args) => { rows.push(args.map(String).join(" ")); errorPrior(...args); };
    let result;
    try {
      result = await autoArchiveCycle();
    } finally {
      console.error = errorPrior;
      setCopyWork(copyWorkOf);
    }
    assert.deepEqual(result.archived, [a.id, c.id], "A before and C after go");
    assert.equal(result.error.length, 1);
    assert.equal(result.error[0].chatId, b.id);
    assert.match(result.error[0].error, /copy row unreadable/);
    assert.equal(store.getChat(b.id).archivedAt, null, "B stays active — the next tick asks again");
    assert.ok(rows.some((z) => z.includes(b.id) && z.includes("copy row unreadable")), `log with chat id: ${JSON.stringify(rows)}`);
  });
});

// The tick in server.js calls the cycle itself. The other tests call it directly — without this test the trigger would have no
// path (a deleted setInterval would be green). No waiting for a duration: the tick runs every 20 ms here, the setting goes
// straight into the store (a PUT would archive by itself), and the test waits for the event.
test("tick: the server calls the cycle itself at the interval of CBASE_AUTO_ARCHIVE_MS — without a PUT, without a direct call", async () => {
  const prior = process.env.CBASE_AUTO_ARCHIVE_MS;
  process.env.CBASE_AUTO_ARCHIVE_MS = "20"; // read at server start
  try {
    await withServer(async ({ base, wsPath }) => {
      const ws = await makeWorkspace(base, "Tick", wsPath);
      const OLD = Date.now() - 40 * DAY;
      const old = agedChat(ws.id, OLD, { title: "Old" });
      store.addMessage(old.id, "user", "x", OLD);
      const stream = await globalStreamFor(base);
      try {
        assert.equal(store.getChat(old.id).archivedAt, null, "switched off: the tick runs but archives nothing");
        store.setSetting(AUTO_ARCHIVE_SETTING, JSON.stringify({ enabled: true, days: 30 }));
        const e = await stream.waitFor((x) => x.type === "chat_archive" && x.reason === "auto" && x.chatIds?.includes(old.id), "chat_archive (auto) from the tick");
        assert.equal(e.archived, true);
        assert.equal(store.getChat(old.id).archiveReason, "auto");
      } finally { await stream.close(); }
    });
  } finally {
    if (prior === undefined) delete process.env.CBASE_AUTO_ARCHIVE_MS; else process.env.CBASE_AUTO_ARCHIVE_MS = prior;
  }
});

test("reason and clock: archive_reason \"user\" (chat and folder) or \"auto\", on restoring by every path NULL with restored_at (route, fetchBack from doRun, folder)", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Reason", wsPath);
    const x = await makeChat(base, ws.id);
    store.addMessage(x.id, "user", "Hello");

    // By hand: "user".
    assert.equal((await archive(base, x.id)).status, 200);
    assert.equal((await ok(`${base}/api/chats/${x.id}`)).archiveReason, "user");
    assert.equal(columns(x.id).archive_reason, "user");
    assert.equal(columns(x.id).restored_at, null, "never restored");
    // Back over the route: reason gone, clock set.
    const prior = Date.now();
    assert.equal((await archive(base, x.id, false)).status, 200);
    let s = columns(x.id);
    assert.equal(s.archived_at, null);
    assert.equal(s.archive_reason, null, "emptied on restoring");
    assert.ok(s.restored_at >= prior, "restored_at set (route)");
    assert.equal((await ok(`${base}/api/chats/${x.id}`)).archiveReason, null);

    // Automatic: "auto"; back over the path from doRun (fetchBack).
    store.archiveChat(x.id, Date.now(), "auto");
    assert.equal(store.getChat(x.id).archiveReason, "auto");
    rawDb.prepare("UPDATE chats SET restored_at = 1 WHERE id = ?").run(x.id);
    assert.equal(fetchBack(x.id, { cause: "user" }), true);
    s = columns(x.id);
    assert.equal(s.archive_reason, null);
    assert.ok(s.restored_at > 1, "restored_at set anew (fetchBack, the path from doRun)");

    // An unknown reason throws — no silent fallback to "user".
    assert.throws(() => store.archiveChat(x.id, Date.now(), "tick"), /reason must be/);
    assert.equal(store.getChat(x.id).archivedAt, null);

    // Folder: the chats taken along carry "user", back ⇒ NULL with the clock.
    const f = await ok(`${base}/api/chat-folders`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, name: "Folder" }) });
    await ok(`${base}/api/chats/${x.id}`, { method: "PATCH", body: JSON.stringify({ folderId: f.id }) });
    const folder = (archived) => json(`${base}/api/chat-folders/${f.id}/archive`, { method: "PUT", body: JSON.stringify({ archived }) });
    assert.equal((await folder(true)).status, 200);
    assert.equal(columns(x.id).archive_reason, "user", "folder archive: user");
    rawDb.prepare("UPDATE chats SET restored_at = NULL WHERE id = ?").run(x.id);
    assert.equal((await folder(false)).status, 200);
    s = columns(x.id);
    assert.equal(s.archived_at, null);
    assert.equal(s.archive_reason, null);
    assert.ok(s.restored_at > 0, "restored_at set (folder)");
  });
});
