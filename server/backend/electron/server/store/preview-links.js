// The preview links for project containers. Written and read by preview/links.js — nobody else.
//
// `ngrok_access`: exactly ONE row (`id = 1`) with the authtoken and the API key of the user (BYO). The values never
// leave the server (pattern `gitlab_accounts` in store/workflows.js): `ngrokAccessRaw` is only for preview/links.js;
// everything that goes to a route, to SSE or into the log is computed from it by links.js as booleans. No row means
// "nothing stored".
//
// `preview_links`: one row per created link. "Active" means `ended_at IS NULL` (states start · online · error); an
// ended row stays as history (reason revoke · expired · error). `port` is fixed at creation — a later renumbering
// of the service does not silently redirect the link. `ngrok_domain_id` carries the reservation (mode `names`),
// `approved_at` the successful release; if it stays empty, the expiry tick catches up on it.
// Registration "preview-links" at the end of store.js.
//
// THE VALUE SETS of the CHECK clauses (mode, state, reason) and the length of the history belong to the contract of
// the seam (preview/contract.js MODES without "off", STATES, ENDED_REASONS, HISTORY). store/ is domain-free and does
// not import it — server/backend/test/preview-links.test.js holds the CHECK clauses of this table against the lists
// of the contract, and links.js passes the history length in as a number (no default here that could silently
// differ).
// The delete paths of project, instance and service do not know this table: they report via
// store.setTargetRemovedObserver (store/project-instances.js), preview/links.js ends the links at once; the rows
// stay as history.
import { db } from "./db.js";

function initPreviewLinksSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ngrok_access (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      authtoken TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      checked_at INTEGER,
      error TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS preview_links (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      instance TEXT,
      service_id INTEGER NOT NULL,
      port INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'dev' CHECK (mode IN ('dev', 'names')),
      url TEXT NOT NULL DEFAULT '',
      ngrok_domain_id TEXT,
      created_at INTEGER NOT NULL,
      running_since_at INTEGER,
      ended_at INTEGER,
      ended_reason TEXT CHECK (ended_reason IS NULL OR ended_reason IN ('revoke', 'expired', 'error')),
      approved_at INTEGER,
      state TEXT NOT NULL DEFAULT 'start' CHECK (state IN ('start', 'online', 'error', 'ended')),
      error TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS preview_links_ended ON preview_links (ended_at, created_at);
  `);
}

// ── Access ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** ONLY for preview/links.js: the access WITH values — `{ authtoken, apiKey, checkedAt, error }`, empty without a row. */
function ngrokAccessRaw() {
  const r = db.prepare("SELECT * FROM ngrok_access WHERE id = 1").get();
  return { authtoken: r?.authtoken || "", apiKey: r?.api_key || "", checkedAt: r?.checked_at ?? null, error: r?.error || "" };
}

/** Writes the row completely (links.js computes the values). */
function writeNgrokAccess({ authtoken, apiKey, checkedAt = null, error = "" }, now = Date.now()) {
  db.prepare(`INSERT INTO ngrok_access (id, authtoken, api_key, checked_at, error, updated_at) VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET authtoken = excluded.authtoken, api_key = excluded.api_key, checked_at = excluded.checked_at,
      error = excluded.error, updated_at = excluded.updated_at`)
    .run(String(authtoken || ""), String(apiKey || ""), checkedAt, String(error || ""), now);
}

/** The last error when opening a link (shown in the settings) — only if an access exists; "" clears it. */
function setNgrokAccessError(text) {
  db.prepare("UPDATE ngrok_access SET error = ? WHERE id = 1").run(String(text || "").slice(0, 500));
}

function removeNgrokAccess() {
  db.prepare("DELETE FROM ngrok_access WHERE id = 1").run();
}

// ── Links ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

function mapPreviewLink(r) {
  if (!r) return null;
  return {
    id: r.id, projectId: r.project_id, instance: r.instance ?? null, serviceId: r.service_id, port: r.port, mode: r.mode,
    url: r.url || "", ngrokDomainId: r.ngrok_domain_id ?? null, createdAt: r.created_at, runningSinceAt: r.running_since_at ?? null,
    endedAt: r.ended_at ?? null, endedReason: r.ended_reason ?? null, approvedAt: r.approved_at ?? null,
    state: r.state, error: r.error || "",
  };
}

function createPreviewLink({ id, projectId, instance, serviceId, port, mode, createdAt, runningSinceAt: runningFromAt }) {
  db.prepare(`INSERT INTO preview_links (id, project_id, instance, service_id, port, mode, created_at, running_since_at, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'start')`)
    .run(String(id), String(projectId), instance == null ? null : String(instance), serviceId, port, mode, createdAt, runningFromAt ?? null);
  return previewLink(id);
}

const previewLink = (id) => mapPreviewLink(db.prepare("SELECT * FROM preview_links WHERE id = ?").get(String(id)));

/** The active links (not ended), oldest first. */
const previewLinksActive = () =>
  db.prepare("SELECT * FROM preview_links WHERE ended_at IS NULL ORDER BY created_at, rowid").all().map(mapPreviewLink);

/** The last `n` ended links, newest first — `n` is mandatory (contract.js HISTORY, via links.js). */
const previewLinksHistory = (n) =>
  db.prepare("SELECT * FROM preview_links WHERE ended_at IS NOT NULL ORDER BY ended_at DESC, rowid DESC LIMIT ?").all(n).map(mapPreviewLink);

/** Ended links with a reservation whose release is still outstanding (the expiry tick catches up on it). */
const previewLinksWithoutApproval = () =>
  db.prepare("SELECT * FROM preview_links WHERE ended_at IS NOT NULL AND ngrok_domain_id IS NOT NULL AND approved_at IS NULL ORDER BY ended_at, rowid")
    .all().map(mapPreviewLink);

const COLUMNS = { url: "url", ngrokDomainId: "ngrok_domain_id", state: "state", error: "error", approvedAt: "approved_at" };

/**
 * Change fields of a link. With `onlyActive: true` only while it has not ended — returns whether a row was changed
 * (a revocation that came in between wins).
 */
function changePreviewLink(id, fields, { onlyActive = false } = {}) {
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    const column = COLUMNS[k];
    if (!column) throw new Error(`changePreviewLink: unknown field "${k}"`);
    sets.push(`${column} = ?`); vals.push(v);
  }
  if (!sets.length) return false;
  const condition = onlyActive ? " AND ended_at IS NULL" : "";
  return db.prepare(`UPDATE preview_links SET ${sets.join(", ")} WHERE id = ?${condition}`).run(...vals, String(id)).changes > 0;
}

/** End an active link — exactly once (condition in the UPDATE). Returns whether THIS call ended it. */
function endPreviewLink(id, { reason, error = null, now = Date.now() }) {
  const r = error == null
    ? db.prepare("UPDATE preview_links SET ended_at = ?, ended_reason = ?, state = 'ended' WHERE id = ? AND ended_at IS NULL").run(now, reason, String(id))
    : db.prepare("UPDATE preview_links SET ended_at = ?, ended_reason = ?, state = 'ended', error = ? WHERE id = ? AND ended_at IS NULL").run(now, reason, String(error), String(id));
  return r.changes > 0;
}

export {
  initPreviewLinksSchema, ngrokAccessRaw, writeNgrokAccess, setNgrokAccessError, removeNgrokAccess, createPreviewLink, previewLink, previewLinksActive,
  previewLinksHistory, previewLinksWithoutApproval, changePreviewLink, endPreviewLink,
};
