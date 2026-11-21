// The journal of automater.db (store/db.js initStore): WAL + synchronous NORMAL, busy_timeout.
//   (1) A store opened by initStore runs journal_mode WAL, synchronous NORMAL (1) and the default busy_timeout — read back from
//       the store's own connection. Without WAL every commit fsyncs the journal and the file on the main thread (the event-loop
//       blocks of 20.11.2026); without busy_timeout a foreign lock fails a write at once (db-lock.test.js walks that path)
//   (2) Copies through SQLite carry what is still in `-wal`: `VACUUM INTO` and `backup()` (how backup and migration tools copy) from a
//       read-only connection; a plain file copy of automater.db alone does NOT — the reason no path may copy the file itself
// Counter-test: without the two pragmas in initStore, (1) is red ("delete" / 2); (2)'s file-copy half then sees the row (it is
// in the file), so its assertion turns red too.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import test from "node:test";

delete process.env.CBASE_DB_BUSY_MS; // the default is the promise here

const store = await import("../electron/server/store.js");
const dbModule = await import("../electron/server/store/db.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-journal-"));
const file = path.join(dir, "automater.db");
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("(1) initStore opens the store in WAL mode with synchronous NORMAL and the default busy_timeout", (t) => {
  store.initStore(dir);
  const db = dbModule.db;
  const pragma = (name) => Object.values(db.prepare(`PRAGMA ${name}`).get())[0];
  t.diagnostic(`journal_mode=${pragma("journal_mode")} synchronous=${pragma("synchronous")} busy_timeout=${pragma("busy_timeout")} wal_autocheckpoint=${pragma("wal_autocheckpoint")}`);
  assert.equal(pragma("journal_mode"), dbModule.JOURNAL_MODE);
  assert.equal(dbModule.JOURNAL_MODE, "wal");
  assert.equal(pragma("synchronous"), dbModule.SYNCHRONOUS_NORMAL);
  assert.equal(dbModule.SYNCHRONOUS_NORMAL, 1);
  assert.equal(pragma("busy_timeout"), 5000);
});

test("(2) VACUUM INTO and backup() carry rows still in -wal; a file copy of automater.db alone does not", async () => {
  store.initStore(dir);
  dbModule.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // the schema into the file, so only the probe row is left in -wal
  store.setSetting("journal.probe", "in-wal");
  assert.ok(fs.existsSync(`${file}-wal`) && fs.statSync(`${file}-wal`).size > 0, "the commit went into -wal");
  const read = (f) => { const c = new DatabaseSync(f, { readOnly: true }); try { return c.prepare("SELECT value FROM app_settings WHERE key = ?").get("journal.probe")?.value; } finally { c.close(); } };

  const source = new DatabaseSync(file, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${path.join(dir, "vacuum.db").replace(/'/g, "''")}'`);
    await backup(source, path.join(dir, "backup.db"));
  } finally { source.close(); }
  assert.equal(read(path.join(dir, "vacuum.db")), "in-wal", "VACUUM INTO");
  assert.equal(read(path.join(dir, "backup.db")), "in-wal", "backup()");

  const copy = path.join(dir, "copy");
  fs.mkdirSync(copy);
  fs.copyFileSync(file, path.join(copy, "automater.db"));
  assert.equal(read(path.join(copy, "automater.db")), undefined, "a file copy without -wal misses the last commits");
});
