// The schema registry, EFFECT page.
//
// The static guard in the gate (`schemaRegistry` in tools/check/lib/tree-rules.mjs) proves the registration is THERE. It does not
// prove it TAKES EFFECT. So here a second, independent source: the literal DDL from the SOURCE TEXT of all `store/*.js` against
// `sqlite_master` after a real `initStore` through the facade. Two sources also catch "registered, but the function creates
// nothing any more" and the dead registrant. If one of the registrations falls, tables are missing — without a throw, without a log.
//
// Deliberately its OWN file: `initStore` rebinds the module-wide `db`, and doing that in the middle of a file with running test
// servers would be a bet that nobody is writing at that moment.
//
// What deliberately falls through the grid: `CREATE TABLE` WITHOUT `IF NOT EXISTS` (migration intermediate tables that are renamed
// right away) and any DDL that is not a literal in the source text (built from a template or a variable). The README of `store/`
// names both: whoever writes like that registers themselves — the guard reads text.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import * as store from "../electron/server/store.js";
import { db as storeDb } from "../electron/server/store/db.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.join(HERE, "../electron/server/store");

// First the `//` lines, THEN the block comments — a `//` line may contain `/*` and would otherwise open a comment that swallows
// real code (same order as import-direction.test.js).
const withoutComments = (text) => text
  .split("\n").map((z) => z.replace(/\/\/.*$/, "")).join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const TABLE_RE = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
const INDEX_RE = /CREATE\s+(?:UNIQUE\s+)?(INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
const COLUMN_RE = /ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
const DROP_RE = /DROP\s+(?:TABLE|INDEX|TRIGGER)\s+IF\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
const DROP_COLUMN_RE = /ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+DROP\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
const RENAME_RE = /ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+RENAME\s+TO\s+([A-Za-z_][A-Za-z0-9_]*)/gi;

/** The literally promised objects and columns of all store/ files, each with its source file. */
export function promised(dir) {
  const objects = new Map();   // name → file
  const columns = new Map();   // "table.column" → file
  const gone = new Set();      // dropped or renamed
  const columnsGone = new Set();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js")).sort()) {
    const text = withoutComments(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const m of text.matchAll(TABLE_RE)) if (!objects.has(m[1])) objects.set(m[1], f);
    for (const m of text.matchAll(INDEX_RE)) if (!objects.has(m[2])) objects.set(m[2], f);
    for (const m of text.matchAll(COLUMN_RE)) { const k = `${m[1]}.${m[2]}`; if (!columns.has(k)) columns.set(k, f); }
    for (const m of text.matchAll(DROP_RE)) gone.add(m[1]);
    for (const m of text.matchAll(DROP_COLUMN_RE)) columnsGone.add(`${m[1]}.${m[2]}`);
    for (const m of text.matchAll(RENAME_RE)) { gone.add(m[1]); gone.add(m[2]); }
  }
  for (const n of gone) objects.delete(n);
  for (const k of columnsGone) columns.delete(k);
  for (const k of [...columns.keys()]) if (gone.has(k.split(".")[0])) columns.delete(k);
  return { objects, columns };
}

function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-schema-register-"));
  let raw = null;
  try {
    store.initStore(dir);
    raw = new DatabaseSync(path.join(dir, "automater.db"));
    run(raw);
  } finally {
    try { raw?.close(); } catch { /* closed is closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }
  }
}

test("every literally promised table, index and trigger is in the DB after initStore", () => {
  const { objects } = promised(STORE_DIR);
  assert.ok(objects.size >= 148, `too few objects read from the source text (${objects.size}, expected at least 148) — the extraction no longer works`);
  withStore((raw) => {
    const existing = new Set(raw.prepare("SELECT name FROM sqlite_master").all().map((r) => r.name));
    const missing = [...objects].filter(([n]) => !existing.has(n)).map(([n, f]) => `${n} (from store/${f})`);
    assert.deepEqual(missing, [], `after initStore ${missing.length} promised objects are missing — a schema registration does not run:\n  ${missing.join("\n  ")}`);
    console.log(`[schema-register] ${existing.size} objects in sqlite_master, of them ${raw.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n} tables; ${objects.size} promised by the source text`);
  });
});

test("every literally added column (ALTER TABLE … ADD COLUMN) is in its table after initStore", () => {
  const { columns } = promised(STORE_DIR);
  assert.ok(columns.size >= 41, `too few columns read from the source text (${columns.size}, expected at least 41) — the extraction no longer works`);
  withStore((raw) => {
    const missing = [];
    for (const [k, f] of columns) {
      const [tab, sp] = k.split(".");
      const cols = raw.prepare(`SELECT name FROM pragma_table_info(?)`).all(tab).map((r) => r.name);
      if (!cols.length) { missing.push(`${tab} (table missing, from store/${f})`); continue; }
      if (!cols.includes(sp)) missing.push(`${k} (from store/${f})`);
    }
    assert.deepEqual(missing, [], `after initStore ${missing.length} added columns are missing:\n  ${missing.join("\n  ")}`);
  });
});

test("runSchemata() without a single registration throws — the bypass of the facade is not silent", async () => {
  // Fresh module (query string against the module cache): the facade's registry is long since filled.
  const fresh = await import(`../electron/server/store/schema.js?empty=${Date.now()}`);
  assert.deepEqual(fresh.schemaNames(), [], "a freshly loaded registry is empty");
  assert.throws(() => fresh.runSchemata(), /schema registry is EMPTY/);
});

test("the facade's registration list is filled and in call order", async () => {
  const { schemaNames } = await import("../electron/server/store/schema.js");
  assert.deepEqual(schemaNames(), ["channels", "chat-archive", "effort-ultra-max", "chat-hints", "subagents", "dyn-workflows", "dyn-workflow-runs", "ultracode-reminder", "chat-upstream", "active-runs-announcements", "active-runs-consumption", "graph-starts", "project-instances", "project-relocations", "stack-copies", "ws-agents-default", "project-setup", "project-layout", "chat-search", "outer-loop", "preview-links", "chat-instance", "usage-cost", "usage-breakdown", "skills-area", "mcp-airlock", "chat-archive-reason", "chat-effort-own", "chat-target-pause", "chat-agenda", "skill-history", "mcp-hidden", "chat-job", "scheduled", "agenda-upkeep", "timeline", "instructions"]);
  // Names of the notable entries: "agenda-upkeep" (the agenda keeper's log),
  // "instructions" (agent instructions per workspace and project), "timeline" (the per-project timeline: four append-only tables
  // with triggers, column `projects.timeline_off`), "chat-agenda" (the agenda per coding chat), "mcp-airlock" (headers, tool cache,
  // choice, markers, "subagents inherit" and the baseline marker on mcp_servers, behind "skills-area"), "skill-history" (history
  // and deletion requests of the skills), "mcp-hidden" (`project_mcp_excluded`: the workspace MCP servers a project hides),
  // "chat-job" and "scheduled" (the binding `chats.job_id` with a unique partial index, and the three tables of the scheduled
  // jobs, registered last), "active-runs-consumption" and "usage-breakdown" (the session of the running turn on active_runs, cache
  // breakdown, generation ids and origin of the amounts on usage_events). The store no longer creates the tables of the removed
  // managing area.
});

// ── Delete lists ↔ schema ──────────────────────────────────────────────────────────────────────────────────────────
//
// `deleteWorkspace` and `deleteProject` (store/workspaces.js) are hand-written lists: the database knows no foreign keys. The guard
// reads the schema of a fresh database instead of a list: EVERY table with `workspace_id`/`project_id` gets a row for the workspace
// or the project, then the real delete path runs, and whatever still points at it must be in the exception list — with a reason.
// Both directions: an exception that holds nothing any more is just as red (otherwise the list would silently grow dead entries).
// A new table with such a column turns it red until one of the two paths names it or it stays here explicitly.

const SCOPE_COLUMNS = ["workspace_id", "project_id", "project_id"];

const EXCEPTIONS_WORKSPACE = {
  apps: "legacy data without reader or writer (store/projects.js: no second registry any more) — no row arises",
  project_instances: "project container: the row falls in the delete path of the project box (projectbox/erase.js → store.deleteProjectInstance) AFTER the container is gone — never the data layer alone",
  project_relocations: "journal of the relocations: proof and way back, the rows stay as history (the relocation folder falls with the project, projectbox/erase.js)",
  stack_copies: "history of the copies: a row ends as `removed` and is never deleted; a LIVE copy stops the delete (copyDeleteStep), container and folder are cleaned up by stacks/remove.js",
  // The four tables of the setup fall in the delete path of the project box (projectbox/erase.js → store.deleteSetup, project AND
  // workspace), like project_instances — never the data layer alone.
  project_setup: "setup of a new project: falls in the delete path of the project box (projectbox/erase.js setupsGone → store.deleteSetup), project and workspace",
  project_setup_source: "sources of a setup: fall with it in the delete path of the project box (store.deleteSetup)",
  project_archive: "archives of the setup and of the later upload (file in the runtime folder): fall in the delete path of the project box (store.deleteSetup), the file with the runtime folder",
  project_upload: "upload operations (content in the staging area in the project folder): fall in the delete path of the project box (store.deleteSetup)",
  // The layout job and the superseded containers of renamed stacks fall in the delete path of the project box (store.deleteLayout),
  // project and workspace — a running job is an occupation, a waiting one is withdrawn beforehand.
  project_layout: "layout job of an existing project: falls in the delete path of the project box (store.deleteLayout), project and workspace",
  project_superseded: "the old containers of renamed stacks: fall in the delete path of the project box (store.deleteLayout) — the containers themselves with the project container",
  // Deleting in the data layer would leave the ngrok listener open and the reserved name at ngrok. The delete path itself ends every
  // active link of its project AT ONCE (store.setTargetRemovedObserver → preview/links.js targetRemoved); the expiry tick is the safety
  // net; the row stays as history.
  preview_links: "history of the preview links: an active link of a deleted project is ended at once by the delete path (store.setTargetRemovedObserver → preview/links.js targetRemoved: listener closed, name free), the expiry tick catches the rest; the row stays as history (the last 20)",
};
const EXCEPTIONS_PROJECT = {
  ...EXCEPTIONS_WORKSPACE,
  workflow_runs: "run history: it stays with the project (with the workspace it falls, there is no place left)",
};

function scopeTables(db) {
  const tabs = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .filter((t) => !/^CREATE\s+VIRTUAL/i.test(t.sql || ""));
  const output = new Map();
  for (const { name } of tabs) {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all();
    if (cols.some((c) => SCOPE_COLUMNS.includes(c.name))) output.set(name, cols);
  }
  return output;
}

// Required columns with a value list (`CHECK (column IN ('a', …))`) get the first allowed value — a generic string would fail the
// check, and the seed would prove nothing any more.
function allowedValues(db, t) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)?.sql || "";
  const out = new Map();
  for (const m of sql.matchAll(/CHECK\s*\(\s*(\w+)\s+IN\s*\(\s*'([^']*)'/gi)) out.set(m[1], m[2]);
  return out;
}

/** One row per scope table for (ws, pr): required columns filled generically, scope columns set to ws or pr. */
function seedEveryScopeTable(db, ws, pr) {
  for (const [t, cols] of scopeTables(db)) {
    if (t === "workspaces" || t === "projects") continue;
    const allowed = allowedValues(db, t);
    const names = []; const values = [];
    const pks = cols.filter((c) => c.pk).length;
    for (const c of cols) {
      if (c.name === "workspace_id") { names.push(c.name); values.push(ws); continue; }
      if (c.name === "project_id" || c.name === "project_id") { names.push(c.name); values.push(pr); continue; }
      if (c.pk && pks === 1 && /INT/i.test(c.type)) continue;
      if (c.pk || (c.notnull && c.dflt_value == null)) { names.push(c.name); values.push(allowed.has(c.name) ? allowed.get(c.name) : /INT|REAL|NUM/i.test(c.type) ? 1 : `seed-${t}-${c.name}-${pr}`); }
    }
    db.prepare(`INSERT INTO ${t} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...values);
  }
}

/** Which tables still point at ws (if given) or pr? */
function showsStill(db, { ws = null, pr }) {
  const r = [];
  for (const [t, cols] of scopeTables(db)) {
    const names = cols.map((c) => c.name);
    const w = []; const v = [];
    if (ws && names.includes("workspace_id")) { w.push("workspace_id = ?"); v.push(ws); }
    for (const c of ["project_id", "project_id"]) if (names.includes(c)) { w.push(`${c} = ?`); v.push(pr); }
    if (!w.length) continue;
    if (db.prepare(`SELECT count(*) AS n FROM ${t} WHERE ${w.join(" OR ")}`).get(...v).n) r.push(t);
  }
  return r;
}

/** The verdict in both directions: what was left over without an exception, and which exception holds nothing (any more). */
function deleteFinding(rest, exceptions, tables) {
  return {
    leftOver: rest.filter((t) => !(t in exceptions)),
    exceptionWithoutRest: Object.keys(exceptions).filter((t) => tables.has(t) && !rest.includes(t)),
    exceptionWithoutTable: Object.keys(exceptions).filter((t) => !tables.has(t)),
  };
}

function withDeleteStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-delete-lists-"));
  try { store.initStore(dir); run(storeDb); }
  finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }
  }
}

function seedTwoProjects(db) {
  store.createWorkspace({ id: "ws-delete", name: "Delete probe", path: "/w/erase", createdAt: 1 });
  store.addProject("ws-delete", { id: "pr-stays", name: "stays", path: "/w/erase/a", createdAt: 1 });
  store.addProject("ws-delete", { id: "pr-falls", name: "falls", path: "/w/erase/b", createdAt: 1 });
  seedEveryScopeTable(db, "ws-delete", "pr-stays");
  seedEveryScopeTable(db, "ws-delete", "pr-falls");
  // Counter-test of the seed: without rows the verdict would prove nothing.
  // EVERY scope table now carries a row pointing at ws-delete/pr-falls (`projects` via its workspace_id).
  assert.deepEqual(showsStill(db, { ws: "ws-delete", pr: "pr-falls" }), [...scopeTables(db).keys()], "the seed does not take — a scope table stayed empty");
}

test("deleteProject: no table points at the project afterwards, except the named exceptions", () => {
  withDeleteStore((db) => {
    seedTwoProjects(db);
    const tables = scopeTables(db);
    assert.equal(store.deleteProject("ws-delete", "pr-falls"), true);
    const b = deleteFinding(showsStill(db, { pr: "pr-falls" }), EXCEPTIONS_PROJECT, tables);
    assert.deepEqual(b.leftOver, [], `after deleteProject ${b.leftOver.length} tables still point at the deleted project — delete or set NULL in store/workspaces.js:deleteProject, or exempt here with a reason: ${b.leftOver.join(", ")}`);
    assert.deepEqual(b.exceptionWithoutRest, [], `exceptions that hold nothing any more (remove): ${b.exceptionWithoutRest.join(", ")}`);
    assert.deepEqual(b.exceptionWithoutTable, [], `exceptions without a scope table: ${b.exceptionWithoutTable.join(", ")}`);
    // The sibling project stays untouched — a delete path that is too wide would be worse than one too narrow.
    const siblings = showsStill(db, { pr: "pr-stays" });
    assert.ok(siblings.includes("chats") && siblings.includes("project_vars"), `deleteProject also cleared the sibling project: ${siblings.join(", ")}`);
    console.log(`[delete-lists] deleteProject: ${tables.size} scope tables, ${Object.keys(EXCEPTIONS_PROJECT).length} exceptions`);
  });
});

test("deleteWorkspace: no table points at workspace or project afterwards, channels with log and participants fall with it", () => {
  withDeleteStore((db) => {
    seedTwoProjects(db);
    store.createChannel({ id: "channel-delete", workspaceId: "ws-delete", name: "K" });
    store.addChannelParticipants("channel-delete", { chatId: "seed-chats-id-pr-stays" });
    store.addChannelMessage({ channelId: "channel-delete", text: "hello" });
    const tables = scopeTables(db);
    const r = store.deleteWorkspace("ws-delete");
    for (const pr of ["pr-stays", "pr-falls"]) {
      const b = deleteFinding(showsStill(db, { ws: "ws-delete", pr }), EXCEPTIONS_WORKSPACE, tables);
      assert.deepEqual(b.leftOver, [], `after deleteWorkspace ${b.leftOver.length} tables still point at ${pr}/ws-delete — delete in store/workspaces.js:deleteWorkspace or exempt here with a reason: ${b.leftOver.join(", ")}`);
      assert.deepEqual(b.exceptionWithoutRest, [], `exceptions that hold nothing any more (remove): ${b.exceptionWithoutRest.join(", ")}`);
      assert.deepEqual(b.exceptionWithoutTable, [], `exceptions without a scope table: ${b.exceptionWithoutTable.join(", ")}`);
    }
    for (const t of ["channel_participants", "channel_messages"]) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${t} WHERE channel_id = ?`).get("channel-delete").n, 0, `${t} of the deleted channel was left behind`);
    }
    assert.ok(r && Array.isArray(r.channelIds) && r.channelIds.includes("channel-delete"), "deleteWorkspace does not name the channels — their files under channel-files/ would stay behind");
    assert.ok(r.chatIds.length >= 2, "deleteWorkspace does not name the chats — the close path would get nothing");
  });
});

test("delete-lists guard, built-in sabotage: a new scope table without a delete path and a dead exception turn red", () => {
  withDeleteStore((db) => {
    db.exec("CREATE TABLE sabotage_c3 (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL)");
    seedTwoProjects(db);
    const tables = scopeTables(db);
    store.deleteWorkspace("ws-delete");
    const b = deleteFinding(showsStill(db, { ws: "ws-delete", pr: "pr-falls" }), { ...EXCEPTIONS_WORKSPACE, exists_not: "Sabotage" }, tables);
    assert.ok(b.leftOver.includes("sabotage_c3"), "the guard does not see a new table without a delete path");
    assert.deepEqual(b.exceptionWithoutTable, ["exists_not"], "the guard does not see an exception without a table");
    const tot = deleteFinding([], EXCEPTIONS_WORKSPACE, tables);
    assert.deepEqual([...tot.exceptionWithoutRest].sort(), Object.keys(EXCEPTIONS_WORKSPACE).sort(), "the guard does not see an exception that holds nothing");
  });
});
