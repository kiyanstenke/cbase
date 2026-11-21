// The archive in the data layer.
//
// What is checked, WITHOUT a server: the column `archived_at` on chat and folder (on a fresh and on an old database), the
// three triggers of the folder rule (no active chat in an archived folder — the rule stands in the DATABASE, so one part checks
// through a second, raw connection), the four store functions including "only those taken along come back", the filters
// of the lists and that `updated_at` and `pinned` stay put. Routes, open work, write lock, event and MCP are the server
// part and stand in `archive.test.js` (on server-harness.mjs).
//
// A file of its OWN, like `schema-register.test.js`, `migrations.test.js`: `initStore` rebinds
// the module-wide `db`, here per test and in the old-DB test TWICE on the same store — in the middle of a file with running
// test servers that would be a bet that none is still writing.
//
// After EVERY test the invariant runs over the raw connection: active chats in archived folders = 0.
//
// Sabotages (which sabotage turns which test red):
//   ALTER for chat_folders removed                         => "schema: fresh DB" and "schema: old DB" red
//   trigger folder_archive_only_without_active removed     => "invariant: raw UPDATE …" red
//   trigger chats_active_holt_folder_new removed           => "new active chat fetches back its folder …" red
//   trigger chats_active_holt_folder removed               => "fetched-back chat …" and "moving …" red
//   "archived_at = ?" removed from fetchFolderBack         => "archiving a folder …" red (the individually archived one would come along)
//   step (4) removed from fetchFolderBack                  => "a folder whose chats all went individually …" red
//   `updated_at = ?` in archiveChat                        => "archive and restore leave …" red
//   archive filter removed from listChats                  => "filter …" red
// WITHOUT a counter-proof: the subselect version of fetchFolderBack would stay green with today's SQLite — the rule stands
// there as a comment, there is no red way against it.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import * as store from "../electron/server/store.js";
import * as dbModule from "../electron/server/store/db.js"; // the ONE transaction (inOneTransaction) and the live binding `db`

const TRIGGER = ["chats_active_holt_folder_new", "chats_active_holt_folder", "folder_archive_only_without_active"];
const T0 = 1_790_000_000_000;

function invariant(raw) {
  const n = raw.prepare(`SELECT COUNT(*) AS n FROM chats c JOIN chat_folders f ON f.id = c.folder_id
    WHERE c.archived_at IS NULL AND f.archived_at IS NOT NULL`).get().n;
  assert.equal(n, 0, `invariant broken: ${n} active chat(s) in an archived folder`);
}

function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-archive-store-"));
  let raw = null;
  try {
    store.initStore(dir);
    raw = new DatabaseSync(path.join(dir, "automater.db"));
    store.createWorkspace({ id: "ws", name: "W", path: "/tmp/cbase-archive-ws", createdAt: T0 });
    run({ dir, raw });
    invariant(raw);
  } finally {
    try { raw?.close(); } catch { /* closed is closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.warn("[test] temp directory stayed behind:", String(e?.message || e).slice(0, 120)); }
  }
}

const chat = (id, { folderId = null, kind = "normal", updatedAt = T0, scheduleId = null } = {}) =>
  store.createChat({ id, workspaceId: "ws", folderId, kind, title: id, scheduleId, createdAt: updatedAt, updatedAt });
const folder = (id, kind = "normal") =>
  store.createChatFolder({ id, workspaceId: "ws", name: id, kind, createdAt: T0, updatedAt: T0 });
const at = (id) => store.getChat(id).archivedAt;
const ids = (list) => list.map((x) => x.id);
const columns = (raw, tab) => raw.prepare("SELECT name FROM pragma_table_info(?)").all(tab).map((r) => r.name);
const trigger = (raw) => raw.prepare("SELECT name, tbl_name AS tab FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()
  .filter((t) => TRIGGER.includes(t.name)).map((t) => `${t.name}@${t.tab}`);
const EXPECTED_TRIGGER = ["chats_active_holt_folder@chats", "chats_active_holt_folder_new@chats", "folder_archive_only_without_active@chat_folders"];

test("schema: fresh DB — archived_at on both tables, the three triggers in sqlite_master, mapping null", () => {
  withStore(({ raw }) => {
    assert.ok(columns(raw, "chats").includes("archived_at"), "chats.archived_at");
    assert.ok(columns(raw, "chat_folders").includes("archived_at"), "chat_folders.archived_at");
    assert.deepEqual(trigger(raw), EXPECTED_TRIGGER);
    folder("f");
    const c = chat("c", { folderId: "f" });
    assert.equal(c.archivedAt, null, "a new chat is active (null, not undefined)");
    assert.equal(store.getChatFolder("f").archivedAt, null, "a new folder is active");
  });
});

test("schema: old DB (without column, without triggers) — a second initStore retrofits, existing data stays active", () => {
  withStore(({ dir, raw }) => {
    folder("f");
    chat("old", { folderId: "f" });
    // This is how a store lay on disk before the archive.
    raw.exec(`${TRIGGER.map((t) => `DROP TRIGGER ${t};`).join("\n")}
      ALTER TABLE chats DROP COLUMN archived_at;
      ALTER TABLE chat_folders DROP COLUMN archived_at;`);
    assert.ok(!columns(raw, "chats").includes("archived_at") && !columns(raw, "chat_folders").includes("archived_at"), "old state produced");
    assert.deepEqual(trigger(raw), [], "old state without triggers");

    store.initStore(dir);
    assert.ok(columns(raw, "chats").includes("archived_at"), "chats.archived_at retrofitted");
    assert.ok(columns(raw, "chat_folders").includes("archived_at"), "chat_folders.archived_at retrofitted");
    assert.deepEqual(trigger(raw), EXPECTED_TRIGGER, "triggers retrofitted");
    assert.equal(at("old"), null, "the existing data is active");
    assert.deepEqual(ids(store.listChats("ws")), ["old"], "and stands in the list");
    // The retrofitted rule also applies to existing data.
    assert.deepEqual(store.archiveFolder("f", T0 + 5), ["old"]);
    assert.deepEqual(store.fetchFolderBack("f"), ["old"]);
    // A third initStore is a no-op (column there, triggers IF NOT EXISTS).
    store.initStore(dir);
    assert.deepEqual(trigger(raw), EXPECTED_TRIGGER);
  });
});

test("invariant: raw UPDATE on a folder with an active chat throws folder-has-active-chats — the rule stands in the DB", () => {
  withStore(({ raw }) => {
    folder("f");
    chat("a", { folderId: "f" });
    assert.throws(() => raw.prepare("UPDATE chat_folders SET archived_at = ? WHERE id = ?").run(T0, "f"), /folder-has-active-chats/);
    assert.equal(store.getChatFolder("f").archivedAt, null, "the folder stayed active");
    // Without an active chat it works — also raw.
    store.archiveChat("a", T0 + 1);
    raw.prepare("UPDATE chat_folders SET archived_at = ? WHERE id = ?").run(T0 + 2, "f");
    assert.equal(store.getChatFolder("f").archivedAt, T0 + 2);
  });
});

test("new active chat fetches back its archived folder (schedule run, channel, fork), the old ones stay archived", () => {
  withStore(() => {
    folder("schedule", "manager");
    chat("run1", { folderId: "schedule", kind: "manager", scheduleId: "s" });
    chat("run2", { folderId: "schedule", kind: "manager", scheduleId: "s" });
    assert.deepEqual(store.archiveFolder("schedule", T0 + 10), ["run1", "run2"]);
    assert.equal(store.getChatFolder("schedule").archivedAt, T0 + 10);

    chat("run3", { folderId: "schedule", kind: "manager", scheduleId: "s", updatedAt: T0 + 20 });
    assert.equal(store.getChatFolder("schedule").archivedAt, null, "the folder is back");
    assert.equal(at("run1"), T0 + 10, "the old run chat stays archived");
    assert.equal(at("run2"), T0 + 10);
    assert.equal(at("run3"), null, "the new run chat is active");
    assert.deepEqual(ids(store.listChatFolders("ws", "manager")), ["schedule"]);
  });
});

test("fetched-back chat takes its folder along, the other chats of the folder stay in the archive", () => {
  withStore(() => {
    folder("f");
    for (const c of ["a", "b", "c"]) chat(c, { folderId: "f" });
    assert.deepEqual(store.archiveFolder("f", T0 + 100), ["a", "b", "c"]);
    assert.deepEqual(store.fetchChatBack("b"), { changed: true, folderBack: "f" });
    assert.equal(store.getChatFolder("f").archivedAt, null, "folder active");
    assert.equal(at("b"), null);
    assert.equal(at("a"), T0 + 100, "a stays archived");
    assert.equal(at("c"), T0 + 100, "c stays archived");
    // A second time is a no-op, and an active chat reports nothing.
    assert.deepEqual(store.fetchChatBack("b"), { changed: false, folderBack: null });
    // A chat archived individually in an ACTIVE folder comes back without reporting a folder.
    assert.equal(store.archiveChat("b", T0 + 200), true);
    assert.deepEqual(store.fetchChatBack("b"), { changed: true, folderBack: null });
    assert.deepEqual(store.fetchChatBack("exists-not"), { changed: false, folderBack: null });
  });
});

test("moving: an active chat that moves into an archived folder fetches it back — an archived one does not", () => {
  withStore(() => {
    folder("f");
    chat("inside", { folderId: "f" });
    store.archiveFolder("f", T0 + 1);
    chat("archived-lose");
    store.archiveChat("archived-lose", T0 + 2);
    store.updateChat("archived-lose", { folderId: "f" });
    assert.equal(store.getChatFolder("f").archivedAt, T0 + 1, "an archived chat fetches nothing back");

    chat("active-lose");
    store.updateChat("active-lose", { folderId: "f" });
    assert.equal(store.getChatFolder("f").archivedAt, null, "the active one fetches the folder back");
    assert.equal(at("inside"), T0 + 1, "the one taken along stays in the archive");
  });
});

test("archiving a folder takes the active chats along; ONLY those taken along come back, the individually archived one stays", () => {
  withStore(() => {
    folder("f");
    for (const c of ["a", "b", "c", "individual"]) chat(c, { folderId: "f" });
    assert.equal(store.archiveChat("individual", T0 + 50), true);
    assert.deepEqual(store.archiveFolder("f", T0 + 100), ["a", "b", "c"], "the return value names those taken along");
    for (const c of ["a", "b", "c"]) assert.equal(at(c), T0 + 100);
    assert.equal(at("individual"), T0 + 50, "the individually archived one keeps its timestamp");
    assert.deepEqual(ids(store.listChats("ws")), [], "nothing active any more");
    assert.deepEqual(ids(store.listChatFolders("ws")), [], "the folder is gone from the list");

    // Already archived => nothing changed, the old timestamp stays.
    assert.deepEqual(store.archiveFolder("f", T0 + 999), []);
    assert.equal(store.getChatFolder("f").archivedAt, T0 + 100);

    assert.deepEqual(store.fetchFolderBack("f"), ["a", "b", "c"]);
    assert.equal(store.getChatFolder("f").archivedAt, null);
    for (const c of ["a", "b", "c"]) assert.equal(at(c), null);
    assert.equal(at("individual"), T0 + 50, "the one archived individually before stays in the archive");
    // Active => nothing to fetch; unknown => nothing.
    assert.deepEqual(store.fetchFolderBack("f"), []);
    assert.deepEqual(store.fetchFolderBack("exists-not"), []);
    assert.deepEqual(store.archiveFolder("exists-not", T0), []);
  });
});

test("a folder whose chats all went individually before comes back empty — the chats stay in the archive", () => {
  withStore(() => {
    folder("f");
    chat("x", { folderId: "f" });
    chat("y", { folderId: "f" });
    store.archiveChat("x", T0 + 1);
    store.archiveChat("y", T0 + 2);
    assert.equal(store.getChatFolder("f").archivedAt, null, "archiving individually leaves the folder standing");
    assert.deepEqual(store.archiveFolder("f", T0 + 3), []);
    assert.equal(store.getChatFolder("f").archivedAt, T0 + 3);
    assert.deepEqual(store.fetchFolderBack("f"), []);
    assert.equal(store.getChatFolder("f").archivedAt, null, "step (4): the folder comes back even without those taken along");
    assert.equal(at("x"), T0 + 1);
    assert.equal(at("y"), T0 + 2);
  });
});

test("archive and restore leave updated_at and pinned alone — the list position stays", () => {
  withStore(() => {
    folder("f");
    chat("old", { updatedAt: T0 + 1 });
    chat("middle", { updatedAt: T0 + 2, folderId: "f" });
    chat("fresh", { updatedAt: T0 + 3 });
    store.updateChat("old", { pinned: 1 });
    const prior = store.listChats("ws").map((c) => [c.id, c.updatedAt, c.pinned]);
    assert.deepEqual(prior.map(([id]) => id), ["old", "fresh", "middle"]);

    assert.equal(store.archiveChat("old", T0 + 500), true);
    assert.equal(store.getChat("old").pinned, true, "pinning stays stored in the archive");
    assert.equal(store.archiveChat("old", T0 + 600), false, "already archived => false");
    assert.equal(at("old"), T0 + 500, "and the old timestamp stays");
    store.fetchChatBack("old");
    store.archiveFolder("f", T0 + 700);
    store.fetchFolderBack("f");
    assert.deepEqual(store.listChats("ws").map((c) => [c.id, c.updatedAt, c.pinned]), prior);
    assert.equal(store.getChatFolder("f").updatedAt, T0, "the folder keeps updated_at too");
  });
});

test("filter: default without archive, archive=only (most recently archived first), archive=including, unknown throws — chats, manager chats, folders, counters, agent chats", () => {
  withStore(() => {
    folder("f");
    folder("g");
    folder("mf", "manager");
    chat("c1", { updatedAt: T0 + 1, folderId: "f" });
    chat("c2", { updatedAt: T0 + 2, folderId: "f" });
    chat("c3", { updatedAt: T0 + 3 });
    chat("c4", { updatedAt: T0 + 4, folderId: "g" });
    chat("m1", { kind: "manager", updatedAt: T0 + 1 });
    chat("m2", { kind: "manager", updatedAt: T0 + 2, scheduleId: "s" });
    chat("m3", { kind: "manager", updatedAt: T0 + 3, folderId: "mf" });
    chat("a1", { kind: "context", updatedAt: T0 + 5 });
    store.archiveChat("c1", T0 + 30);
    store.archiveChat("c3", T0 + 10);
    store.archiveFolder("g", T0 + 20);
    store.archiveChat("m1", T0 + 40);
    store.archiveFolder("mf", T0 + 50);

    // Coding chats
    assert.deepEqual(ids(store.listChats("ws")), ["c2"]);
    assert.deepEqual(ids(store.listChats(undefined)), ["c2"], "also without a workspace only active ones");
    assert.deepEqual(ids(store.listChats("ws", { archive: "only" })), ["c1", "c4", "c3"], "archived_at DESC");
    assert.deepEqual(ids(store.listChats("ws", { archive: "including" })), ["c4", "c3", "c2", "c1"], "including: the normal order");
    // Folders and their counters (per side)
    assert.deepEqual(ids(store.listChatFolders("ws")), ["f"]);
    assert.deepEqual(ids(store.listChatFolders("ws", "normal", { archive: "only" })), ["g"]);
    assert.deepEqual(ids(store.listChatFolders("ws", "normal", { archive: "including" })), ["f", "g"]);
    assert.deepEqual(ids(store.listChatFolders("ws", "manager", { archive: "only" })), ["mf"]);
    assert.deepEqual(store.chatFolderCounts("ws"), { f: 1 }, "without: only active chats count");
    assert.deepEqual(store.chatFolderCounts("ws", "normal", { archive: "only" }), { f: 1, g: 1 });
    assert.deepEqual(store.chatFolderCounts("ws", "normal", { archive: "including" }), { f: 2, g: 1 });
    // (listAgentChats — the dock of the app agents — is gone; an old app-agent chat stands in no list.)
    assert.equal(store.listAgentChats, undefined, "listAgentChats is gone");
    assert.ok(!ids(store.listChats("ws", { archive: "including" })).includes("a1"), "an old app-agent chat is not in the coding list");
    // Folder content: deliberately unfiltered (artifact siblings, folder context)
    assert.deepEqual(ids(store.listChatsInFolder("f")).sort(), ["c1", "c2"]);
    assert.deepEqual(ids(store.listChatsInFolder("g")), ["c4"]);
    // The mapping carries the timestamp
    assert.equal(store.getChat("c1").archivedAt, T0 + 30);
    assert.equal(store.getChatFolder("g").archivedAt, T0 + 20);

    for (const wrong of ["x", "", null, "ONLY"]) {
      assert.throws(() => store.listChats("ws", { archive: wrong }), /unknown value/, `listChats ${JSON.stringify(wrong)}`);
      assert.throws(() => store.listChatFolders("ws", "normal", { archive: wrong }), /unknown value/);
      assert.throws(() => store.chatFolderCounts("ws", "normal", { archive: wrong }), /unknown value/);
    }
  });
});

test("archiving only through the archive functions: updateChat ignores archivedAt, a timestamp is required", () => {
  withStore(() => {
    chat("c");
    store.updateChat("c", { archivedAt: T0 + 1, title: "fresh" });
    assert.equal(store.getChat("c").title, "fresh");
    assert.equal(at("c"), null, "a PATCH cannot archive");
    for (const wrong of [null, "123", 0, -5, 1.5, Number.NaN]) {
      assert.throws(() => store.archiveChat("c", wrong), /timestamp/, `archiveChat ${String(wrong)}`);
      assert.throws(() => store.archiveFolder("f", wrong), /timestamp/, `archiveFolder ${String(wrong)}`);
    }
    assert.equal(at("c"), null, "nothing changed");
    assert.equal(store.archiveChat("exists-not", T0), false);
  });
});

// ── The ONE transaction (store/db.js inOneTransaction) ────────────────────────────────────────────────────────────────
// The transaction is the ONE version for all topic files and a SAVEPOINT (a transaction inside a transaction is allowed).
// What it must not lose: if COMMITTING itself fails (here a deferred foreign-key check that bites only at COMMIT — standing in
// for BUSY at COMMIT), the error must fly AND the transaction must be closed. If it stayed open, every following statement of
// the connection would silently run in it and never be committed. Measured over the SECOND, raw connection: it sees only
// what is committed.
// COUNTER-PROOF: RELEASE moved behind the protected part (the first draft) => red ("afterwards" is missing in the raw
// connection).
test("transaction: if committing fails, the error flies, nothing is written and no transaction stays open", () => {
  withStore(({ raw }) => {
    const db = dbModule.db;
    db.exec("PRAGMA foreign_keys = ON");
    try {
      db.exec("CREATE TEMP TABLE transaction_parent (id TEXT PRIMARY KEY)");
      db.exec("CREATE TEMP TABLE transaction_kind (id TEXT PRIMARY KEY, parent TEXT REFERENCES transaction_parent(id) DEFERRABLE INITIALLY DEFERRED)");
      assert.throws(() => dbModule.inOneTransaction(() => {
        chat("in-transaction");
        db.prepare("INSERT INTO transaction_kind (id, parent) VALUES ('k', 'exists-not')").run();
      }), /FOREIGN KEY/);
      assert.ok(!store.getChat("in-transaction"), "the transaction wrote despite the error at committing");
      // A transaction in a transaction: the inner error rolls back only the inner one, the outer commits.
      dbModule.inOneTransaction(() => {
        chat("outside");
        assert.throws(() => dbModule.inOneTransaction(() => { chat("inside"); throw new Error("INSIDE"); }), /INSIDE/);
      });
      chat("afterwards");
      const visible = raw.prepare("SELECT id FROM chats WHERE id IN ('in-transaction', 'outside', 'inside', 'afterwards') ORDER BY id").all().map((r) => r.id);
      assert.deepEqual(visible, ["afterwards", "outside"], "after the failed commit the transaction stayed open — what came after is not committed");
    } finally {
      try { db.exec("DROP TABLE IF EXISTS temp.transaction_kind"); db.exec("DROP TABLE IF EXISTS temp.transaction_parent"); } catch { /* connection broken: the test is red anyway */ }
      try { db.exec("PRAGMA foreign_keys = OFF"); } catch { /* likewise */ }
    }
  });
});
