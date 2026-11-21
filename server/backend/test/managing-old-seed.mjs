// Seed of a store from BEFORE the removal of the manager area, for the guards written after it. The store no longer creates the
// manager tables and has no write paths onto them (store/managing.js with `createManagerAgent`, `createManagerSchedule`,
// `createManagerMcpServer` is gone). Whoever needs an old store (the migrations that must NOT touch the manager rows, the
// episode axis) creates the tables from the frozen old-schema seed (`fixtures/managing-old-schema.sql`) and writes the rows here,
// raw: the INSERT is that of the dropped store function, column by column and with the same defaults. A harness, not a test:
// no line in the guard register.
//
// `db` is a writing connection onto the store (in the tests mostly the live binding from store/db.js). Secrets (token) go only
// into the row, never into a return value.
import fs from "node:fs";

export const OLD_SCHEMA = new URL("./fixtures/managing-old-schema.sql", import.meta.url);

/** Create the manager tables with indexes, FTS and triggers (IF NOT EXISTS: a second call changes nothing). */
export function seedOldSchema(db) {
  db.exec(fs.readFileSync(OLD_SCHEMA, "utf8"));
}

/** An external MCP server of the manager (like `createManagerMcpServer`). Returned without token. */
export function setUpManagerMcpServer(db, { id, workspaceId, key, name, url, token = "", createdAt = Date.now(), updatedAt = createdAt }) {
  db.prepare("INSERT INTO manager_mcp_servers (id, workspace_id, key, name, url, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, workspaceId, key, name, url, token, createdAt, updatedAt);
  return { id, workspaceId, key, name, url };
}
