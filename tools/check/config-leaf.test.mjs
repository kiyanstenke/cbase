// The gate does not depend on the installation configuration (tools/deploy/config.mjs: deploy.local.json, the environment).
//
// COUNTER-TEST: re-pointing check.mjs or gate-marker.mjs at a config module other than the leaf turns the first test red; a
// config-repo.mjs that imports anything but node built-ins turns the second red; a gate closure that grows turns the third red.
// (That the installation's config.mjs re-exports the same root is held in tools/deploy/config-root.test.mjs.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO } from "./config-repo.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, p), "utf8");

test("the gate modules import the repository root from the leaf, not from config.mjs", () => {
  for (const f of ["targets/check.mjs", "lib/gate-marker.mjs", "lib/gate-plans.mjs"]) {
    const src = read(f);
    // gate-plans.mjs takes the repository root through its context (no REPO of its own): it only must not reach config.mjs.
    if (f !== "lib/gate-plans.mjs") assert.ok(/from "\.\.\/config-repo\.mjs"/.test(src), `${f} must import config-repo.mjs`);
    assert.ok(!/from "[^"]*\/config\.mjs"/.test(src), `${f} must not import a config.mjs`);
  }
});

test("config-repo.mjs is a leaf: node built-ins only", () => {
  const imports = [...read("config-repo.mjs").matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(imports.filter((i) => !i.startsWith("node:")), []);
  assert.equal(path.basename(REPO), path.basename(path.resolve(HERE, "..", "..")));
});

test("the gate's import closure is closed: only these files, none with installation configuration or ssh", () => {
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return; seen.add(f);
    for (const m of fs.readFileSync(f, "utf8").matchAll(/(?:from|import\()\s*"(\.[^"]+)"/g)) {
      const p = path.resolve(path.dirname(f), m[1]);
      if (p.endsWith(".mjs") && fs.existsSync(p)) walk(p);
    }
  };
  walk(path.join(HERE, "targets/check.mjs"));
  const files = [...seen].map((p) => path.relative(HERE, p)).sort();
  // cleanliness.mjs (publicFiles) and secrets.mjs (gitleaks): the secret scan runs in every gate mode; neither
  // reads installation configuration or talks ssh.
  assert.deepEqual(files, ["cleanliness.mjs", "config-repo.mjs", "lib/asar.mjs", "lib/gate-lock.mjs", "lib/gate-marker.mjs", "lib/gate-plan.mjs", "lib/gate-plans.mjs", "lib/git.mjs",
    "lib/guard-register.mjs", "lib/loc-gate.mjs", "lib/log.mjs", "lib/manifest-diff.mjs", "lib/sh.mjs", "lib/test-output.mjs",
    "lib/tree-rules.mjs", "secrets.mjs", "targets/check.mjs"],
    "the gate reaches a file outside the closed set — a new import widens what the public gate depends on");
});
