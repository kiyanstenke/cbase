// The episode axis of the rollback lock (the deploy tool's capabilities.mjs episodesLock): how many source identifiers (system,
// external_id) carry episodes in more than one workspace? A store that never had the `episodes` table (every fresh one) answers 0,
// not "unknown". The same condition as the deploy's episode script (guards server/backend/test/episodes-count.test.js and, against
// the script, the private capabilities guard (15)). Over its own read-only connection — it writes nothing.
//
// A leaf: only `node:*` and app-state.js. Reader: runs/routes.js (field `episodesMultiple` of /api/runs/active).

import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DIRS } from "../app-state.js";

/** The count — 0 without the table. Throws only if the database cannot be opened (the route then reports `null`). */
export function episodesMultiple({ data = DIRS?.data } = {}) {
  const q = new DatabaseSync(path.join(String(data || ""), "automater.db"), { readOnly: true });
  try {
    q.exec("PRAGMA busy_timeout = 5000");
    if (!q.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'episodes'").get()) return 0;
    return Number(q.prepare("SELECT COUNT(*) AS n FROM (SELECT 1 FROM episodes GROUP BY system, external_id HAVING COUNT(*) > 1)").get()?.n || 0);
  } finally {
    q.close();
  }
}
