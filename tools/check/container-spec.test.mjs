// The stale container variable is read and set nowhere in the repo. tools/deploy/lib/remote.mjs drops `CBASE_SSH` from every
// reconstructed user container (STALE_IMAGE_ENV, bound by the maintainer's private suite); that is only harmless while no code reads or
// sets the name — otherwise dropping it would tear something off. remote.mjs itself is excluded: it names the variable only to drop it.
// COUNTER-PROOF: the grep is the measurement; a file that reads the name (outside the excluded places) turns it red.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STALE = ["CBASE_SSH"];

test("no stale container variable (CBASE_SSH) is read or set in the repo", () => {
  for (const name of STALE) {
    const r = spawnSync("git", ["-C", REPO, "grep", "-nwI", name, "--", ".", ":(exclude)docs", ":(exclude)*.md", ":(exclude)ops", ":(exclude)tools/check/container-spec.test.mjs", ":(exclude)tools/deploy/lib/remote.mjs"], { encoding: "utf8" });
    assert.equal(r.status, 1, `${name} is read or set in the repo — then it is not stale:\n${r.stdout}${r.stderr}`);
  }
});
