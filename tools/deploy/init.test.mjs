// `./deploy init` — targets/init.mjs against a fake ssh (the script runs with bash on THIS machine in a temp root, HOME is a temp folder, a
// fake systemctl only logs). No real host, no network.
//
// PROMISES:
//   (1) A first run creates <root>/{releases,data,secrets,backups,gateway,web-out} (secrets mode 700) and writes the unit from the template with
//       the port, root and image of the configuration; it runs `daemon-reload` and NOTHING else with systemctl (no start, no enable).
//   (2) --dry-run shows the whole script and changes nothing (the only ssh call is the read-only look at the host).
//   (3) An existing root or an existing unit refuses without --force and touches nothing. COUNTER-PROOF: the same run with --force passes,
//       completes the folders, keeps the data already there and moves the old unit aside as .bak-<release>.
//   (4) A configuration that carries the old installation's identity (root, port 7719, prefix) is refused BEFORE any ssh call; values that do not
//       fit the script (relative root, port out of range, strange image name) are refused too.
//   (5) The template has no placeholder left after rendering and no active GW_SECURE; the script text never starts, enables or restarts a unit.
//
// Run:  node --test --test-reporter=tap tools/deploy/init.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { config } from "./config.mjs";
import { importPrivate } from "./lib/private-part.mjs";
import { setDryRun } from "../check/lib/sh.mjs";
import { UNIT_NAME, UNIT_TEMPLATE, ROOT_DIRS, assertInitValues, init, initScript, renderUnit } from "./targets/init.mjs";

// /tmp on purpose: the folder of the test must not carry the old name that the latch of config.mjs refuses (a temp folder under the scratch
// area of a session may).
const BASE = fs.realpathSync(fs.mkdtempSync("/tmp/cbase-init-"));
const BIN = path.join(BASE, "bin");
const CALLS = path.join(BASE, "calls");
const SYSTEMCTL_LOG = path.join(BASE, "systemctl.log");
const HOME = path.join(BASE, "home");
const UNIT = path.join(HOME, ".config/systemd/user", UNIT_NAME);
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
const write = (name, text) => fs.writeFileSync(path.join(BIN, name), text, { mode: 0o755 });
// The script of every ssh call is recorded, then executed with bash like `bash -s` on the host.
write("ssh", `#!/bin/bash\nwhile [ $# -gt 0 ] && [ "$1" != "bash" ]; do shift; done\nshift\nmkdir -p '${CALLS}'\nn=$(ls '${CALLS}' | wc -l | tr -d ' ')\ntee "${CALLS}/$n" | bash "$@"\n`);
write("systemctl", `#!/bin/bash\necho "$@" >> '${SYSTEMCTL_LOG}'\nexit 0\n`);

const saved = { path: process.env.PATH, home: process.env.HOME, host: config.ssh.host, remote: { ...config.remote } };
process.env.PATH = `${BIN}:/usr/bin:/bin`;
process.env.HOME = HOME;
config.ssh.host = "cbase-test.invalid";
test.after(() => {
  process.env.PATH = saved.path; process.env.HOME = saved.home; config.ssh.host = saved.host; Object.assign(config.remote, saved.remote);
  setDryRun(false);
  fs.rmSync(BASE, { recursive: true, force: true });
});

let n = 0;
// A fresh installation case: own root, clean logs, the clean configuration.
function fresh(patch = {}) {
  const root = path.join(BASE, `srv-${(n += 1)}`, "cbase-server");
  fs.rmSync(CALLS, { recursive: true, force: true });
  fs.rmSync(SYSTEMCTL_LOG, { force: true });
  fs.rmSync(path.join(HOME, ".config"), { recursive: true, force: true });
  setDryRun(false);
  // node: undefined — a remote.node in the checkout's own deploy.local.json must not leak into the default-path case.
  Object.assign(config.remote, { root, gatewayPort: 7729, image: "cbase-backend", containerPrefix: "cbase-u-", projectboxImage: "cbase-projectbox", node: undefined, ...patch });
  return root;
}
const calls = () => (fs.existsSync(CALLS) ? fs.readdirSync(CALLS).length : 0);
const systemctl = () => (fs.existsSync(SYSTEMCTL_LOG) ? fs.readFileSync(SYSTEMCTL_LOG, "utf8").trim().split("\n") : []);
const OLD = ["hex", "lens"].join("");

test("(1) first run: folders, secrets 700, the unit from the template, daemon-reload only", async () => {
  const root = fresh();
  await init({ release: "R1" });
  for (const d of ROOT_DIRS) assert.ok(fs.statSync(path.join(root, d)).isDirectory(), d);
  assert.deepEqual(ROOT_DIRS.slice(0, 4), ["releases", "data", "secrets", "backups"]);
  assert.equal(fs.statSync(path.join(root, "secrets")).mode & 0o777, 0o700);
  const unit = fs.readFileSync(UNIT, "utf8");
  assert.match(unit, /^Environment=GW_PORT=7729$/m);
  assert.match(unit, new RegExp(`^WorkingDirectory=${root}$`, "m"));
  assert.match(unit, new RegExp(`^ExecStart=/usr/bin/node ${root}/gateway/index.js$`, "m"), "default node path");
  assert.match(renderUnit(fs.readFileSync(UNIT_TEMPLATE, "utf8"), { root, port: 7729, image: "cbase-backend", node: "/opt/node/bin/node" }), /^ExecStart=\/opt\/node\/bin\/node /m, "remote.node fills @NODE@");
  assert.throws(() => assertInitValues({ root, port: 7729, image: "cbase-backend", node: "node" }), /remote\.node must be an absolute path/);
  assert.match(unit, /^Environment=GW_IMAGE=cbase-backend$/m);
  assert.doesNotMatch(unit, /@[A-Z]+@/);
  assert.equal(unit, renderUnit(fs.readFileSync(UNIT_TEMPLATE, "utf8"), { root, port: 7729, image: "cbase-backend" }));
  assert.equal(calls(), 2, "the look at the host, then the one script");
  assert.deepEqual(systemctl().map((l) => l.replace(/^--user /, "")), ["daemon-reload"]);
});

test("(2) dry run: the script is shown, nothing changes, only the read-only look reaches the host", async () => {
  const root = fresh();
  setDryRun(true);
  await init({ release: "R1" });
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.existsSync(UNIT), false);
  assert.equal(calls(), 1, "only the look at the host");
  assert.equal(systemctl().length, 0);
  // What the dry run would send is exactly the script of the real step.
  const script = initScript({ root, unitText: renderUnit(fs.readFileSync(UNIT_TEMPLATE, "utf8"), { root, port: 7729, image: "cbase-backend" }) });
  assert.match(script, new RegExp(`^mkdir -p ${root}/releases ${root}/data ${root}/secrets ${root}/backups ${root}/gateway ${root}/web-out$`, "m"));
  assert.match(script, /^chmod 700 .*\/secrets$/m);
  assert.match(script, /<<'CBASE_UNIT_EOF'/);
});

test("(3) an existing root or unit refuses without --force and touches nothing; --force completes and moves the unit aside", async () => {
  // Existing root.
  const root = fresh();
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "keep.db"), "precious");
  await assert.rejects(init({ release: "R2" }), /init refused: .*exists.*installation is there already/);
  assert.equal(fs.existsSync(path.join(root, "releases")), false, "nothing was created");
  assert.equal(fs.existsSync(UNIT), false);
  assert.equal(calls(), 1, "refused after the look, before the script");
  // Existing unit only.
  const root2 = fresh();
  fs.mkdirSync(path.dirname(UNIT), { recursive: true });
  fs.writeFileSync(UNIT, "OLD UNIT\n");
  await assert.rejects(init({ release: "R2" }), /the unit cbase-gateway\.service exists/);
  assert.equal(fs.readFileSync(UNIT, "utf8"), "OLD UNIT\n");
  assert.equal(fs.existsSync(root2), false);
  // Counter-proof: with --force the same states pass.
  const root3 = fresh();
  fs.mkdirSync(path.join(root3, "data"), { recursive: true });
  fs.writeFileSync(path.join(root3, "data", "keep.db"), "precious");
  fs.mkdirSync(path.dirname(UNIT), { recursive: true });
  fs.writeFileSync(UNIT, "OLD UNIT\n");
  await init({ force: true, release: "R3" });
  for (const d of ROOT_DIRS) assert.ok(fs.statSync(path.join(root3, d)).isDirectory(), d);
  assert.equal(fs.readFileSync(path.join(root3, "data", "keep.db"), "utf8"), "precious", "existing data is never touched");
  assert.equal(fs.readFileSync(`${UNIT}.bak-R3`, "utf8"), "OLD UNIT\n");
  assert.match(fs.readFileSync(UNIT, "utf8"), /GW_PORT=7729/);
});

test("(4) the old installation's identity and values that do not fit the script are refused before any ssh call", async (t) => {
  // The identity of the old installation lives in the private part (config.mjs assertOwnInstallation → lib/old-installation.mjs); a
  // public clone without it has nothing to refuse (first seen on the public repo's CI, 21.11.2026: the call went on to ssh).
  if (await importPrivate("lib/old-installation.mjs")) {
    for (const patch of [{ root: `/home/maintainer/${OLD}-server` }, { gatewayPort: 7719 }, { containerPrefix: `${OLD}-u-` }]) {
      fresh(patch);
      await assert.rejects(init({}), /Rollout refused.*old installation/, JSON.stringify(patch));
      assert.equal(calls(), 0, `${JSON.stringify(patch)}: no ssh call`);
    }
  } else t.diagnostic("no private part in this tree: the old-installation refusal is not this clone's to check");
  for (const [patch, pattern] of [[{ root: "relative/path" }, /absolute path/], [{ root: "/" }, /absolute path/], [{ root: "/srv/a b" }, /absolute path/], [{ root: "/srv/../x" }, /absolute path/],
    [{ gatewayPort: 80 }, /1024 to 65535/], [{ gatewayPort: 70000 }, /1024 to 65535/], [{ image: "Bad Image;rm" }, /plain image name/]]) {
    fresh(patch);
    await assert.rejects(init({}), pattern, JSON.stringify(patch));
    assert.equal(calls(), 0);
  }
  assertInitValues({ root: "/home/maintainer/cbase-server", port: 7729, image: "cbase-backend" });
});

test("(5) the template renders completely and the script never starts, enables or restarts a unit", () => {
  const template = fs.readFileSync(UNIT_TEMPLATE, "utf8");
  assert.match(template, /@ROOT@/);
  assert.throws(() => renderUnit(template.replace("@IMAGE@", "@UNKNOWN@"), { root: "/r", port: 7729, image: "i" }), /placeholder @UNKNOWN@/);
  assert.doesNotMatch(renderUnit(template, { root: "/r", port: 7729, image: "i" }), /^Environment=GW_SECURE/m, "GW_SECURE stays a comment until the tunnel stands");
  const script = initScript({ root: "/r", unitText: "x\n", moveAside: "R" });
  assert.doesNotMatch(script, /systemctl[^\n]*\b(start|enable|restart|stop)\b/);
  assert.match(script, /systemctl --user daemon-reload/);
  assert.match(script, /mv .*\.bak-R/);
  assert.doesNotMatch(initScript({ root: "/r", unitText: "x\n" }), /\bmv\b/);
});
