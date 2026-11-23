// The gateway's version report (build-info.js; VERSIONING.md).
//   (1) the copy of the API level equals the backend's api-level.js (two places, one truth — the gateway cannot import the backend)
//   (2) the build stamp: read, cached by mtime, re-read on change, null when missing or malformed
//   (3) /gw/info of the REAL gateway (gateway-harness.mjs) with a build.json: version, build, commit, release, api, gatewayVersion
//   (4) /gw/info WITHOUT build.json: the gateway's version and build "unknown" — never a clean-looking build
// COUNTER-PROOFS: API_LEVEL.oldest 2 in build-info.js ⇒ (1) red; infoVersionFields falling back to `build: gatewayVersion` ⇒ (4) red.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { API_LEVEL as BACKEND_API_LEVEL } from "../backend/electron/server/api-level.js";
import { API_LEVEL, buildStampReader, infoVersionFields } from "./build-info.js";
import { prepareSetup } from "./gateway-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")).version;
const STAMP = { version: "0.2.0", build: "0.2.0+3.gabc1234", commit: "b".repeat(40), dirty: false, release: "20261123-1", builtAt: "2026-11-23T10:00:00.000Z" };

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gw-build-"));

test("(1) the gateway's API level is the backend's", () => {
  assert.deepEqual({ ...API_LEVEL }, { ...BACKEND_API_LEVEL });
  assert.ok(Object.isFrozen(API_LEVEL));
});

test("(2) the build stamp: read, cached, re-read on change, null when missing or malformed", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "build.json");
    const read = buildStampReader(file);
    assert.equal(read(), null, "missing file");
    fs.writeFileSync(file, JSON.stringify(STAMP));
    assert.deepEqual(read(), STAMP);
    assert.equal(read(), read(), "the same object while the file is unchanged (cache)");
    fs.writeFileSync(file, JSON.stringify({ ...STAMP, build: "0.2.0+4.gdef5678.dirty" }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(read().build, "0.2.0+4.gdef5678.dirty", "a changed file is read anew");
    for (const [i, bad] of ["{broken", JSON.stringify({ version: "0.2.0" }), JSON.stringify({ version: "x", build: "y" })].entries()) {
      fs.writeFileSync(file, bad);
      fs.utimesSync(file, new Date(), new Date(Date.now() + (i + 2) * 10_000));
      assert.equal(read(), null, bad);
    }
    fs.rmSync(file);
    assert.equal(read(), null, "removed again");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("(3) /gw/info of the real gateway with build.json", async () => {
  const dir = tmp();
  const file = path.join(dir, "build.json");
  fs.writeFileSync(file, JSON.stringify(STAMP));
  const gw = await prepareSetup({ env: { GW_BUILD_FILE: file } });
  try {
    await gw.start();
    const info = await fetch(`${gw.base}/gw/info`).then((r) => r.json());
    assert.equal(info.gateway, true);
    assert.equal(info.version, STAMP.version);
    assert.equal(info.build, STAMP.build);
    assert.equal(info.commit, STAMP.commit);
    assert.equal(info.release, STAMP.release);
    assert.deepEqual(info.api, { level: BACKEND_API_LEVEL.level, oldest: BACKEND_API_LEVEL.oldest });
    assert.equal(info.gatewayVersion, GATEWAY_VERSION);
    assert.equal(info.setup, true, "the old fields stay");
  } finally {
    await gw.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(4) /gw/info without build.json: the gateway's version, build \"unknown\" — never a clean-looking build", async () => {
  const dir = tmp();
  const gw = await prepareSetup({ env: { GW_BUILD_FILE: path.join(dir, "missing", "build.json") } });
  try {
    await gw.start();
    const info = await fetch(`${gw.base}/gw/info`).then((r) => r.json());
    assert.equal(info.version, GATEWAY_VERSION);
    assert.equal(info.build, "unknown");
    assert.notEqual(info.build, info.version);
    assert.equal(info.commit, null);
    assert.equal(info.release, null);
    assert.equal(info.gatewayVersion, GATEWAY_VERSION);
    assert.deepEqual(info.api, { level: API_LEVEL.level, oldest: API_LEVEL.oldest });
  } finally {
    await gw.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(infoVersionFields(null, "7.7.7"), { version: "7.7.7", build: "unknown", commit: null, release: null, api: { ...API_LEVEL }, gatewayVersion: "7.7.7" });
});
