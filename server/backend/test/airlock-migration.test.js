// Coding MCP airlock: the one-time migration `migration.coding_mcp_from_definitions` (toolchain/agent-tools.js dropCodingServer).
//
// Since the airlock a subagent inherits a coding server only through the switch "subagents inherit"; a name in the tool list
// of a definition no longer has any effect in coding. The migration strikes it — workspace AND project servers —, leaves every
// other server name standing, turns an emptied list into `[]` (never `null`: unset would mean "the full set"), runs exactly
// once and not at all without a definition (no marker).
//
// Counter-proofs (each in a copy; which sabotage turns which test red):
//   agent-tools.js: `rest` empty => `null` written            => red ("only-jira" would be the full set)
//   agent-tools.js: check `coding.has(server)` removed         => red ("mixed" loses mcp__crm)
//   agent-tools.js: marker not read                            => red (the second start strikes from the new definition)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { CODING_MCP_MIGRATION_MARKER, dropCodingServer } from "../electron/server/toolchain/agent-tools.js";

test("migration of coding MCP from definitions: coding names gone, other servers stay, [] never null, exactly once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-airlock-migrate-"));
  try {
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    store.initStore(dataDir);

    // Without a definition: nothing to do, no marker (a store created later migrates at the next start).
    assert.equal(dropCodingServer(), null);
    assert.equal(store.getSetting(CODING_MCP_MIGRATION_MARKER, ""), "");

    const T0 = 1_792_000_000_000;
    store.createWorkspace({ id: "ws-s", name: "Demo", path: path.join(root, "ws"), createdAt: T0 });
    store.addProject("ws-s", { id: "p-s", name: "Proj", path: path.join(root, "ws", "proj"), createdAt: T0 });
    store.createMcpServer({ id: "m-pg", workspaceId: "ws-s", name: "pg", transport: "stdio", command: "node", createdAt: T0, updatedAt: T0 });
    store.createMcpServer({ id: "m-jira", workspaceId: "ws-s", projectId: "p-s", name: "jira", transport: "http", url: "https://jira.invalid/mcp", createdAt: T0, updatedAt: T0 });
    store.createMcpServer({ id: "m-teams", workspaceId: "ws-s", name: "teams", transport: "http", url: "https://teams.invalid/mcp", createdAt: T0, updatedAt: T0 });

    const defs = {
      mixed: ["Read", "mcp__pg__query", "mcp__cbase", "mcp__crm"],
      "only-jira": ["mcp__jira"],
      teams: ["Read", "mcp__teams__send"],
      free: null,
      foreign: ["mcp__playwright", "mcp__unknown__x"],
    };
    for (const [name, toolList] of Object.entries(defs)) store.createAgent({ id: `a-${name}`, workspaceId: "ws-s", name, toolList, createdAt: T0, updatedAt: T0 });

    const r = dropCodingServer();
    assert.equal(r.definitions, 3);
    assert.deepEqual(r.struck.sort(), ["mixed: mcp__pg__query", "only-jira: mcp__jira", "teams: mcp__teams__send"]);

    const list = (name) => store.getAgent(`a-${name}`).toolList;
    assert.deepEqual(list("mixed"), ["Read", "mcp__cbase", "mcp__crm"], "coding name gone, a foreign server name and cbase stay");
    assert.deepEqual(list("only-jira"), [], "a project server counts too; emptied is [] — never null (that would mean: the full set)");
    assert.deepEqual(list("teams"), ["Read"], "a single tool of a coding server falls too");
    assert.equal(list("free"), null, "unset stays unset");
    assert.deepEqual(list("foreign"), defs.foreign, "no coding server: untouched");
    assert.ok(store.getSetting(CODING_MCP_MIGRATION_MARKER, ""), "marker set");

    // Exactly once: a definition created afterwards with a coding name stays (the editor rejects it anyway, the DB does not).
    store.createAgent({ id: "a-new", workspaceId: "ws-s", name: "fresh", toolList: ["mcp__pg"], createdAt: T0, updatedAt: T0 });
    assert.equal(dropCodingServer(), null);
    assert.deepEqual(store.getAgent("a-new").toolList, ["mcp__pg"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
