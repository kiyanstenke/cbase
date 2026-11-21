// The Chromium sandbox stays on, except in the user container.
//
// `server/backend/electron/server/browsers.js` does pass `--no-sandbox` — but ONLY under
// `inContainer()` (`CBASE_CONTAINER === "1"`), because Chrome runs as root in the user container
// under sysbox and does not start there without the flag. Everywhere else, above all in the
// local server on a Mac, Chrome runs WITH the sandbox.
//
// The easy way to get a browser start green on a foreign machine would be to drop the condition:
// a security switch-off in SHIPPED code. This guard pins exactly that — not the absence of the
// flag but its binding.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("\"--no-sandbox\" appears only under inContainer(), and inContainer() is an explicit variable", () => {
  const browsers = fs.readFileSync(path.join(REPO, "server/backend/electron/server/browsers.js"), "utf8");
  for (const row of browsers.split("\n").filter((z) => z.includes("--no-sandbox"))) {
    assert.match(
      row,
      /inContainer\(\)/,
      `"--no-sandbox" appears without an inContainer() condition: ${row.trim()}`,
    );
  }
  assert.match(
    browsers,
    /const inContainer = \(\) => process\.env\.CBASE_CONTAINER === "1"/,
    "inContainer() is no longer an explicit variable — a heuristic could happen to be true on a foreign machine",
  );
});
