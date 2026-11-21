// Locks on automater.db under WAL (store/db.js initStore: journal_mode WAL, synchronous NORMAL).
//
// The server owns ONE connection, so a lock always comes from outside: a test reading the database of a server CHILD process
// over a second connection, a human with `sqlite3`, the deploy's reader. Two promises, both against a FOREIGN connection:
//   (1) One writer at a time is still true under WAL. While a foreign connection holds the write lock (BEGIN IMMEDIATE), the
//       store's write WAITS in the busy handler (busy_timeout) and writes through after the release — it does not give up with
//       "database is locked" at once.
//   (2) Readers no longer block the writer (the reason for WAL). A foreign READ transaction stays open, and the store writes at
//       once — even with busy_timeout 0, so no waiting can hide a block; the reader keeps its snapshot until it ends.
//
// WHY a child process: `node:sqlite` is synchronous. If the test held the lock in its own thread it would stall while the writer
// waits and could never release it.
//
// HOW (1) proves the writer met the lock, without a clock: the child itself first checks with a probe connection without
// busy_timeout that `BEGIN IMMEDIATE` is refused (the foreign write lock is there), reports that, and calls the store write in
// the SAME synchronous stretch. The test releases only after that report. Under rollback journal this test used to prove the
// wait from outside (the waiting writer held RESERVED); under WAL a waiting writer holds nothing a probe could see, hence the
// look from inside. Without busy_timeout the store write runs while the lock is still held and fails — the test names it. The
// deterministic half (the pragma itself) is server/backend/test/store-journal.test.js.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const STORE_URL = new URL("../electron/server/store.js", import.meta.url).href;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// The writer: opens the store like the server (initStore twice, like the many callers of the facade), reports "ready" and
// writes one setting per stdin line. With `probeFirst` it first checks that a foreign writer holds the file (see header).
// An error is an ANSWER, not a crash: the test should see the wording.
const WRITER = `
import readline from "node:readline";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as store from ${JSON.stringify(STORE_URL)};
const dir = process.argv[2];
store.initStore(dir);
store.initStore(dir);
console.log(JSON.stringify({ ready: true }));
readline.createInterface({ input: process.stdin }).on("line", (row) => {
  const { key, value, probeFirst } = JSON.parse(row);
  if (probeFirst) {
    const probe = new DatabaseSync(path.join(dir, "automater.db"));
    probe.exec("PRAGMA busy_timeout = 0");
    let locked = false;
    try { probe.exec("BEGIN IMMEDIATE"); probe.exec("ROLLBACK"); } catch (e) { locked = /locked|busy/i.test(String(e?.message)); }
    probe.close();
    if (!locked) { console.log(JSON.stringify({ notLocked: true })); return; }
    console.log(JSON.stringify({ lockSeen: true }));
  }
  try { store.setSetting(key, value); console.log(JSON.stringify({ ok: true })); }
  catch (e) { console.log(JSON.stringify({ error: String(e?.message || e) })); }
});
process.stdin.on("end", () => process.exit(0));
`;

async function withWriter(busyMs, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-db-lock-"));
  const script = path.join(dir, "writer.mjs");
  fs.writeFileSync(script, WRITER);
  const env = { ...process.env, CBASE_DB_BUSY_MS: String(busyMs) };
  delete env.NODE_TEST_CONTEXT;
  const subprocess = spawn(process.execPath, [script, dir], { env, stdio: ["pipe", "pipe", "inherit"] });
  const ended = new Promise((r) => subprocess.once("exit", r));
  const responses = [];
  readline.createInterface({ input: subprocess.stdout }).on("line", (l) => { try { responses.push(JSON.parse(l)); } catch { /* foreign line */ } });
  // Waits for the n-th answer (an event), polling the list; a dead writer ends the wait.
  const response = async (n) => {
    while (responses.length < n) {
      if (subprocess.exitCode !== null) throw new Error(`the writer has exited (exit ${subprocess.exitCode}), answers: ${JSON.stringify(responses)}`);
      await pause(5);
    }
    return responses[n - 1];
  };
  const opened = [];
  const open = () => { const c = new DatabaseSync(path.join(dir, "automater.db")); opened.push(c); return c; };
  try {
    assert.deepEqual(await response(1), { ready: true });
    await fn({ send: (o) => subprocess.stdin.write(`${JSON.stringify(o)}\n`), response, open });
  } finally {
    // Release every foreign lock first: a writer that still waits would otherwise end only after its hour.
    for (const c of opened) { try { c.close(); } catch { /* already closed */ } }
    subprocess.stdin.end();
    if (subprocess.exitCode === null) subprocess.kill("SIGKILL");
    await ended;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a temp leftover says nothing about the product */ }
  }
}

test("(1) one writer at a time: while a foreign connection holds the write lock the store waits and writes through after the release", async () => {
  // An hour in the child (opposite direction): otherwise the test's reaction time under load would decide whether 5 s suffice.
  await withWriter(3_600_000, async ({ send, response, open }) => {
    const holder = open();
    holder.exec("BEGIN IMMEDIATE");
    holder.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run("db-lock.holder", "x");
    send({ key: "db-lock.probe", value: "through", probeFirst: true });
    const seen = await response(2);
    assert.deepEqual(seen, { lockSeen: true }, `the child must see the foreign write lock first: ${JSON.stringify(seen)}`);
    holder.exec("COMMIT");
    const a = await response(3);
    assert.deepEqual(a, { ok: true }, a?.error
      ? `the writer gave up at once instead of waiting for the foreign lock: "${a.error}" (store/db.js initStore: PRAGMA busy_timeout)`
      : `after the release the waiting writer must get through: ${JSON.stringify(a)}`);
    assert.equal(holder.prepare("SELECT value FROM app_settings WHERE key = ?").get("db-lock.probe")?.value, "through");
  });
});

test("(2) WAL: an open foreign read transaction does not block the store writer, and keeps its snapshot", async () => {
  // busy_timeout 0: the write must not need to wait at all (under rollback journal it fails at once with "database is locked").
  await withWriter(0, async ({ send, response, open }) => {
    const reader = open();
    reader.exec("BEGIN");
    assert.equal(reader.prepare("SELECT value FROM app_settings WHERE key = ?").get("db-lock.wal"), undefined);
    send({ key: "db-lock.wal", value: "written" });
    const a = await response(2);
    assert.deepEqual(a, { ok: true }, `the open reader blocked the writer: ${JSON.stringify(a)} (store/db.js initStore: journal_mode WAL)`);
    assert.equal(reader.prepare("SELECT value FROM app_settings WHERE key = ?").get("db-lock.wal"), undefined, "the reader keeps its snapshot");
    reader.exec("COMMIT");
    assert.equal(reader.prepare("SELECT value FROM app_settings WHERE key = ?").get("db-lock.wal")?.value, "written", "a new read sees the write");
  });
});
