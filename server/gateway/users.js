// Users & sessions of the gateway — its own small SQLite DB (node:sqlite, like the backend).
// Passwords: scrypt (salt per user); sessions: random token, only the SHA-256 hash is stored in the DB.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ROLES } from "./administration-contract.js";

let db;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days since last activity

export function initUsers(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(path.join(dataDir, "gateway.db"));
  // A second connection to the same file: without a wait at the lock SQLite answers IMMEDIATELY with SQLITE_BUSY ("database is
  // locked") as soon as the other one is writing — in rollback-journal mode a commit blocks every reader too. In operation only
  // the gateway opens the file; in the gateway tests the test process (users.js via the harness) reads and writes next to the
  // gateway child, and under load a `getUser` while waiting and a read after a request hit the child's commit. Same number as in
  // the backend (runs/episodes-count.js).
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS push_devices (
      installation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL,
      environment TEXT NOT NULL,
      locale TEXT NOT NULL DEFAULT 'en',
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (user_id, installation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_push_user ON push_devices(user_id);
    CREATE TABLE IF NOT EXISTS push_cursors (
      user_id TEXT PRIMARY KEY,
      notice_id INTEGER NOT NULL DEFAULT 0
    );
    -- ingest_tokens and tunnel_tokens belonged to features that no longer exist (machine token of the extractors for
    -- /api/ingest/*; bearer token for an SSH path): the tables are dropped so no token stays behind that no route checks.
    DROP TABLE IF EXISTS ingest_tokens;
    DROP TABLE IF EXISTS tunnel_tokens;
  `);
  // An APNs token identifies an app installation, not a cbase account. If someone logs in to another account with the same
  // iPhone, the old account must not keep the token. Clean existing data down to the last-seen owner and enforce the
  // protection at database level too (the earlier index was unique per user only).
  db.exec(`
    DELETE FROM push_devices
    WHERE rowid NOT IN (
      SELECT rowid FROM push_devices AS keep
      WHERE keep.rowid = (
        SELECT candidate.rowid FROM push_devices AS candidate
        WHERE candidate.token = keep.token AND candidate.environment = keep.environment
        ORDER BY candidate.last_seen DESC, candidate.rowid DESC LIMIT 1
      )
    );
    DROP INDEX IF EXISTS idx_push_token;
    CREATE UNIQUE INDEX idx_push_token ON push_devices(token, environment);
  `);
  // Last APNs response per device — so "nothing arrives on my device" can be answered without logging in to the gateway.
  for (const column of [
    "ALTER TABLE push_devices ADD COLUMN last_status INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE push_devices ADD COLUMN last_reason TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE push_devices ADD COLUMN last_push_at INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { db.exec(column); } catch { /* column already exists */ }
  }
  // Schedule wakeup: the earliest upcoming schedule occurrence per user as the backend last reported it (GET
  // /api/schedules/next on the container port). Persisted because the container may be ASLEEP at the occurrence — then
  // the value is the only trace from which the gateway knows it must wake it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedule_termine (
      user_id TEXT PRIMARY KEY,
      next_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
  // The lock BEFORE deleting. Deleting a user takes a while (snapshot, stop project containers, stop B, remove) — without the
  // lock their sessions would keep working in that time, and a request would create a new B via ensureBackend. Locked means: no
  // session, no login, no ensureBackend; the row stays until the container is really gone (otherwise a failed delete could not
  // be repeated).
  try { db.exec("ALTER TABLE users ADD COLUMN locked_at INTEGER NOT NULL DEFAULT 0"); } catch { /* column already exists */ }
  // A user who deleted their own account (POST /gw/account/delete): the row is marked BEFORE the teardown, which runs in the
  // background (a purge can outlast the tunnel's ~100 s). A marked row stays locked, cannot be unlocked and is erased again at every
  // gateway start and in the periodic tick until the container and both volumes are really gone.
  try { db.exec("ALTER TABLE users ADD COLUMN erase_requested_at INTEGER NOT NULL DEFAULT 0"); } catch { /* column already exists */ }
  // From which connection (outerShell.js addressKey: IPv4 address or IPv6 /64) a name last logged in successfully — the exception
  // from the login brake's name limit. Kept in the DB so it survives every gateway restart (otherwise a guesser could lock the
  // name for every address after each restart). `name` is the normalised login name (like verifyLogin); the brake sweeps rows
  // older than 30 days, at most 64 per name.
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_proven (
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (name, address)
    );
  `);
  // The resources per user container: the source of truth, not the HostConfig — the gateway creates a container anew in three
  // ways (unhealthy, broken leftover, missing), and a value set only via `docker update` would be lost silently there. Every
  // user has one row with all three values (no per-field "default" state); `cpu_max` NULL means "no hard limit". `changed_of`
  // NULL: written by the initial fill or from the template at creation, not set by an admin.
  db.exec(`
    CREATE TABLE IF NOT EXISTS container_resources (
      user_id TEXT PRIMARY KEY,
      ram_gib INTEGER NOT NULL,
      cpu_prio TEXT NOT NULL,
      cpu_max INTEGER,
      changed_at INTEGER,
      changed_of TEXT
    );
  `);
}

const PROVEN_PER_NAME = 64;
export const loginProbation = Object.freeze({
  read(name, address) {
    return Number(db.prepare("SELECT at FROM login_proven WHERE name = ? AND address = ?").get(String(name), String(address))?.at) || 0;
  },
  remember(name, address, at) {
    db.prepare(`INSERT INTO login_proven (name, address, at) VALUES (?, ?, ?)
                ON CONFLICT(name, address) DO UPDATE SET at = excluded.at`).run(String(name), String(address), Number(at) || 0);
    db.prepare(`DELETE FROM login_proven WHERE name = ? AND address NOT IN
                (SELECT address FROM login_proven WHERE name = ? ORDER BY at DESC LIMIT ${PROVEN_PER_NAME})`).run(String(name), String(name));
  },
  sweep(before) {
    db.prepare("DELETE FROM login_proven WHERE at < ?").run(Number(before) || 0);
  },
});

export function setScheduleOccurrence(userId, nextAt) {
  db.prepare(`INSERT INTO schedule_termine (user_id, next_at, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET next_at = excluded.next_at, updated_at = excluded.updated_at`)
    .run(userId, Number(nextAt) || 0, Date.now());
}
export function getScheduleOccurrence(userId) {
  return Number(db.prepare("SELECT next_at FROM schedule_termine WHERE user_id = ?").get(userId)?.next_at) || 0;
}
export function listScheduleTermine() {
  return db.prepare("SELECT user_id AS userId, next_at AS nextAt, updated_at AS updatedAt FROM schedule_termine WHERE next_at > 0").all();
}

const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString("hex");
// Asynchronous for login: scryptSync costs ≈ 22 ms and would block the gateway's event loop on EVERY attempt — also for unknown
// names (timing dummy). With changing addresses of a /64 a requester without an account could keep it saturated. Creating a user
// and setting a password (admin) stay synchronous.
const hashPwAsync = (pw, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(String(pw), salt, 64, (error, key) => (error ? reject(error) : resolve(key)));
});
const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

export function countUsers() {
  return db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
}

export function createUser({ username, password, role = "user" }) {
  const name = String(username || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,40}$/.test(name)) throw new Error("Username: 2-40 characters (a-z, 0-9, . _ -)");
  if (String(password || "").length < 8) throw new Error("Password: at least 8 characters");
  if (!ROLES.includes(role)) throw new Error(`Role must be one of ${ROLES.join(", ")}`);
  const salt = crypto.randomBytes(16).toString("hex");
  const u = { id: crypto.randomUUID(), username: name, role, createdAt: Date.now() };
  db.prepare("INSERT INTO users (id, username, pass_hash, salt, role, created_at) VALUES (?,?,?,?,?,?)")
    .run(u.id, u.username, hashPw(password, salt), salt, u.role, u.createdAt);
  return u;
}

export async function verifyLogin(username, password) {
  const name = String(username || "").trim().toLowerCase();
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(name);
  if (!row) { await hashPwAsync(password || "x", "timing-dummy"); return null; } // same cost, no user enumeration
  const got = await hashPwAsync(password, row.salt);
  const want = Buffer.from(row.pass_hash, "hex");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  // While scrypt ran, the admin may have locked or deleted the user or set the password — the state AFTER the check counts.
  const now = db.prepare("SELECT * FROM users WHERE id = ?").get(row.id);
  if (!now || now.pass_hash !== row.pass_hash) return null;
  if (now.locked_at) return null; // checked after the password — same cost as a wrong password
  return { id: now.id, username: now.username, role: now.role };
}

export function setPassword(userId, password) {
  if (String(password || "").length < 8) throw new Error("Password: at least 8 characters");
  const salt = crypto.randomBytes(16).toString("hex");
  db.prepare("UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?").run(hashPw(password, salt), salt, userId);
  // A password change invalidates the user's existing sessions.
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function listUsers() {
  return db.prepare("SELECT id, username, role, created_at AS createdAt, locked_at AS lockedAt FROM users ORDER BY created_at")
    .all().map(({ lockedAt, ...u }) => ({ ...u, locked: Number(lockedAt) > 0 }));
}

// Also a LOCKED user (for the admin: a failed delete must be repeatable). Whoever wants to know whether the user may act asks
// isActive.
export function getUser(userId) {
  const r = db.prepare("SELECT id, username, role, created_at AS createdAt, locked_at AS lockedAt FROM users WHERE id = ?").get(userId);
  if (!r) return null;
  const { lockedAt, ...u } = r;
  return { ...u, locked: Number(lockedAt) > 0 };
}

// May this user do anything (session, start container, push)? No if they do not exist or are locked.
export function isActive(userId) {
  const u = getUser(userId);
  return !!u && !u.locked;
}

// Lock BEFORE the container is torn down — the sessions drop at once (an open request that has already passed authentication is
// then stopped by ensureBackend, see index.js). Idempotent; a second call does not change the timestamp.
export function lockUser(userId) {
  db.prepare("UPDATE users SET locked_at = ? WHERE id = ? AND locked_at = 0").run(Date.now(), userId);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

// Lift the lock. Sessions do not come back — they dropped when locking; the user logs in again. After a failed delete ("delete
// incomplete") this is also the way back — but never for a row whose owner deleted their account (eraseRequested): that one only
// goes forward. true = unlocked.
export function unlockUser(userId) {
  return db.prepare("UPDATE users SET locked_at = 0 WHERE id = ? AND erase_requested_at = 0").run(userId).changes > 0;
}

// The user deleted their own account: mark the row and lock it (sessions drop at once) in one step, before anything is torn down.
export function requestErase(userId) {
  db.prepare("UPDATE users SET erase_requested_at = ? WHERE id = ? AND erase_requested_at = 0").run(Date.now(), userId);
  lockUser(userId);
}

export function eraseRequested(userId) {
  return Number(db.prepare("SELECT erase_requested_at AS at FROM users WHERE id = ?").get(userId)?.at) > 0;
}

/** The marked rows whose erasure is still outstanding (gateway start, periodic tick). */
export function listEraseRequested() {
  return db.prepare("SELECT id FROM users WHERE erase_requested_at > 0 ORDER BY erase_requested_at").all().map((r) => r.id);
}

/** How many users besides this one stay — a row already marked for erasure does not count. */
export function countRemainingOthers(userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE id <> ? AND erase_requested_at = 0").get(userId).n;
}

// Change the role. Who the last active admin is, the route decides (resources.js lastAdmin) — only the row is written here.
// The session does not carry the role: getSession reads the user fresh per request, the new role applies at once.
export function setRole(userId, role) {
  if (!ROLES.includes(role)) throw new Error(`Role must be one of ${ROLES.join(", ")}`);
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
}

// ── Resources per user container ───────────────────────────────────────────────────────────────────────────────────────────
// Validation happens BEFORE writing (resources.js checkResources); only the rows are written here.
const resourcesFrom = (r) => (r ? { ramGiB: Number(r.ram_gib), cpuPrio: r.cpu_prio, cpuMax: r.cpu_max === null ? null : Number(r.cpu_max) } : null);

export function getResources(userId) {
  return resourcesFrom(db.prepare("SELECT ram_gib, cpu_prio, cpu_max FROM container_resources WHERE user_id = ?").get(userId));
}

// Both write ONLY for a user that exists — in the same statement, not in a check before. Otherwise a PUT whose target was
// deleted during the request would create an orphaned row (the route answered 200 with `null`); deleteUser never removes it,
// and a later user with the same name gets a new id — the row would stay forever. true = written (for setResources also:
// overwritten).
export function setResources(userId, { ramGiB, cpuPrio, cpuMax }, ofUserId = null) {
  return db.prepare(`INSERT INTO container_resources (user_id, ram_gib, cpu_prio, cpu_max, changed_at, changed_of)
              SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
              ON CONFLICT(user_id) DO UPDATE SET ram_gib = excluded.ram_gib, cpu_prio = excluded.cpu_prio, cpu_max = excluded.cpu_max,
                changed_at = excluded.changed_at, changed_of = excluded.changed_of`)
    .run(userId, ramGiB, cpuPrio, cpuMax ?? null, Date.now(), ofUserId ?? null, userId).changes > 0;
}

// Only if there is no row yet (initial fill): an admin who saves between gateway start and the end of the initial fill is not
// overwritten. And only for a user that still exists (the initial fill asks docker per user — a delete in that time would
// otherwise leave an orphaned row). true = written.
export function supplementResources(userId, { ramGiB, cpuPrio, cpuMax }) {
  return db.prepare(`INSERT INTO container_resources (user_id, ram_gib, cpu_prio, cpu_max, changed_at, changed_of)
                     SELECT ?, ?, ?, ?, ?, NULL WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
                     ON CONFLICT(user_id) DO NOTHING`).run(userId, ramGiB, cpuPrio, cpuMax ?? null, Date.now(), userId).changes > 0;
}

// Only rows of existing users — an orphaned row would otherwise count in the sum of allocated limits and in resources-desired.json.
export function listResources() {
  return db.prepare(`SELECT r.user_id, r.ram_gib, r.cpu_prio, r.cpu_max FROM container_resources r JOIN users u ON u.id = r.user_id
                     ORDER BY u.created_at`).all().map((r) => ({ userId: r.user_id, ...resourcesFrom(r) }));
}

export function deleteUser(userId) {
  // The proof hangs on the name: a user later created with the same name does not inherit it.
  db.prepare("DELETE FROM login_proven WHERE name = (SELECT username FROM users WHERE id = ?)").run(userId);
  db.prepare("DELETE FROM container_resources WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM schedule_termine WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM push_cursors WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM push_devices WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
}

export function upsertPushDevice(userId, { installationId, token, environment, locale = "en" }) {
  const now = Date.now();
  // Logging in to another account transfers this app installation atomically to the new owner, so a failed logout can never
  // cause notifications of the old account.
  db.prepare("DELETE FROM push_devices WHERE token = ? AND environment = ? AND (user_id <> ? OR installation_id <> ?)")
    .run(token, environment, userId, installationId);
  db.prepare(`
    INSERT INTO push_devices (installation_id, user_id, token, environment, locale, created_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, installation_id) DO UPDATE SET
      token = excluded.token,
      environment = excluded.environment,
      locale = excluded.locale,
      last_seen = excluded.last_seen
  `).run(installationId, userId, token, environment, locale, now, now);
  return { installationId, environment };
}

export function removePushDevice(userId, installationId) {
  return db.prepare("DELETE FROM push_devices WHERE user_id = ? AND installation_id = ?")
    .run(userId, installationId).changes > 0;
}

export function removePushToken(userId, token, environment) {
  db.prepare("DELETE FROM push_devices WHERE user_id = ? AND token = ? AND environment = ?")
    .run(userId, token, environment);
}

export function listPushDevices(userId) {
  return db.prepare(`
    SELECT installation_id AS installationId, token, environment, locale, last_seen AS lastSeen,
           created_at AS createdAt, last_status AS lastStatus, last_reason AS lastReason, last_push_at AS lastPushAt
    FROM push_devices WHERE user_id = ? ORDER BY last_seen DESC
  `).all(userId);
}

// What APNs last said about this device. Without these three columns a silent push cannot be told from a switched-off one — the
// answer would only land in console.error, a place a user cannot reach.
export function notePushResult(userId, token, environment, { status = 0, reason = "" } = {}) {
  db.prepare(`UPDATE push_devices SET last_status = ?, last_reason = ?, last_push_at = ?
              WHERE user_id = ? AND token = ? AND environment = ?`)
    .run(Number(status) || 0, String(reason || "").slice(0, 200), Date.now(), userId, token, environment);
}

export function getPushCursor(userId) {
  const row = db.prepare("SELECT notice_id AS noticeId FROM push_cursors WHERE user_id = ?").get(userId);
  return row ? Number(row.noticeId) : null;
}

export function setPushCursor(userId, noticeId) {
  db.prepare(`
    INSERT INTO push_cursors (user_id, notice_id) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET notice_id = MAX(push_cursors.notice_id, excluded.notice_id)
  `).run(userId, Number(noticeId) || 0);
}

// Explicitly RESET the cursor — the only place allowed past the MAX clamp above. The clamp protects normal delivery from a
// late catch-up turning back the live stream's position; but it also makes the cursor blind to an event sequence that restarted
// in the backend (e.g. notices 1..53 against cursor 192). Without this second path the reconciliation in push.js would be a
// no-op.
export function resetPushCursor(userId, noticeId) {
  db.prepare(`
    INSERT INTO push_cursors (user_id, notice_id) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET notice_id = excluded.notice_id
  `).run(userId, Number(noticeId) || 0);
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?,?,?,?)")
    .run(hashToken(token), userId, now, now);
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hashToken(token));
  if (!row) return null;
  const now = Date.now();
  if (now - row.last_seen > SESSION_TTL_MS) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(row.token_hash);
    return null;
  }
  // Write last_seen throttled (at most once a minute) — SSE/polling must not flood the DB.
  if (now - row.last_seen > 60_000) db.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?").run(now, row.token_hash);
  const user = getUser(row.user_id);
  return user && !user.locked ? { user } : null;
}

export function deleteSession(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}
