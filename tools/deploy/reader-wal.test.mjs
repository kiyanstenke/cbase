// The deploy's database readers (tools/deploy/lib/capabilities.mjs, the `*_SCRIPT` programs run in a throwaway container with the
// home volume mounted READ-ONLY) against a real WAL database — B keeps automater.db in WAL mode (store/db.js initStore).
//   (1) B is running: rows committed only into `-wal` are counted (the plain read-only open reads the WAL)
//   (2) B closed the database cleanly (no `-wal` left) in a read-only folder: still a count (the immutable fallback), not an error
//   (3) the fallback refuses a file that changes while it reads: an error instead of a count from a torn file
//   (4) every reader program carries the same opener
// The read-only mount is played by a folder without write permission (chmod 555) — as root that is no barrier, so (2) and (3)
// check that the folder really refuses a write first.
// Counter-test: the old programs (plain `readOnly` open only) answer (2) with "COPIES=error attempt to write a readonly database";
// without the stamp comparison (3) prints a count.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { BRIDGE_SCRIPT, COPIES_DB_VAR, COPIES_SCRIPT, EPISODES_SCRIPT, INSTANCE_STOPPED_SCRIPT, LAYOUT_SCRIPT } from "./lib/capabilities.mjs";

const run = (script, db, extraEnv = {}) => execFileSync(process.execPath, ["-e", script],
  { env: { ...process.env, [COPIES_DB_VAR]: db, ...extraEnv }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function walDatabase(dir, rows) {
  const file = path.join(dir, "automater.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA wal_autocheckpoint = 0"); // keep the rows in -wal: the reader must find them THERE
  db.exec("CREATE TABLE stack_copies (id TEXT PRIMARY KEY, state TEXT)");
  const ins = db.prepare("INSERT INTO stack_copies (id, state) VALUES (?, ?)");
  rows.forEach(([id, state]) => ins.run(id, state));
  return { file, db };
}

function readOnlyFolder(dir) {
  fs.chmodSync(dir, 0o555);
  try { fs.writeFileSync(path.join(dir, "probe"), "x"); fs.rmSync(path.join(dir, "probe")); return false; } catch { return true; }
}

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reader-wal-"));
  try { return fn(dir); } finally { fs.chmodSync(dir, 0o755); fs.rmSync(dir, { recursive: true, force: true }); }
}

test("(1) a running B: rows only in -wal are counted", () => withDir((dir) => {
  const { file, db } = walDatabase(dir, [["a", "ready"], ["b", "removed"], ["c", "frozen"]]);
  try {
    assert.ok(fs.statSync(`${file}-wal`).size > 0, "the rows sit in -wal");
    readOnlyFolder(dir);
    assert.equal(run(COPIES_SCRIPT, file), "COPIES=2");
  } finally { db.close(); }
}));

test("(2) a cleanly closed WAL database in a read-only folder is still counted", (t) => withDir((dir) => {
  const { file, db } = walDatabase(dir, [["a", "ready"], ["b", "ready"], ["c", "removed"]]);
  db.close();
  assert.equal(fs.existsSync(`${file}-wal`), false, "the clean close removed -wal");
  const header = fs.readFileSync(file).subarray(18, 20); // file format versions: 2/2 = WAL (reading the header opens no connection)
  assert.deepEqual([...header], [2, 2], "the file stays in WAL mode");
  if (!readOnlyFolder(dir)) { t.diagnostic("the folder accepts writes (root?) — the read-only branch is not walked here"); }
  assert.equal(run(COPIES_SCRIPT, file), "COPIES=2");
  assert.equal(fs.readdirSync(dir).join(","), "automater.db", "the reader wrote nothing next to the database");
}));

test("(3) the immutable fallback refuses a file that changes while it reads", () => withDir((dir) => {
  const { file, db } = walDatabase(dir, [["a", "ready"]]);
  db.close();
  const preload = path.join(os.tmpdir(), `reader-wal-preload-${process.pid}.cjs`);
  // Plays a writer that touches the file between the reader's two looks: the second statSync of the database reports a newer
  // modification time. No seam in the product — the preload wraps fs.statSync.
  fs.writeFileSync(preload, `const fs = require("node:fs"); const real = fs.statSync; let n = 0;
fs.statSync = function (p, ...rest) { const s = real.call(fs, p, ...rest); if (p === process.env.${COPIES_DB_VAR} && ++n >= 2) s.mtimeMs += 1000; return s; };\n`);
  try {
    assert.ok(readOnlyFolder(dir), "this case needs a folder that refuses writes (not root)");
    assert.match(run(COPIES_SCRIPT, file, { NODE_OPTIONS: `--require ${preload}` }), /^COPIES=error the database changed while it was read without locks$/);
  } finally { fs.rmSync(preload, { force: true }); }
}));

test("(4) every reader program opens through the same WAL-safe opener", () => {
  const opener = COPIES_SCRIPT.slice(0, COPIES_SCRIPT.indexOf("const t="));
  assert.match(opener, /immutable=1/);
  for (const [name, s] of Object.entries({ EPISODES_SCRIPT, LAYOUT_SCRIPT, INSTANCE_STOPPED_SCRIPT, BRIDGE_SCRIPT })) {
    assert.ok(s.startsWith(opener), `${name} opens differently`);
    assert.equal(s.includes("'"), false, `${name}: a single quote breaks the command behind ssh`);
  }
});
