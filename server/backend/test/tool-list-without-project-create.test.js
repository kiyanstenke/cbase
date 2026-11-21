// Project creation: agents no longer create projects, and "detect" is gone.
//
// Removed tool - the tool `cbase_project_create` fell out of the catalog (mcp/tools/projects.js; snapshot mcp-catalog.snapshot.txt, fence line
// "project-create" with `withoutMcp`). A stored tool list that still carries the name would no longer be saveable (`unknownInWorkspace`
// names it => 400 at the route); at run time nobody checks the names (the bare name would go to the CLI as a "built-in" tool, the long
// one would silently drop out). Hence the one-time migration `dropRemovedTools` (toolchain/agent-tools.js, marker
// `migration.without_project_create`, called in server.js after `migrateToolLists`). The promises, each with the way that breaks it:
//   (1) both spellings fall (bare and `mcp__cbase__…`), everything else stays in its order;
//   (2) `null` (not set) stays `null`, a list that carried ONLY the tool becomes `[]` - never `null` ("the full set");
//   (3) workspace AND project definitions; afterwards every list is saveable again;
//   (4) the count appears in the log; once per deposit (marker), an empty deposit gets no marker (golden fixtures);
//   (5) on a real server: the START migrates (server.js calls it), the route returns the lists without the name.
//   (7) Legacy data before the tool-list column (comma list in `tools`, without a JSON column, without its marker): the first migration
//       does NOT append `mcp__cbase` to a list that names ONLY the removed name as a cbase tool (the full catalog - the old Claude way
//       gave it exactly that one tool), and a list with `*` (which the first migration skips) loses the name as well.
// Removed routes - `GET …/detect-projects` and `POST …/projects/import` are gone: (6) 404 on a real server, and no project is created.
// The reading side (the routes appear in no file of the tree any more) is held by tools/check/routes.test.mjs, the clients by
// web/test/project-creation-legacy-data.test.mjs.
//
// No clock: the migration is synchronous; the server is only waited on for responses (restart waits for idle).
//
// COUNTER-TESTS (each shown red once, the whole file run):
//   server.js without the call `dropRemovedTools();`  => (5) red ("planner: the name is gone" - the list still carries
//                                                        cbase_project_create after the restart), (1)-(4) green
//   agent-tools.js: only the bare spelling falls      => (1)-(4) red ({ definitions: 3 } instead of 5), (5) red ("creator" keeps
//                                                        mcp__cbase__cbase_project_create)
//   agent-tools.js: an emptied list becomes `null`    => (1)-(4) red ("only: null !== []"), (5) red ("creator: null !== []")
//   workspaces/routes.js before the detect routes were removed => (6) red ({ detect: 200, takeOver: 201, newProjects: 1 })
//   agent-tools.js without `&& !namesRemoved`          => (7) red (onlyRemoved/onlyRemovedLang get mcp__cbase)
//   store/toolchain.js `agentsWithToolList` only the JSON column => (7) red (star keeps cbase_project_create)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { json, withAgentsServer } from "./agent-harness.mjs";
import * as store from "../electron/server/store.js";
import { CATALOG_NAMES } from "../electron/mcp/catalog.js";
import {
  REMOVED_MIGRATION_MARKER, REMOVED_TOOLS, dropRemovedTools, unknownInWorkspace, migrateToolLists,
} from "../electron/server/toolchain/agent-tools.js";

const NAME = "cbase_project_create";
const LANG = `mcp__cbase__${NAME}`;

// The lines a migration writes to the log (console.log) while `fn` runs.
async function withLog(fn) {
  const rows = [];
  const log = console.log;
  console.log = (...a) => { rows.push(a.join(" ")); log(...a); };
  try { await fn(); } finally { console.log = log; }
  return rows.filter((z) => z.includes("[store] tool lists:") && z.includes("without cbase_project_create"));
}

test("(1)-(4) Migration: both spellings fall, null stays null, only-the-tool becomes [], count in the log, once per deposit", async () => {
  // The reason: the tool is no longer in the catalog - otherwise the migration would be none.
  assert.deepEqual([...REMOVED_TOOLS], [NAME]);
  assert.ok(!CATALOG_NAMES.includes(NAME), `${NAME} is still in the catalog`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-removed-tool-migration-"));
  try {
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    store.initStore(dataDir);
    // (4) An empty deposit gets no marker (the golden fixtures are empty deposits - their db.json would otherwise not stay the same).
    assert.equal(dropRemovedTools(), null);
    assert.equal(store.getSetting(REMOVED_MIGRATION_MARKER, ""), "");

    const T0 = 1_790_000_000_000;
    store.createWorkspace({ id: "ws-removed", name: "Demo", path: path.join(root, "ws"), createdAt: T0 });
    store.addProject("ws-removed", { id: "p-removed", name: "Checkout", path: path.join(root, "ws", "till"), createdAt: T0 });
    const definitions = {
      both: { list: ["Read", NAME, "cbase_projects_list", LANG, "Grep"], desired: ["Read", "cbase_projects_list", "Grep"] },
      lang: { list: [LANG, "mcp__cbase__cbase_project_update"], desired: ["mcp__cbase__cbase_project_update"] },
      only: { list: [NAME], desired: [] },
      onlyLang: { list: [LANG], desired: [] },
      free: { list: null, desired: null },
      empty: { list: [], desired: [] },
      wholeServer: { list: ["Read", "mcp__cbase", "mcp__playwright"], desired: ["Read", "mcp__cbase", "mcp__playwright"] },
      project: { list: ["Bash", NAME], desired: ["Bash"], project: "p-removed" },
    };
    for (const [name, d] of Object.entries(definitions)) {
      store.createAgent({ id: `a-${name}`, workspaceId: "ws-removed", projectId: d.project || null, name, toolList: d.list, createdAt: T0, updatedAt: T0 });
    }
    // Without the migration: the definition is no longer saveable (the route answered 400 with the name).
    assert.equal(unknownInWorkspace(store.getAgent("a-both").toolList, "ws-removed"), NAME);
    assert.equal(unknownInWorkspace(store.getAgent("a-lang").toolList, "ws-removed"), LANG);

    let result;
    const log = await withLog(() => { result = dropRemovedTools(); });
    // both, lang, only, onlyLang, project - free, empty and wholeServer did not carry the name.
    assert.deepEqual(result, { definitions: 5 });
    assert.equal(log.length, 1, `exactly one line in the log: ${JSON.stringify(log)}`);
    assert.match(log[0], /^\[store\] tool lists: 5 definition\(s\) without cbase_project_create$/);

    for (const [name, d] of Object.entries(definitions)) {
      const a = store.getAgent(`a-${name}`);
      assert.deepEqual(a.toolList, d.desired, `${name}: list after the migration`);
      // The display column follows the list (store/toolchain.js listColumns).
      assert.equal(a.tools, Array.isArray(d.desired) ? d.desired.join(", ") : "", `${name}: tools`);
      // (3) Every list is saveable again.
      assert.equal(unknownInWorkspace(a.toolList, "ws-removed"), null, `${name}: saveable`);
    }
    assert.equal(store.getAgent("a-project").projectId, "p-removed", "the project definition is the same row");

    // (4) Once: the marker is set, a second start changes nothing - not even on a list that carries the name again afterwards (past
    // the route); a second run writes no log line.
    assert.ok(store.getSetting(REMOVED_MIGRATION_MARKER, ""));
    store.createAgent({ id: "a-afterwards", workspaceId: "ws-removed", name: "afterwards", toolList: [NAME], createdAt: T0, updatedAt: T0 });
    let second;
    const log2 = await withLog(() => { second = dropRemovedTools(); });
    assert.equal(second, null);
    assert.deepEqual(log2, []);
    assert.deepEqual(store.getAgent("a-afterwards").toolList, [NAME]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("(7) Legacy data before the tool-list column: a removed name does not fetch the full catalog, a `*` list loses it as well", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-removed-tool-legacy-"));
  try {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    store.initStore(path.join(root, "data"));
    const T0 = 1_790_000_000_000;
    store.createWorkspace({ id: "ws-old", name: "Legacy", path: path.join(root, "ws"), createdAt: T0 });
    // Stored rows as before the tool-list column: the comma list is in `tools`, the JSON column is empty - written raw as in
    // toolList.test.js (updateAgent writes `tools` only from the list any more).
    const old = {
      onlyRemoved: { tools: `Read, ${NAME}`, desired: ["Read", "mcp__playwright"] },
      onlyRemovedLang: { tools: `Grep, ${LANG}`, desired: ["Grep", "mcp__playwright"] },
      withoutCbase: { tools: "Read", desired: ["Read", "mcp__cbase", "mcp__playwright"] },
      stern: { tools: `*, ${NAME}`, desired: ["*"] },
    };
    for (const name of Object.keys(old)) {
      store.createAgent({ id: `a-${name}`, workspaceId: "ws-old", name, toolList: null, createdAt: T0, updatedAt: T0 });
    }
    const raw = new DatabaseSync(path.join(root, "data", "automater.db"));
    try {
      for (const [name, d] of Object.entries(old)) raw.prepare("UPDATE agents SET tools = ?, tool_list = NULL WHERE id = ?").run(d.tools, `a-${name}`);
    } finally { raw.close(); }
    for (const [name, d] of Object.entries(old)) {
      assert.deepEqual(store.getAgent(`a-${name}`).toolList, d.tools.split(",").map((x) => x.trim()), `${name}: legacy data read`);
    }
    // The order of the start (server.js): first the tool-list migration, then the removed-tool migration.
    migrateToolLists();
    dropRemovedTools();
    // In ONE comparison, so a counter-test shows all cases at once.
    assert.deepEqual(
      Object.fromEntries(Object.keys(old).map((name) => [name, store.getAgent(`a-${name}`).toolList])),
      Object.fromEntries(Object.entries(old).map(([name, d]) => [name, d.desired])),
      "legacy data after both migrations",
    );
    for (const name of Object.keys(old)) assert.equal(unknownInWorkspace(store.getAgent(`a-${name}`).toolList, "ws-old"), null, `${name}: saveable`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("(5) on a real server: the start migrates - the lists come without the name from the route, the count is in the log; (6) detect is 404", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws } = ctx;
    // The first start ran on a deposit without a definition: no marker (otherwise the migration below would no longer run).
    assert.equal(store.getSetting(REMOVED_MIGRATION_MARKER, ""), "", "the first start already set the marker");
    const T0 = Date.now();
    // Stock past the route (the route has since rejected the name - exactly the stock that has to migrate).
    store.createAgent({ id: "a-srv-1", workspaceId: ws.id, name: "planner", toolList: ["Read", NAME, "cbase_projects_list"], createdAt: T0, updatedAt: T0 });
    store.createAgent({ id: "a-srv-2", workspaceId: ws.id, name: "creator", toolList: [LANG], createdAt: T0, updatedAt: T0 });

    const log = await withLog(() => ctx.restart());
    const ofRoute = Object.fromEntries((await json(`${base}/api/workspaces/${ws.id}/agents`)).map((a) => [a.id, a]));
    assert.deepEqual(ofRoute["a-srv-1"]?.toolList, ["Read", "cbase_projects_list"], "planner: the name is gone");
    assert.deepEqual(ofRoute["a-srv-2"]?.toolList, [], "creator: [] - not null (that would mean \"the full set\")");
    assert.equal(log.length, 1, `exactly one line in the log of the start: ${JSON.stringify(log)}`);
    assert.match(log[0], /tool lists: 2 definition\(s\) without cbase_project_create/);
    assert.ok(store.getSetting(REMOVED_MIGRATION_MARKER, ""), "the marker is set after the start");

    // (6) P13: both routes are gone - also for a folder that "detect" would have offered earlier.
    fs.mkdirSync(path.join(ws.path, "candidate"), { recursive: true });
    const prior = store.listProjects(ws.id).length;
    const detect = await fetch(`${base}/api/workspaces/${ws.id}/detect-projects`, { headers: { Connection: "close" } });
    await detect.arrayBuffer();
    const takeOver = await fetch(`${base}/api/workspaces/${ws.id}/projects/import`, {
      method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ paths: [path.join(ws.path, "candidate")] }),
    });
    await takeOver.arrayBuffer();
    // In ONE comparison, so a counter-test shows all three statements at once.
    assert.deepEqual(
      { detect: detect.status, takeOver: takeOver.status, newProjects: store.listProjects(ws.id).length - prior },
      { detect: 404, takeOver: 404, newProjects: 0 },
      "GET …/detect-projects and POST …/projects/import are gone, and no project was created",
    );
  });
});
