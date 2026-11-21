// Context (knowledge): workspace context with FTS and vectors, project context helper (mapCtx), context adoption,
// context suggestions.
// Answers: how is a context entry searched, linked and adopted.

import { db, nowMs } from "./db.js";
import { jsonOr, slugifyTitle } from "./_util.js";


// ── Context (workspace, OKF light — no repo, hence no git fields) ────────────
export function insertContext(workspaceId, { category, title, summary, tags, body, source, createdAt,
  slug, status, owners, links, confidence }) {
  const now = createdAt || nowMs();
  const info = db.prepare(
    `INSERT INTO context_items (workspace_id, category, title, summary, tags, body, source, created_at,
       slug, status, owners, links, confidence, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(workspaceId, category || "Other", title || "", summary || "",
    Array.isArray(tags) ? tags.join(", ") : (tags || ""), body, source || "", now,
    uniqueSlug("context_items", "workspace_id", workspaceId, slug || title), status || "active",
    Array.isArray(owners) ? owners.join(", ") : (owners || ""),
    (() => { const l = normalizeLinks(links); return l ? JSON.stringify(l) : ""; })(),
    confidence || "", now);
  return getContextItem(workspaceId, Number(info.lastInsertRowid));
}
export const getContextItem = (workspaceId, id) =>
  db.prepare("SELECT * FROM context_items WHERE workspace_id = ? AND id = ?").get(workspaceId, id) || null;

export function updateContext(workspaceId, id, fields) {
  const sets = ["updated_at = ?"], vals = [nowMs()];
  const map = { category: "category", title: "title", body: "body", summary: "summary", status: "status", confidence: "confidence" };
  for (const [k, col] of Object.entries(map)) {
    if (fields[k] !== undefined && fields[k] !== null) { sets.push(`${col} = ?`); vals.push(fields[k]); }
  }
  for (const [k, col] of [["tags", "tags"], ["owners", "owners"]]) {
    if (fields[k] !== undefined && fields[k] !== null) {
      sets.push(`${col} = ?`); vals.push(Array.isArray(fields[k]) ? fields[k].join(", ") : fields[k]);
    }
  }
  if (fields.links !== undefined) {
    const l = normalizeLinks(fields.links);
    sets.push("links = ?"); vals.push(l ? JSON.stringify(l) : "");
  }
  vals.push(workspaceId, id);
  db.prepare(`UPDATE context_items SET ${sets.join(", ")} WHERE workspace_id = ? AND id = ?`).run(...vals);
  return getContextItem(workspaceId, id);
}

export function listContext(workspaceId, { category, q, status } = {}) {
  let sql = "SELECT * FROM context_items WHERE workspace_id = ?";
  const params = [workspaceId];
  if (category) { sql += " AND category = ?"; params.push(category); }
  if (status && status !== "all") { sql += " AND status = ?"; params.push(status); }
  if (q) { sql += " AND (title LIKE ? OR summary LIKE ? OR body LIKE ? OR tags LIKE ? OR slug LIKE ? OR owners LIKE ?)"; const l = `%${q}%`; params.push(l, l, l, l, l, l); }
  sql += " ORDER BY created_at DESC";
  return db.prepare(sql).all(...params);
}
export const categories = (workspaceId) =>
  db.prepare("SELECT category, COUNT(*) AS n FROM context_items WHERE workspace_id = ? GROUP BY category ORDER BY n DESC").all(workspaceId);
export const deleteContext = (workspaceId, id) =>
  db.prepare("DELETE FROM context_items WHERE workspace_id = ? AND id = ?").run(workspaceId, id).changes > 0;

// ── Search index of the knowledge: FTS5 hits + persistent vectors ────────────
// Both for BOTH knowledge tables via a scope name. Computing and weighting does not happen here but in
// retrieval.js — this section is pure data access.
const CTX_SCOPES = {
  project: { table: "project_context", fts: "project_context_fts", scopeCol: "project_id" },
  workspace: { table: "context_items", fts: "context_items_fts", scopeCol: "workspace_id" },
};
const ctxScopeDef = (scope) => CTX_SCOPES[scope] || CTX_SCOPES.workspace;

// BM25 hits. SQLite returns bm25() NEGATIVE (smaller = better); flipped here so that "larger = better" holds for
// the caller. A missing index or an unparsable MATCH expression yields an empty list instead of throwing — the
// search then loses the BM25 signal, not its function.
function ftsSearch(scope, scopeId, match, limit) {
  const { table, fts, scopeCol } = ctxScopeDef(scope);
  if (!match || !String(match).trim() || !scopeId) return [];
  try {
    return db.prepare(
      `SELECT f.rowid AS id, -bm25(${fts}) AS score
         FROM ${fts} f JOIN ${table} c ON c.id = f.rowid
        WHERE ${fts} MATCH ? AND c.${scopeCol} = ?
        ORDER BY score DESC LIMIT ?`,
    ).all(String(match), scopeId, Number(limit) || 200);
  } catch {
    return [];
  }
}
export const ftsSearchProjectContext = (projectId, match, limit = 200) => ftsSearch("project", projectId, match, limit);
export const ftsSearchContextItems = (workspaceId, match, limit = 200) => ftsSearch("workspace", workspaceId, match, limit);

// Stored vectors for an id list → Map id → { blob, at, model }. Whether a vector is still VALID (same model,
// at >= updated_at) is decided by the caller.
export function getContextEmbeddings(scope, ids) {
  const { table } = ctxScopeDef(scope);
  const out = new Map();
  const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
  if (!list.length) return out;
  const CHUNK = 400; // stay below the SQLite parameter limit
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const rows = db.prepare(
      `SELECT id, embedding, embedding_at AS at, embedding_model AS model
         FROM ${table} WHERE embedding IS NOT NULL AND id IN (${part.map(() => "?").join(",")})`,
    ).all(...part);
    for (const r of rows) out.set(r.id, { blob: r.embedding, at: r.at || 0, model: r.model || "" });
  }
  return out;
}

export function setContextEmbedding(scope, id, blob, model) {
  const { table } = ctxScopeDef(scope);
  db.prepare(`UPDATE ${table} SET embedding = ?, embedding_at = ?, embedding_model = ? WHERE id = ?`)
    .run(blob, nowMs(), String(model || ""), Number(id));
}

// Backlog of the backfill: entries without a valid vector, most recently maintained first.
export function contextEmbeddingBacklog(scope, model, limit = 50) {
  const { table } = ctxScopeDef(scope);
  return db.prepare(
    `SELECT id, title, summary, body FROM ${table}
      WHERE embedding IS NULL OR embedding_model != ? OR embedding_at < updated_at
      ORDER BY updated_at DESC LIMIT ?`,
  ).all(String(model || ""), Number(limit) || 50);
}

// Counters for display/diagnosis: how much of the knowledge is embedded?
export function contextEmbeddingStats(model) {
  const stats = {};
  for (const [scope, { table }] of Object.entries(CTX_SCOPES)) {
    const row = db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN embedding IS NOT NULL AND embedding_model = ? AND embedding_at >= updated_at THEN 1 ELSE 0 END) AS indexed
         FROM ${table}`,
    ).get(String(model || ""));
    stats[scope] = { total: row.total || 0, indexed: row.indexed || 0 };
  }
  return stats;
}

// Discard all vectors — forces a complete rebuild (e.g. after a model change).
export function clearContextEmbeddings() {
  let n = 0;
  for (const { table } of Object.values(CTX_SCOPES)) {
    n += db.prepare(`UPDATE ${table} SET embedding = NULL, embedding_at = 0, embedding_model = ''`).run().changes;
  }
  return n;
}

// ── Project context (categorized, OKF) ───────────────────────────────────────
// `slugifyTitle` lives in `_util.js` and is imported from there: `db.js` needs it for the backfill and would
// otherwise pull in this whole topic file. The facade `store.js` re-exports it by name from `_util.js` — a second
// `export` here would be the same declaration in two files for store-facade.test.js.
// Edge kinds of the knowledge graph — a fixed set, so that traversal and validation work.
export const LINK_KINDS = ["related", "depends_on", "supersedes", "conflicts_with"];
export const normalizeLinks = (links) => {
  if (!links || typeof links !== "object") return null;
  const out = {};
  for (const kind of LINK_KINDS) {
    const arr = links[kind];
    if (Array.isArray(arr) && arr.length) out[kind] = [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
  }
  return Object.keys(out).length ? out : null;
};
export function uniqueSlug(table, scopeCol, scopeId, wanted, excludeId = null) {
  const base = slugifyTitle(wanted) || "entry";
  const taken = new Set(
    db.prepare(`SELECT slug FROM ${table === "context_items" ? "context_items" : "project_context"} WHERE ${scopeCol === "workspace_id" ? "workspace_id" : "project_id"} = ? AND slug != '' ${excludeId != null ? "AND id != ?" : ""}`)
      .all(...(excludeId != null ? [scopeId, excludeId] : [scopeId])).map((r) => r.slug),
  );
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}
const mapCtx = (r) => r && {
  id: r.id, projectId: r.project_id, category: r.category, title: r.title,
  body: r.body, summary: r.summary, tags: r.tags, source: r.source,
  validAsOf: r.valid_as_of, pinned: Boolean(r.pinned),
  createdAt: r.created_at, updatedAt: r.updated_at,
  slug: r.slug || "", status: r.status || "active", supersededBy: r.superseded_by || "",
  owners: r.owners || "", links: jsonOr(r.links, null),
  codePaths: jsonOr(r.code_paths, []), symbols: r.symbols || "",
  lastVerified: jsonOr(r.last_verified, null), confidence: r.confidence || "",
};

// ── Workspace context adoption per project (by category; opt-in like skills/MCP/credentials) ──
export const listAdoptedContextCategories = (projectId) =>
  new Set(db.prepare("SELECT category FROM project_context_adopt WHERE project_id = ?").all(projectId).map((r) => r.category));
export function setContextCategoryAdopted(projectId, category, on) {
  const c = String(category || "").trim();
  if (!c) return;
  if (on) db.prepare("INSERT OR IGNORE INTO project_context_adopt (project_id, category) VALUES (?, ?)").run(projectId, c);
  else db.prepare("DELETE FROM project_context_adopt WHERE project_id = ? AND category = ?").run(projectId, c);
}
// Adoptable workspace categories for a project: all workspace context categories with count + status.
export function adoptableWorkspaceContextCategories(projectId, workspaceId) {
  if (!workspaceId) return [];
  const adopted = listAdoptedContextCategories(projectId);
  return categories(workspaceId).map((r) => ({ category: r.category, n: r.n, adopted: adopted.has(r.category) }));
}
// The adopted workspace context entries of a project, shaped like project_context. origin:"workspace" + NEGATIVE id
// (never collides with the positive project_context ids → project update/delete never hit them by accident; from
// the project's view they are read-only). The `q` filter applies, the project category filter does NOT (different
// taxonomy) — the route only appends them without a category filter.
export function adoptedWorkspaceContext(projectId, workspaceId, { q } = {}) {
  const adopted = listAdoptedContextCategories(projectId);
  if (!adopted.size || !workspaceId) return [];
  const out = [];
  for (const cat of adopted) {
    for (const r of listContext(workspaceId, { category: cat, q })) {
      out.push({
        id: -r.id, projectId, category: r.category, title: r.title, body: r.body, summary: r.summary,
        tags: r.tags, source: r.source, validAsOf: "", pinned: false,
        createdAt: r.created_at, updatedAt: r.updated_at || r.created_at, origin: "workspace",
        slug: r.slug || "", status: r.status || "active", supersededBy: "",
        owners: r.owners || "", links: jsonOr(r.links, null),
        codePaths: [], symbols: "", lastVerified: null, confidence: r.confidence || "",
      });
    }
  }
  return out;
}

// ── Context suggestions (post-run curator) ──────────────────────────────────
const mapSugg = (r) => r && {
  id: r.id, projectId: r.project_id, chatId: r.chat_id, op: r.op, targetId: r.target_id,
  category: r.category, title: r.title, body: r.body, summary: r.summary, tags: r.tags,
  validAsOf: r.valid_as_of, reason: r.reason, status: r.status, createdAt: r.created_at,
};

export function insertSuggestion(projectId, chatId, { op, targetId = null, category = "", title = "", body = "", summary = "", tags = "", validAsOf = "", reason = "" }) {
  const info = db.prepare(
    `INSERT INTO context_suggestions (project_id, chat_id, op, target_id, category, title, body, summary, tags, valid_as_of, reason, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(projectId, chatId, op, targetId, category, title, body, summary,
    Array.isArray(tags) ? tags.join(", ") : (tags || ""), validAsOf, reason, nowMs());
  return mapSugg(db.prepare("SELECT * FROM context_suggestions WHERE id = ?").get(Number(info.lastInsertRowid)));
}

export const listSuggestions = (projectId, status = "pending") =>
  db.prepare("SELECT * FROM context_suggestions WHERE project_id = ? AND status = ? ORDER BY created_at DESC").all(projectId, status).map(mapSugg);

export const getSuggestion = (projectId, id) =>
  mapSugg(db.prepare("SELECT * FROM context_suggestions WHERE project_id = ? AND id = ?").get(projectId, id));

export const setSuggestionStatus = (projectId, id, status) =>
  db.prepare("UPDATE context_suggestions SET status = ? WHERE project_id = ? AND id = ?").run(status, projectId, id).changes > 0;

// Pending suggestions per project — for badges in the UI.
export const pendingSuggestionCounts = () =>
  db.prepare("SELECT project_id, COUNT(*) AS n FROM context_suggestions WHERE status = 'pending' GROUP BY project_id").all()
    .map((r) => ({ projectId: r.project_id, n: r.n }));

export { mapCtx };
