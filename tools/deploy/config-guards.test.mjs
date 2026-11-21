// The configuration guards of the deploy tool (config.mjs): the installation values are overridable from the environment.
//
// PROMISES:
//   (1) remote.root, gatewayPort, containerPrefix, image and projectboxImage come from the environment (CBASE_REMOTE_ROOT,
//       CBASE_GATEWAY_PORT, CBASE_CONTAINER_PREFIX, CBASE_IMAGE, CBASE_PROJECTBOX_IMAGE) and from deploy.local.json — the environment wins.
//       COUNTER-PROOF: without the variables the defaults stand.
//   (2) assertOwnInstallation is async and, in a tree without the private part, refuses nothing. deploy.mjs calls it for every
//       rollout run (rollout-lock.test.mjs holds the order).
//
// Run:  node --test --test-reporter=tap tools/deploy/config-guards.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertOwnInstallation } from "./config.mjs";
import { privatePresent } from "./lib/private-part.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLEAN = { root: "/home/maintainer/cbase-server", gatewayPort: 7729, containerPrefix: "cbase-u-", image: "cbase-backend", projectboxImage: "cbase-projectbox" };

// config.mjs is evaluated at import, so the environment is tested in a child process.
function configWith(env) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { config } from ${JSON.stringify(path.join(HERE, "config.mjs"))}; console.log(JSON.stringify(config.remote));`], {
    encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("(1) the five installation values are overridable from the environment; the defaults stand without it", () => {
  const set = configWith({
    CBASE_REMOTE_ROOT: "/srv/x-server", CBASE_GATEWAY_PORT: "7745", CBASE_CONTAINER_PREFIX: "x-u-", CBASE_IMAGE: "x-backend", CBASE_PROJECTBOX_IMAGE: "x-projectbox",
  });
  assert.equal(set.root, "/srv/x-server");
  assert.strictEqual(set.gatewayPort, 7745, "the port is a number, not a string");
  assert.equal(set.containerPrefix, "x-u-");
  assert.equal(set.image, "x-backend");
  assert.equal(set.projectboxImage, "x-projectbox");
  const none = configWith({});
  assert.equal(none.containerPrefix, "cbase-u-");
  assert.equal(none.image, "cbase-backend");
  assert.equal(none.projectboxImage, "cbase-projectbox");
});

test("(2) assertOwnInstallation is async; clean values pass, and without the private part nothing is refused", async () => {
  const r = assertOwnInstallation(CLEAN);
  assert.ok(r instanceof Promise, "the guard must be awaited (it loads the private part dynamically)");
  await r;
  if (!privatePresent("lib/old-installation.mjs")) await assertOwnInstallation({ ...CLEAN, gatewayPort: 7719 });
});
