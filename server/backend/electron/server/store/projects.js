// Projects: global list, project services, project context CRUD, ports and services.
// Answers: which services and ports belong to a project, and where is its context.

import { db, nowMs } from "./db.js";
import { mapCtx, normalizeLinks, uniqueSlug } from "./context.js";
import { reportTargetRemoved } from "./project-instances.js";


// The projects of ONE workspace, in creation order. Lives here and not in `workspaces.js`: `toolchain.js` and
// `workflows.js` need the list, and `workspaces.js` imports `removeSkillResources` from `toolchain.js` — an import
// from there would turn two edges into a cycle.
const listProjects = (wsId) =>
  db.prepare("SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at ASC").all(wsId)
    .map((p) => ({ id: p.id, name: p.name, path: p.path, createdAt: p.created_at }));

// ── Projects (global) ────────────────────────────────────────────────────────
const PROJ_SQL = `SELECT p.*, w.name AS ws_name FROM projects p LEFT JOIN workspaces w ON w.id = p.workspace_id`;
const mapProjGlobal = (r) => r && {
  id: r.id, name: r.name, path: r.path, createdAt: r.created_at,
  workspaceId: r.workspace_id, workspaceName: r.ws_name,
};
export const listAllProjects = () => db.prepare(`${PROJ_SQL} ORDER BY p.created_at ASC`).all().map(mapProjGlobal);
export const getProject = (id) => mapProjGlobal(db.prepare(`${PROJ_SQL} WHERE p.id = ?`).get(id));

// ── Project services (result of the AI service scan) ─────────────────────────
const mapProjectService = (r) => r && {
  id: r.id, projectId: r.project_id, name: r.name, kind: r.kind, port: r.port,
  container: r.container || "", tech: r.tech, dir: r.dir, startCommand: r.start_command,
  description: r.description, createdAt: r.created_at,
};

export const listProjectServices = (projectId) =>
  db.prepare(`SELECT ps.*, si.instructions AS agent_instructions
              FROM project_services ps
              LEFT JOIN service_start_instructions si
                ON si.project_id = ps.project_id AND si.service_key = lower(trim(ps.name))
              WHERE ps.project_id = ? ORDER BY ps.kind, ps.name`).all(projectId)
    .map((r) => ({ ...mapProjectService(r), agentInstructions: r.agent_instructions || "" }));

// Start instructions for the agent start (key: project + normalized service name).
const svcKey = (name) => String(name || "").trim().toLowerCase();
export const getStartInstructions = (projectId, name) =>
  db.prepare("SELECT instructions FROM service_start_instructions WHERE project_id = ? AND service_key = ?")
    .get(projectId, svcKey(name))?.instructions ?? "";
export function setStartInstructions(projectId, name, instructions) {
  const text = String(instructions || "");
  db.prepare(`INSERT INTO service_start_instructions (project_id, service_key, instructions, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(project_id, service_key) DO UPDATE SET instructions = excluded.instructions, updated_at = excluded.updated_at`)
    .run(projectId, svcKey(name), text, nowMs());
}

// The row in `service_start_commands` of a service (the start command corrected by hand) — `null` means "no row".
// Read by the relocation plan (projectbox/relocation/collect.js: port overrides are there too).
const savedStartCommand = (projectId, name) =>
  db.prepare("SELECT start_command FROM service_start_commands WHERE project_id = ? AND service_key = ?")
    .get(projectId, svcKey(name))?.start_command ?? null;

// Several statements in ONE transaction. The ROLLBACK is guarded: after an error where SQLite rolls the
// transaction back itself (SQLITE_FULL, IOERR, NOMEM) a bare `ROLLBACK` would throw "no transaction is active" —
// and that error would replace the real one (the full disk would show up nowhere).
function inTransaction(fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

// ── Reconciling a service scan ───────────────────────────────────────────────────────────────────────────────────────
// A scan must not replace the whole stock (DELETE + INSERT): every service would get a NEW id, and everything
// carrying the old one would point nowhere — the target services of an instance (restore would report "service
// unknown" and start nothing), the run key `<project>:<service>` in services.js (a running portless service would
// count as stopped and could be started a second time). And a service registered by hand or through
// cbase_service_add would be dropped entirely.
//
// So the scan reconciles: every finding looks for its service in the stock, in four passes over ALL findings, the
// strongest key first — same name (normalized like `svcKey`), then same port, same container, same start command
// in the same folder. A stock service matches at most one finding. Matched ⇒ the same row, the same id, the same
// run time; the NAME stays (start instructions, corrected start command and history hang on it), the scan supplies
// the other fields — an EMPTY field of the finding says nothing and leaves the stock (a discarded start command
// does not clear a valid one, "other" is the scanner's fallback, not a finding). A corrected start command
// (service_start_commands) wins as before. Not matched ⇒ new row, origin 'scan'.
//
// The origin (column `origin`) decides what happens to a stock service, and it is the reason the reconciliation
// does not simply keep EVERYTHING: the scanner is a model call and names the same portless service differently on
// the next run ("Web-Frontend", "Frontend", "Web") and with a slightly different command — none of the four keys
// matches, and every re-scan would put another row next to it, startable next to the running original. Hence:
//   'scan'  (created by the scan): no longer found ⇒ REMOVED — unless it runs or is in the target of an instance
//           (`keep`, computed by projects/scans.js); then it stays and is listed in `notFound`.
//   'hand'  (POST /api/project-services, cbase_service_add): always stays; when matched the scan overwrites NO
//           field that already has a value (it only fills blanks) — the promise "the service registered by hand
//           stays" holds for the content, not just the id.
//   NULL    (unknown — every row from before the column): stays and is overwritten as before.
// `keep` missing ⇒ nothing is removed: a missing verdict about "runs" does not say that nothing runs.
// `onlySupplement`: the detection after a later upload only adds — a service not named stays, whatever its origin
// and whatever `keep` says (it is then in `notFound`). Matches and new findings are reconciled as in every
// detection.
// What stays without being found is in `notFound`, what fell in `removed` — scans.js reports both by notification.
const scanKey = [
  (s) => svcKey(s.name) || null,
  (s) => (s.port ?? null) === null ? null : `port:${Number(s.port)}`,
  (s) => String(s.container || "").trim() ? `container:${String(s.container).trim()}` : null,
  (s) => {
    const cmd = String(s.startCommand || "").trim().replace(/\s+/g, " ");
    return cmd ? `cmd:${String(s.dir || "").trim()}\n${cmd}` : null;
  },
];
const inventoryRow = (r) => ({ ...r, startCommand: r.start_command });

/**
 * Reconcile the findings of a service scan with the stock of the project, in ONE transaction.
 * @param {{ keep?: Set<number>, onlySupplement?: boolean }} [opts]  `keep`: the ids that run or are in the target of
 *   an instance — only with it the reconciliation removes a 'scan' row no longer found (without it nothing);
 *   `onlySupplement`: never remove anything.
 * @returns {{ services: object[], notFound: { id: number, name: string }[], removed: { id: number, name: string }[] }}
 *   the list afterwards (like listProjectServices), the stock services the scan did not name and that stay, and
 *   those that fell.
 */
function reconcileScan(projectId, findings, opts = {}) {
  const r = reconcileScanFromInTransaction(projectId, findings, opts);
  // After the transaction: whoever hung on a removed service learns it now (store/project-instances.js).
  if (r.removed.length) reportTargetRemoved({ kind: "service", projectId: String(projectId), serviceIds: r.removed.map((e) => e.id) });
  return r;
}
function reconcileScanFromInTransaction(projectId, findings, { keep = null, onlySupplement = false } = {}) {
  return inTransaction(() => {
    const inventory = db.prepare("SELECT * FROM project_services WHERE project_id = ? ORDER BY id").all(projectId).map(inventoryRow);
    const list = Array.isArray(findings) ? findings.filter((f) => f && String(f.name || "").trim()) : [];
    const assignment = new Map(); // finding index → stock row
    const allocated = new Set();  // ids that already have a finding
    for (const key of scanKey) {
      for (let i = 0; i < list.length; i++) {
        if (assignment.has(i)) continue;
        const k = key(list[i]);
        if (!k) continue;
        const hits = inventory.find((r) => !allocated.has(r.id) && key(r) === k);
        if (hits) { assignment.set(i, hits); allocated.add(hits.id); }
      }
    }
    const override = db.prepare("SELECT start_command FROM service_start_commands WHERE project_id = ? AND service_key = ?");
    const intoThe = db.prepare(
      `INSERT INTO project_services (project_id, name, kind, port, container, tech, dir, start_command, description, created_at, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scan')`
    );
    const upd = db.prepare("UPDATE project_services SET kind = ?, port = ?, container = ?, tech = ?, dir = ?, start_command = ?, description = ? WHERE id = ?");
    const del = db.prepare("DELETE FROM project_services WHERE id = ?");
    const contains = (v) => String(v ?? "").trim() !== "";
    const filler = (fresh, old) => (contains(fresh) ? String(fresh) : old);
    const kind = (k) => (k && k !== "other" ? k : null); // "other" is the fallback, not a finding
    const now = nowMs();
    list.forEach((s, i) => {
      const r = assignment.get(i);
      if (!r) {
        const manual = override.get(projectId, svcKey(s.name))?.start_command;
        intoThe.run(projectId, s.name, s.kind || "other", s.port ?? null, s.container || "", s.tech || "", s.dir || "", manual || s.startCommand || "", s.description || "", now);
        return;
      }
      const manual = override.get(projectId, svcKey(r.name))?.start_command;
      // A row registered by hand: what is there was said by a human or agent — the scan only fills blanks.
      const ofHand = r.origin === "hand";
      const field = (fresh, old) => (ofHand ? (contains(old) ? String(old) : filler(fresh, old ?? "")) : filler(fresh, old ?? ""));
      upd.run(
        ofHand ? (kind(r.kind) || kind(s.kind) || r.kind || "other") : (kind(s.kind) || r.kind),
        ofHand ? (r.port ?? s.port ?? null) : (s.port ?? r.port ?? null),
        field(s.container, r.container || ""),
        field(s.tech, r.tech || ""),
        field(s.dir, r.dir || ""),
        manual || field(s.startCommand, r.start_command || ""),
        field(s.description, r.description || ""),
        r.id,
      );
    });
    const notFound = [];
    const removed = [];
    for (const r of inventory) {
      if (allocated.has(r.id)) continue;
      if (onlySupplement !== true && r.origin === "scan" && keep instanceof Set && !keep.has(r.id)) {
        del.run(r.id);
        removed.push({ id: r.id, name: r.name });
      } else notFound.push({ id: r.id, name: r.name });
    }
    return { services: listProjectServices(projectId), notFound, removed };
  });
}

// The name of the frozen facade (server/backend/test/store-facade.test.js, "old names"): the same reconciliation,
// returning only the list. The name dates from when a scan replaced the stock — it no longer does (see above).
export function replaceProjectServices(projectId, services) {
  return reconcileScan(projectId, services).services;
}

// Get/correct/remove a single scanned service — e.g. so that an agent (cbase_service_update) can set the scan data
// right directly after really resolving a conflict (no re-scan needed).
export const getProjectService = (id) => {
  const r = db.prepare("SELECT * FROM project_services WHERE id = ?").get(id);
  return r ? mapProjectService(r) : null;
};
// Replaced start commands kept per service. A count limit, not a time limit: an agent that bends a command three
// times in one session must not be able to push the original state out of the history, and a service nobody has
// touched for months must not lose its old versions.
const SVC_CMD_HISTORY_KEEP = 10;

export function updateProjectService(id, fields) {
  const map = { name: "name", kind: "kind", port: "port", container: "container", tech: "tech", dir: "dir", startCommand: "start_command", description: "description" };
  // The REPLACED command must be read BEFORE the UPDATE — afterwards it is gone. That is the whole purpose of the
  // history, and the order is the only place it depends on.
  const prior = "startCommand" in fields ? getProjectService(id) : null;
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map)) if (k in fields) { sets.push(`${col} = ?`); vals.push(fields[k]); }
  if (!sets.length) return getProjectService(id);
  vals.push(id);
  db.prepare(`UPDATE project_services SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  const row = getProjectService(id);
  if (row && prior) {
    const oldCmd = String(prior.startCommand || "").trim();
    const newCmd = String(fields.startCommand || "").trim();
    // Only record real replacements: saving without a change is none, and an empty predecessor has nothing to rescue.
    // The name key comes from the PREVIOUS name, otherwise a rename would put the history under a key the command
    // never stood under.
    if (oldCmd && oldCmd !== newCmd) {
      const key = svcKey(prior.name);
      db.prepare("INSERT INTO service_command_history (project_id, service_key, start_command, replaced_at) VALUES (?, ?, ?, ?)")
        .run(prior.projectId, key, oldCmd, nowMs());
      db.prepare(`DELETE FROM service_command_history
                  WHERE project_id = ? AND service_key = ? AND id NOT IN (
                    SELECT id FROM service_command_history WHERE project_id = ? AND service_key = ?
                    ORDER BY replaced_at DESC, id DESC LIMIT ?)`)
        .run(prior.projectId, key, prior.projectId, key, SVC_CMD_HISTORY_KEEP);
      // The displaced command travels back with the response: whoever overwrites should learn in the same step WHAT
      // they overwrote — otherwise they never notice.
      row.replacedStartCommand = oldCmd;
    }
  }
  // Remember a start command change as a manual correction (survives re-scans); an empty value deletes the
  // correction → the next scan may derive the command itself again.
  if (row && "startCommand" in fields) {
    const cmd = String(fields.startCommand || "").trim();
    if (cmd) {
      db.prepare(`INSERT INTO service_start_commands (project_id, service_key, start_command, updated_at)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT(project_id, service_key) DO UPDATE SET start_command = excluded.start_command, updated_at = excluded.updated_at`)
        .run(row.projectId, svcKey(row.name), cmd, nowMs());
    } else {
      db.prepare("DELETE FROM service_start_commands WHERE project_id = ? AND service_key = ?").run(row.projectId, svcKey(row.name));
    }
  }
  return row;
}
export function deleteProjectService(id) {
  const svc = getProjectService(id);
  const removed = db.prepare("DELETE FROM project_services WHERE id = ?").run(id).changes > 0;
  // A preview link to this service ends AT ONCE (store/project-instances.js reportTargetRemoved).
  if (removed && svc) reportTargetRemoved({ kind: "service", projectId: String(svc.projectId), serviceIds: [svc.id] });
  return removed;
}

// A service under a dropped path falls together with its corrected start command, its history and its start
// instructions (all three hang on the name key, not the id — without this they would live on under the name and
// end up with the next service of the same name). In ONE transaction. A wrapper export (store-facade.test.js:
// every new name of the facade comes from an `export { … };` line).
function serviceFallsWithLayout(id) {
  const svc = getProjectService(id);
  if (!svc) return false;
  inTransaction(() => {
    db.prepare("DELETE FROM service_start_commands WHERE project_id = ? AND service_key = ?").run(svc.projectId, svcKey(svc.name));
    db.prepare("DELETE FROM service_command_history WHERE project_id = ? AND service_key = ?").run(svc.projectId, svcKey(svc.name));
    db.prepare("DELETE FROM service_start_instructions WHERE project_id = ? AND service_key = ?").run(svc.projectId, svcKey(svc.name));
    db.prepare("DELETE FROM project_services WHERE id = ?").run(id);
  });
  reportTargetRemoved({ kind: "service", projectId: String(svc.projectId), serviceIds: [svc.id] });
  return true;
}
export { serviceFallsWithLayout };

// Replaced start commands of a service, most recent first. Read through the name key (not the service id): the
// history hangs on the name.
export function serviceCommandHistory(id, limit = SVC_CMD_HISTORY_KEEP) {
  const svc = getProjectService(id);
  if (!svc) return [];
  const n = Math.max(1, Math.min(Number(limit) || SVC_CMD_HISTORY_KEEP, SVC_CMD_HISTORY_KEEP));
  return db.prepare(`SELECT start_command, replaced_at FROM service_command_history
                     WHERE project_id = ? AND service_key = ?
                     ORDER BY replaced_at DESC, id DESC LIMIT ?`)
    .all(svc.projectId, svcKey(svc.name), n)
    .map((r) => ({ startCommand: r.start_command, replacedAt: r.replaced_at }));
}

export function listProjectContext(projectId, { category, q, tag, withBody = true, status, path } = {}) {
  const cols = withBody ? "*"
    : `id, project_id, category, title, summary, tags, source, valid_as_of, pinned, created_at, updated_at,
       slug, status, superseded_by, owners, links, code_paths, symbols, last_verified, confidence`;
  let sql = `SELECT ${cols} FROM project_context WHERE project_id = ?`;
  const params = [projectId];
  if (category) { sql += " AND category = ?"; params.push(category); }
  if (tag) { sql += " AND tags LIKE ?"; params.push(`%${tag}%`); }
  // status: 'active' (default of the tools), 'all', or a concrete value.
  if (status && status !== "all") { sql += " AND status = ?"; params.push(status); }
  if (q) {
    sql += " AND (title LIKE ? OR body LIKE ? OR summary LIKE ? OR tags LIKE ? OR slug LIKE ? OR owners LIKE ? OR code_paths LIKE ? OR symbols LIKE ?)";
    const l = `%${q}%`; params.push(l, l, l, l, l, l, l, l);
  }
  sql += " ORDER BY pinned DESC, updated_at DESC";
  let rows = db.prepare(sql).all(...params).map(mapCtx);
  // path filter: the entry covers the path (the entry path is a prefix of the searched one or vice versa).
  if (path) {
    const norm = String(path).replace(/^\.\//, "").replace(/\/+$/, "");
    rows = rows.filter((r) => (r.codePaths || []).some((p) => {
      const e = String(p).replace(/^\.\//, "").replace(/\/+$/, "");
      return e === norm || norm.startsWith(e + "/") || e.startsWith(norm + "/");
    }));
  }
  return rows;
}

export const getProjectContext = (projectId, idOrSlug) => {
  const bySlug = typeof idOrSlug === "string" && !/^\d+$/.test(idOrSlug);
  return mapCtx(bySlug
    ? db.prepare("SELECT * FROM project_context WHERE project_id = ? AND slug = ?").get(projectId, idOrSlug)
    : db.prepare("SELECT * FROM project_context WHERE project_id = ? AND id = ?").get(projectId, Number(idOrSlug)));
};

export function createProjectContext(projectId, { category, title, body, summary, tags, source, validAsOf, pinned,
  slug, status, supersededBy, owners, links, codePaths, symbols, lastVerified, confidence }) {
  const now = nowMs();
  const finalSlug = uniqueSlug("project_context", "project_id", projectId, slug || title);
  const info = db.prepare(
    `INSERT INTO project_context (project_id, category, title, body, summary, tags, source, valid_as_of, pinned, created_at, updated_at,
       slug, status, superseded_by, owners, links, code_paths, symbols, last_verified, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(projectId, category, title || "", body || "", summary || "",
    Array.isArray(tags) ? tags.join(", ") : (tags || ""), source || "", validAsOf || "", pinned ? 1 : 0, now, now,
    finalSlug, status || "active", supersededBy || "",
    Array.isArray(owners) ? owners.join(", ") : (owners || ""),
    (() => { const l = normalizeLinks(links); return l ? JSON.stringify(l) : ""; })(),
    Array.isArray(codePaths) && codePaths.length ? JSON.stringify(codePaths.map(String)) : "",
    Array.isArray(symbols) ? symbols.join(", ") : (symbols || ""),
    lastVerified ? JSON.stringify(lastVerified) : "", confidence || "");
  return getProjectContext(projectId, Number(info.lastInsertRowid));
}

export function updateProjectContext(projectId, id, fields) {
  const sets = ["updated_at = ?"], vals = [nowMs()];
  const map = { category: "category", title: "title", body: "body", summary: "summary", source: "source", validAsOf: "valid_as_of",
    status: "status", supersededBy: "superseded_by", confidence: "confidence" };
  for (const [k, col] of Object.entries(map)) {
    if (fields[k] !== undefined && fields[k] !== null) { sets.push(`${col} = ?`); vals.push(fields[k]); }
  }
  for (const [k, col] of [["tags", "tags"], ["owners", "owners"], ["symbols", "symbols"]]) {
    if (fields[k] !== undefined && fields[k] !== null) {
      sets.push(`${col} = ?`); vals.push(Array.isArray(fields[k]) ? fields[k].join(", ") : fields[k]);
    }
  }
  if (fields.slug !== undefined && fields.slug !== null && String(fields.slug).trim()) {
    sets.push("slug = ?"); vals.push(uniqueSlug("project_context", "project_id", projectId, fields.slug, id));
  }
  if (fields.links !== undefined) {
    const l = normalizeLinks(fields.links);
    sets.push("links = ?"); vals.push(l ? JSON.stringify(l) : "");
  }
  if (fields.codePaths !== undefined && fields.codePaths !== null) {
    sets.push("code_paths = ?"); vals.push(Array.isArray(fields.codePaths) && fields.codePaths.length ? JSON.stringify(fields.codePaths.map(String)) : "");
  }
  if (fields.lastVerified !== undefined) {
    sets.push("last_verified = ?"); vals.push(fields.lastVerified ? JSON.stringify(fields.lastVerified) : "");
  }
  if (fields.pinned !== undefined && fields.pinned !== null) { sets.push("pinned = ?"); vals.push(fields.pinned ? 1 : 0); }
  vals.push(projectId, id);
  db.prepare(`UPDATE project_context SET ${sets.join(", ")} WHERE project_id = ? AND id = ?`).run(...vals);
  return getProjectContext(projectId, id);
}

// All slugs of a project (for link validation) — slug→{id,title,status}.
export const projectContextSlugs = (projectId) =>
  new Map(db.prepare("SELECT id, slug, title, status FROM project_context WHERE project_id = ? AND slug != ''")
    .all(projectId).map((r) => [r.slug, { id: r.id, title: r.title, status: r.status }]));

export const deleteProjectContext = (projectId, id) =>
  db.prepare("DELETE FROM project_context WHERE project_id = ? AND id = ?").run(projectId, id).changes > 0;

export const projectContextCategories = (projectId) =>
  db.prepare("SELECT category, COUNT(*) AS n FROM project_context WHERE project_id = ? GROUP BY category").all(projectId);

// ── Ports & services (project_services = single source of truth) ──────────────
// There is no second registry. What counts are the project_services detected by the scan or corrected by an agent
// (cbase_service_*). A port conflict is a port that MORE THAN ONE project claims.

// Create a single service on a project (e.g. through cbase_service_add when the scan missed a service).
// Origin 'hand': the reconciliation of a re-scan never removes this row and overwrites no field that carries a
// value — it only fills blanks (reconcileScan). So the start command does NOT go to service_start_commands: that
// table is the correction by hand (PATCH), and the relocation reads "no row" as "nothing corrected"
// (relocation-data.test.js).
export function addProjectService(projectId, { name, kind = "other", port = null, container = "", tech = "", dir = "", startCommand = "", description = "" }) {
  const info = db.prepare(
    `INSERT INTO project_services (project_id, name, kind, port, container, tech, dir, start_command, description, created_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hand')`
  ).run(projectId, name, kind, port ?? null, container, tech, dir, startCommand, description, nowMs());
  return getProjectService(Number(info.lastInsertRowid));
}

// THE conflict calculation. Everyone asks here — /api/ports/conflicts and the service scan through
// projectPortConflicts, the port list through portConflicts — so that the filter "without converted projects"
// lives in one place.
//
// Conflict = a port that MORE THAN ONE project claims — among the projects that are NOT converted. A converted
// project listens in the own network namespace of its project container; its ports belong to it, it can share a
// port with no other project. `converted` is the set of these project ids (projectbox/network-targets.js
// convertedProjects; the data layer does not know the ops marker). MANDATORY: without it the calculation throws —
// a forgotten filter would otherwise silently be the old state (a missing field says nothing). The empty set is
// the answer "none converted".
function convertedSet(converted) {
  if (converted instanceof Set) return new Set([...converted].map(String));
  if (Array.isArray(converted)) return new Set(converted.map(String));
  throw new TypeError("conflict calculation without the set of converted projects — empty means: none converted, missing is not a state");
}

/**
 * The ports more than one non-converted project claims: `[{ port, claims }]` in the order of the claims
 * (listScannedPorts: ascending by port), `claims` the rows of all claiming services of this port.
 * `claims` not passed: the stock (listScannedPorts).
 */
function portConflicts(converted, claims) {
  const without = convertedSet(converted); // before any read: no set, no calculation
  const byPort = new Map();
  for (const r of claims ?? listScannedPorts()) {
    if (without.has(String(r.projectId))) continue;
    if (!byPort.has(r.port)) byPort.set(r.port, []);
    byPort.get(r.port).push(r);
  }
  const out = [];
  for (const [port, arr] of byPort) {
    if (new Set(arr.map((a) => a.projectId)).size < 2) continue; // only real multiple claims
    out.push({ port, claims: arr });
  }
  return out;
}

// Port conflict per project: its own conflict ports with the OTHER claiming projects each (owner) — basis for the
// warning icons on the project cards (/api/ports/conflicts) and the conflict count of the service scan. A
// converted project is never here, neither with its own ports nor as `owner` of another (portConflicts).
export function projectPortConflicts(converted) {
  const map = {};
  for (const { port, claims: arr } of portConflicts(converted)) {
    for (const r of arr) {
      const others = [...new Set(arr.filter((x) => x.projectId !== r.projectId).map((x) => x.projectName))].join(", ");
      (map[r.projectId] ??= []).push({ port, name: r.name, owner: others });
    }
  }
  return map;
}

// ALL scanned project services (also without a port, e.g. Docker workers/internal DBs) — for the apps page, which
// shows portless services under the app card.
export const listAllProjectServices = () =>
  db.prepare(`SELECT ps.id, ps.project_id, ps.name, ps.kind, ps.port, ps.container, ps.tech, ps.start_command,
                     ps.description,
                     p.name AS project_name, p.workspace_id, si.instructions AS agent_instructions
              FROM project_services ps JOIN projects p ON p.id = ps.project_id
              LEFT JOIN service_start_instructions si
                ON si.project_id = ps.project_id AND si.service_key = lower(trim(ps.name))
              ORDER BY ps.port IS NULL, ps.port, ps.kind, ps.name`).all()
    // `description` travels along: it is the operating guide of the service (which port is assigned to it, which env
    // variable breaks it). Without it in the list it was visible nowhere and could silently go stale against the
    // start command next to it.
    .map((r) => ({ id: r.id, projectId: r.project_id, projectName: r.project_name, workspaceId: r.workspace_id,
                   name: r.name, kind: r.kind, port: r.port ?? null, container: r.container || "",
                   tech: r.tech, startCommand: r.start_command || "", description: r.description || "",
                   agentInstructions: r.agent_instructions || "" }));

// All ports CLAIMED by projects (project_services with a port) incl. ownership + service id/container/start
// command — the only port source.
export const listScannedPorts = () =>
  db.prepare(`SELECT ps.id, ps.port, ps.name, ps.kind, ps.tech, ps.container, ps.start_command,
                     p.id AS project_id, p.name AS project_name, p.workspace_id
              FROM project_services ps JOIN projects p ON p.id = ps.project_id
              WHERE ps.port IS NOT NULL ORDER BY ps.port ASC`).all()
    .map((r) => ({ id: r.id, port: r.port, name: r.name, kind: r.kind, tech: r.tech,
                   container: r.container || "", startCommand: r.start_command || "",
                   projectId: r.project_id, projectName: r.project_name, workspaceId: r.workspace_id }));

// The ports in circulation (for the "taken/free" calculation).
export const claimedPorts = () =>
  new Set(db.prepare("SELECT port FROM project_services WHERE port IS NOT NULL").all().map((r) => r.port));

// Services to be watched by the background monitor: project_services with a port OR a container.
export function listMonitoredServices() {
  return db.prepare(`
    SELECT ps.id, ps.project_id, ps.name, ps.port, ps.container, ps.dir, p.name AS project_name, p.workspace_id
    FROM project_services ps JOIN projects p ON p.id = ps.project_id
    WHERE ps.port IS NOT NULL OR ps.container != ''`).all()
    .map((r) => ({
      key: `project:${r.id}`, name: r.name, projectId: r.project_id, projectName: r.project_name,
      workspaceId: r.workspace_id, port: r.port ?? null, container: r.container || "", dir: r.dir || "",
    }));
}

export { listProjects, portConflicts };
export { savedStartCommand };

// ── Port rollback of the relocation (projectbox/relocation/data.js) ─────────────────────────────────────────────────
// The relocation changes start command and port of a service and must be able to restore them BYTE-IDENTICALLY on
// the way back — including the row in service_start_commands (also "no row": one missing before falls again).
// updateProjectService is no good for that: it creates a row on every start command and stamps it anew. This path
// does not touch the history (service_command_history); the relocation journal keeps the old values.

/** The row of a service in service_start_commands — `{ startCommand, updatedAt }` or null ("no row"). */
function serviceStartRow(projectId, name) {
  const r = db.prepare("SELECT start_command, updated_at FROM service_start_commands WHERE project_id = ? AND service_key = ?")
    .get(String(projectId), svcKey(name));
  return r ? { startCommand: r.start_command, updatedAt: r.updated_at } : null;
}

/**
 * Set start command, port and row in service_start_commands of a service EXACTLY, in one transaction
 * (`startRow: null` deletes the row). No history, no stamp. Returns the service afterwards, null without a service.
 */
function setService(id, { startCommand, port, startRow }) {
  const row = getProjectService(id);
  if (!row) return null;
  inTransaction(() => { // the ROLLBACK is guarded (inTransaction, above)
    db.prepare("UPDATE project_services SET start_command = ?, port = ? WHERE id = ?").run(String(startCommand ?? ""), port ?? null, id);
    if (startRow) {
      db.prepare(`INSERT INTO service_start_commands (project_id, service_key, start_command, updated_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT(project_id, service_key) DO UPDATE SET start_command = excluded.start_command, updated_at = excluded.updated_at`)
        .run(row.projectId, svcKey(row.name), String(startRow.startCommand ?? ""), Number(startRow.updatedAt));
    } else {
      db.prepare("DELETE FROM service_start_commands WHERE project_id = ? AND service_key = ?").run(row.projectId, svcKey(row.name));
    }
  });
  return getProjectService(id);
}

export { setService, serviceStartRow, reconcileScan };
