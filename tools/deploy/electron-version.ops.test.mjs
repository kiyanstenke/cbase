// Private half of the Electron version guard: what targets/client.mjs and targets/status.mjs decide with it.
//
// Run:  node --test --test-reporter=tap tools/deploy/electron-version.ops.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, reads } from "../check/lib/electron-version-fixture.mjs";
import { ELECTRON_PLIST, electronInBundle } from "../check/lib/electron-version.mjs";
import { clientBundleDeviations } from "./targets/client.mjs";
import { config } from "./config.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("the framework plist path reads the installed client app, when there is one", () => {
  if (process.platform !== "darwin" || !fs.existsSync(config.local.clientApp)) {
    console.log(`  [installed client app] none on this machine (${config.local.clientApp})`);
    return;
  }
  const v = electronInBundle(config.local.clientApp);
  console.log(`  [installed client app] ${v.version || v.reason}`);
  assert.match(v.version || "", /^\d+\.\d+\.\d+/, v.reason);
  assert.ok(fs.existsSync(path.join(config.local.clientApp, ELECTRON_PLIST)));
});

test("client.mjs: a deviating or UNKNOWN Electron version forces the rebuild", () => {
  // The decision itself, not only its building block: `clientBundleDeviations` is what deploy.mjs (`clientShellChanged`)
  // and deployClient ask. The shell entries are irrelevant here — the throwaway bundle has no app.asar —, the Electron
  // entry is what counts.
  const b = build();
  try {
    const electron = (read) => clientBundleDeviations(b.app, { read, target: b.target }).filter((x) => x.startsWith("Electron"));
    assert.deepEqual(electron(reads("44.4.4")), [], "same version — and still a reason to rebuild");
    assert.deepEqual(electron(reads("37.10.3")), ["Electron 37.10.3 → 44.4.4"], "the pure version jump triggers no rebuild");
    const unknown = electron(reads(null));
    assert.equal(unknown.length, 1, "an UNREADABLE version triggers no rebuild — an old framework would stay");
    assert.match(unknown[0], /unknown/);
    assert.deepEqual(clientBundleDeviations(path.join(b.dir, "exists-not.app"), { read: reads("44.4.4"), target: b.target }), ["bundle missing"]);
  } finally {
    b.cleanUp();
  }
});

test("the Electron line is JUDGED, not only printed — in client and status", () => {
  // A line that appears in the log but enters no decision is decoration: the deploy would run through with
  // "DEVIATES" in the table and report success.
  const read = (rel) => fs.readFileSync(path.join(REPO, "tools/deploy/targets", rel), "utf8");
  const client = read("client.mjs");
  const status = read("status.mjs");
  for (const [name, src] of [["client.mjs", client], ["status.mjs", status]]) {
    assert.match(src, /"Electron in bundle == node_modules"/, `${name} does not print the Electron line`);
  }
  assert.match(client, /if \(!up \|\| nowSha !== srcSha \|\| rest\.length \|\| !el\.equal\) throw/, "client.mjs: the final check does not judge the Electron line");
  assert.match(client, /if \(!built\.equal\) throw/, "client.mjs: a built bundle with the wrong Electron would be installed");
});
