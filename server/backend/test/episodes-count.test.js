// Two counts of /api/runs/active that the deploy tool reads (moved here from the removed teardown guards):
//
//   (1) The episodes axis of the rollback lock: runs/episodes-count.js episodesMultiple counts source identifiers (system,
//       external_id) that carry an episode in more than one workspace; without the `episodes` table (every fresh store) it is 0,
//       never `null`. The route reports the same number in `episodesMultiple`.
//   (2) `approvals` WITHOUT a filter: a card that is no manager approval (an airlock card) is listed with its chat title.
//
// COUNTER-TESTS: `HAVING COUNT(*) > 1` dropped in runs/episodes-count.js ⇒ (1) red (2 instead of 1); the `sqlite_master` check
// dropped ⇒ (1) red at the end (no such table); a filter on manager approvals in the `approvals` loop of runs/routes.js ⇒ (2) red.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import { db as rawDb } from "../electron/server/store/db.js";
import { DIRS } from "../electron/server/app-state.js";
import { episodesMultiple } from "../electron/server/runs/episodes-count.js";
import { pendingPermissions } from "../electron/server/runs/approvals.js";
import { json, withAgentsServer } from "./agent-harness.mjs";

const SEED = new URL("./fixtures/managing-old-schema.sql", import.meta.url);

test("(1) the episodes axis counts duplicate identifiers across workspaces, 0 without a table — the route reports the same", async () => {
  await withAgentsServer(async (ctx) => {
    const data = DIRS.data;
    assert.deepEqual([episodesMultiple({ data }), (await json(`${ctx.base}/api/runs/active`)).episodesMultiple], [0, 0], "a fresh store has no episodes table");
    rawDb.exec(fs.readFileSync(SEED, "utf8"));
    const columns = rawDb.prepare("PRAGMA table_info(episodes)").all().map((c) => c.name);
    assert.ok(columns.includes("system") && columns.includes("external_id"), "precondition: the old schema carries system and external_id");
    // Two identifiers in two workspaces: one twice, one once. Columns without a default get an empty value.
    const required = rawDb.prepare("PRAGMA table_info(episodes)").all().filter((c) => c.notnull && c.dflt_value === null).map((c) => c.name);
    const second = `ws-${randomUUID()}`;
    const create = (ws, ext) => {
      const w = { id: randomUUID(), workspace_id: ws, system: "teams", external_id: ext };
      for (const c of required) if (!(c in w)) w[c] = c.endsWith("_at") ? Date.now() : "";
      const k = Object.keys(w);
      rawDb.prepare(`INSERT INTO episodes (${k.join(", ")}) VALUES (${k.map(() => "?").join(", ")})`).run(...Object.values(w));
    };
    try { rawDb.exec("DROP INDEX IF EXISTS ux_episodes_ext"); } catch { /* not there */ }
    create(ctx.ws.id, "k-1");
    create(second, "k-1");
    create(ctx.ws.id, "k-2");
    assert.equal(episodesMultiple({ data }), 1, "k-1 is in two workspaces, k-2 once");
    assert.equal((await json(`${ctx.base}/api/runs/active`)).episodesMultiple, 1);
    rawDb.exec("DROP TABLE IF EXISTS episodes_fts; DROP TABLE episodes");
    assert.deepEqual([episodesMultiple({ data }), (await json(`${ctx.base}/api/runs/active`)).episodesMultiple], [0, 0]);
  });
});

test("(2) approvals without a filter: an airlock card is listed with its chat title", async () => {
  await withAgentsServer(async (ctx) => {
    const rid = `test-${randomUUID()}`;
    pendingPermissions.set(rid, { chatId: ctx.chat.id, toolName: "mcp__teams__teams_send", airlock: true });
    try {
      const f = (await json(`${ctx.base}/api/runs/active`)).approvals;
      assert.deepEqual(f.map((x) => [x.chatId, x.toolName]), [[ctx.chat.id, "mcp__teams__teams_send"]]);
      assert.equal(typeof f[0].title, "string");
    } finally {
      pendingPermissions.delete(rid);
    }
  });
});
