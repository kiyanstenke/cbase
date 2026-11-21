// Guard over the runtime dependencies. A runtime dependency of the backend lives in three places: manifest, lockfile and the
// install instruction of the Dockerfile (`npm ci --omit=dev` from the lockfile, then `rm -rf` of the dead wrapper). The first
// test runs the computation against the real tree; the others are its built-in sabotages, each on a deep copy of the real
// state (no test writes a file). Reads only JSON and the Dockerfile, never `node_modules`: runs on every machine, Linux too
// (no `onlyMacOS` exception).
//
// Run:  node --test --test-reporter=tap tools/check/runtime-dependencies.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NEVER_LOADED, dockerfileInstall, fulfilled, readLocations, checkRuntimeDependencies } from "./lib/runtime-dependencies.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const real = () => structuredClone(readLocations(REPO));
const red = (r, ...pattern) => {
  assert.equal(r.ok, false, "the sabotage must be red");
  for (const m of pattern) assert.ok(r.findings.some((b) => m.test(b)), `no finding matches ${m}:\n  ${r.findings.join("\n  ")}`);
};
// Rewrite the rm list of the Dockerfile (the instruction spreads it over two lines).
const replaceInDockerfile = (o, old, fresh) => {
  assert.ok(o.dockerfile.includes(old), `precondition: "${old}" is in the Dockerfile`);
  o.dockerfile = o.dockerfile.replace(old, fresh);
};

test("current state: manifest and lockfile agree, wrapper complete, the Dockerfile deletes exactly the dead wrapper", () => {
  const r = checkRuntimeDependencies(readLocations(REPO));
  console.log(`  [state] ${r.counts.runtime} runtime dependencies, wrapper ${r.counts.wrapper} packages, ${r.counts.exceptions} named exception(s), dead wrapper ${r.counts.tot} packages, ${r.counts.deleted} deleted paths`);
  assert.equal(r.findings.length, 0, `findings:\n  ${r.findings.join("\n  ")}`);
  assert.ok(r.counts.runtime > 0 && r.counts.wrapper > r.counts.runtime, "the wrapper is not empty — otherwise the guard checks nothing");
  assert.ok(r.counts.tot > 0 && r.counts.deleted > 0, "dead wrapper and rm list are not empty — otherwise the Dockerfile side checks nothing");
});

test("sabotage: a new dependency only in the manifest turns red (lockfile not updated)", () => {
  const o = real();
  o.manifest.dependencies["left-pad"] = "^1.3.0";
  red(checkRuntimeDependencies(o), /^left-pad: listed in server\/backend\/package\.json, missing from server\/backend\/package-lock\.json \(npm install in server\/backend\/\)$/);
});

test("sabotage: the lockfile lists a dependency the manifest no longer carries turns red", () => {
  const o = real();
  delete o.manifest.dependencies.ws;
  red(checkRuntimeDependencies(o), /^ws: server\/backend\/package-lock\.json is outdated — still lists it, server\/backend\/package\.json no longer does/);
});

test("sabotage: outdated lockfile (version out of range, root with old range, package gone) turns red", () => {
  const o = real();
  o.lock.packages["node_modules/ws"].version = "7.5.10";
  o.lock.packages[""].dependencies["node-pty"] = "^1.0.0";
  delete o.lock.packages["node_modules/tar"];
  red(
    checkRuntimeDependencies(o),
    /^ws: server\/backend\/package-lock\.json has 7\.5\.10, outside of "\^8\.21\.1"/,
    /^node-pty: server\/backend\/package-lock\.json is outdated — root has "\^1\.0\.0"/,
    /^tar: needed by node_modules\/onnxruntime-node, missing from server\/backend\/package-lock\.json/,
  );
});

test("sabotage: a wrapper package marked dev in the lockfile turns red", () => {
  const o = real();
  o.lock.packages["node_modules/tar/node_modules/yallist"].dev = true;
  red(checkRuntimeDependencies(o), /^tar\/node_modules\/yallist: runtime package, but marked dev in server\/backend\/package-lock\.json/);
});

// npm writes optional platform packages for EVERY platform into the lockfile; if the Linux binary of sharp is missing there
// (happened with a lockfile generated on a Mac), `npm ci` installs none in the image and sharp dies only on load.
test("sabotage: an optional platform package missing in the lockfile turns red, also one for a foreign platform", () => {
  const o = real();
  assert.ok(o.lock.packages["node_modules/@img/sharp-linux-x64"], "precondition: the Linux binary of sharp is in the lockfile");
  delete o.lock.packages["node_modules/@img/sharp-linux-x64"];
  red(checkRuntimeDependencies(o), /^@img\/sharp-linux-x64: optional needed by node_modules\/sharp, missing/);
  const p = real();
  delete p.lock.packages["node_modules/@img/sharp-darwin-arm64"];
  red(checkRuntimeDependencies(p), /^@img\/sharp-darwin-arm64: optional needed by node_modules\/sharp, missing/);
});

test("sabotage: an exception without an edge in the lockfile turns red; without the exception the Dockerfile deletes live packages", () => {
  const o = real();
  const edge = o.lock.packages["node_modules/@huggingface/transformers"].dependencies;
  assert.ok("onnxruntime-web" in edge, "precondition: the edge of the exception is in the lockfile");
  delete edge["onnxruntime-web"];
  red(checkRuntimeDependencies(o), /^onnxruntime-web: exception NEVER_LOADED \(from @huggingface\/transformers\) without an edge/);
  // The other direction: the same edge without the exception revives the dead wrapper — the rm list would hit it.
  red(
    checkRuntimeDependencies(real(), { exceptions: [] }),
    /^onnxruntime-web: runtime package \(node_modules\/onnxruntime-web\), but server\/backend\/Dockerfile deletes "node_modules\/onnxruntime-web"/,
    /^flatbuffers: runtime package \(node_modules\/flatbuffers\), but .* deletes/,
  );
  assert.equal(NEVER_LOADED.length, 1, "every new exception needs a reason and a look here");
});

test("sabotage: the rm list hits a live package turns red; a nested one lives on under its PATH", () => {
  const o = real();
  replaceInDockerfile(o, "node_modules/long ", "node_modules/long node_modules/ws ");
  red(checkRuntimeDependencies(o), /^ws: runtime package \(node_modules\/ws\), but server\/backend\/Dockerfile deletes "node_modules\/ws"/);
  // `npm ci` lays out the tree like the lockfile: the runtime yallist sits under tar, none at the top. `rm -rf node_modules/yallist`
  // deletes nothing live (the path counts, not the name) but is no part of the dead wrapper either — red as outdated.
  const p = real();
  assert.ok(p.lock.packages["node_modules/tar/node_modules/yallist"] && !p.lock.packages["node_modules/yallist"], "precondition: yallist sits only under tar");
  replaceInDockerfile(p, "node_modules/long ", "node_modules/long node_modules/yallist ");
  const r = checkRuntimeDependencies(p);
  red(r, /^node_modules\/yallist: server\/backend\/Dockerfile deletes it, but it is not part of the dead wrapper/);
  assert.ok(!r.findings.some((b) => /^yallist: runtime package/.test(b)), r.findings.join("\n"));
});

test("sabotage: a dead-wrapper package missing from the rm list turns red, per package, also each of a scope", () => {
  const o = real();
  replaceInDockerfile(o, "node_modules/long ", "");
  red(checkRuntimeDependencies(o), /^long: dead wrapper \(node_modules\/long, reachable only via NEVER_LOADED\) ships in the image/);
  const p = real();
  replaceInDockerfile(p, "node_modules/@protobufjs ", "");
  const r = checkRuntimeDependencies(p);
  assert.equal(r.findings.filter((b) => /^@protobufjs\/[a-z0-9]+: dead wrapper/.test(b)).length, 9, "each of the nine @protobufjs packages individually");
  // The nested onnxruntime-common under onnxruntime-web goes with it — without the folder it shows up on its own.
  const q = real();
  replaceInDockerfile(q, "rm -rf node_modules/onnxruntime-web ", "rm -rf ");
  red(checkRuntimeDependencies(q), /^onnxruntime-web: dead wrapper/, /^onnxruntime-common: dead wrapper \(node_modules\/onnxruntime-web\/node_modules\/onnxruntime-common,/);
});

test("sabotage: the install instruction without lockfile (`npm install`, no COPY) or duplicated turns red", () => {
  const o = real();
  replaceInDockerfile(o, "npm ci --omit=dev", "npm install --omit=dev");
  red(checkRuntimeDependencies(o), /the install instruction is not `npm ci --omit=dev`/);
  const p = real();
  replaceInDockerfile(p, "COPY package.json package-lock.json ./", "COPY package.json ./");
  red(checkRuntimeDependencies(p), /no COPY takes package-lock\.json along/);
  const q = real();
  replaceInDockerfile(q, "COPY electron ./electron", "RUN npm install left-pad\nCOPY electron ./electron");
  red(checkRuntimeDependencies(q), /2 instructions install the runtime dependencies of the backend/);
  // Global installs (provider CLIs, go-task) do not count.
  assert.equal(dockerfileInstall(real().dockerfile).instructions.length, 1);
});

test("sabotage: the install instruction without ONNXRUNTIME_NODE_INSTALL_CUDA=skip turns red; without onnxruntime-node it is not asked", () => {
  const o = real();
  replaceInDockerfile(o, "ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci", "npm ci");
  red(checkRuntimeDependencies(o), /^onnxruntime-node: the install instruction of server\/backend\/Dockerfile does not set ONNXRUNTIME_NODE_INSTALL_CUDA=skip/);
  // The rule hangs on the package: a lockfile without onnxruntime-node does not ask for the switch.
  const p = real();
  replaceInDockerfile(p, "ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci", "npm ci");
  for (const k of Object.keys(p.lock.packages)) if (k.endsWith("node_modules/onnxruntime-node")) p.lock.packages[k.replace(/onnxruntime-node$/, "onnxruntime-gone")] = p.lock.packages[k], delete p.lock.packages[k];
  assert.ok(!checkRuntimeDependencies(p).findings.some((b) => /ONNXRUNTIME_NODE_INSTALL_CUDA/.test(b)));
});

test("version ranges: ^, ~, exact, prerelease — and what the guard cannot read is not green", () => {
  assert.equal(fulfilled("8.21.1", "^8.21.1"), true);
  assert.equal(fulfilled("8.30.0", "^8.21.1"), true);
  assert.equal(fulfilled("9.0.0", "^8.21.1"), false);
  assert.equal(fulfilled("8.21.0", "^8.21.1"), false);
  assert.equal(fulfilled("0.5.9", "^0.5.3"), true);
  assert.equal(fulfilled("0.6.0", "^0.5.3"), false);
  assert.equal(fulfilled("1.2.9", "~1.2.3"), true);
  assert.equal(fulfilled("1.3.0", "~1.2.3"), false);
  assert.equal(fulfilled("1.21.0", "1.21.0"), true);
  assert.equal(fulfilled("1.22.0-dev.1", "^1.21.0"), false);
  assert.equal(fulfilled("1.22.0-dev.1", "1.22.0-dev.1"), true);
  assert.equal(fulfilled("1.2.3", ">=1.0.0 <2"), null);
  assert.equal(fulfilled("1.2.3", "github:foo/bar"), null);
});

// CI installs the backend too (.github/workflows/check.yml): the same CUDA download breaks `npm ci` there (CI red at "Install
// dependencies" on 20.11.2026). Every `npm ci` of server/backend in a workflow carries the switch.
function ciBackendInstallsWithoutSkip(text) {
  const lines = text.split("\n").filter((z) => /server\/backend/.test(z) && /\bnpm ci\b/.test(z));
  if (!lines.length) throw new Error("no `npm ci` of server/backend found in the workflow — update this guard");
  return lines.filter((z) => !/ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci/.test(z));
}
test("CI: every npm ci of server/backend sets ONNXRUNTIME_NODE_INSTALL_CUDA=skip (with counter-proof)", () => {
  const wf = fs.readFileSync(path.join(REPO, ".github", "workflows", "check.yml"), "utf8");
  assert.deepEqual(ciBackendInstallsWithoutSkip(wf), []);
  assert.equal(ciBackendInstallsWithoutSkip(wf.replace("ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci", "npm ci")).length, 1, "sabotage: the install without the switch stays green");
});

// The backend suite's real-browser tests (browsers.js resolveChromium) and the MP4 capture (captures.js) need what the image
// ships: a Chromium that starts and ffmpeg. On the runner a missing one is a skip (red in the gate, no onlyMacOS exception) and the
// runner's own /usr/bin/chromium dies at its sandbox (Ubuntu 24.04, AppArmor; CI red on 21.11.2026 with "Chromium ended (code 1)").
// The workflow installs ffmpeg and hands the suites Google Chrome through CBASE_CHROMIUM, BEFORE the gate step.
function ciBrowserFindings(text) {
  const steps = text.split(/\n(?=\s+- (?:name|uses):)/);
  const gate = steps.findIndex((s) => /^\s+run: \.\/check\s*$/m.test(s));
  if (gate < 0) throw new Error("no `run: ./check` step found in the workflow — update this guard");
  const before = steps.slice(0, gate).join("\n");
  const findings = [];
  if (!/apt-get install[^\n]*\bffmpeg\b/.test(before)) findings.push("ffmpeg is not installed before the gate step");
  if (!/echo "CBASE_CHROMIUM=\$chrome" >> "\$GITHUB_ENV"/.test(before)) findings.push("CBASE_CHROMIUM is not handed to the gate step");
  if (!/chrome="\$\(command -v google-chrome\)"/.test(before)) findings.push("CBASE_CHROMIUM does not point at Google Chrome");
  return findings;
}
test("CI: the gate step gets ffmpeg and a Chromium with a working sandbox (Google Chrome via CBASE_CHROMIUM) — with counter-proofs", () => {
  const wf = fs.readFileSync(path.join(REPO, ".github", "workflows", "check.yml"), "utf8");
  assert.deepEqual(ciBrowserFindings(wf), []);
  assert.deepEqual(ciBrowserFindings(wf.replace(/--no-install-recommends ffmpeg/, "--no-install-recommends")), ["ffmpeg is not installed before the gate step"], "sabotage: without ffmpeg");
  assert.deepEqual(ciBrowserFindings(wf.replace(/^.*CBASE_CHROMIUM=\$chrome.*\n/m, "")), ["CBASE_CHROMIUM is not handed to the gate step"], "sabotage: without CBASE_CHROMIUM");
  assert.deepEqual(ciBrowserFindings(wf.replace("command -v google-chrome", "command -v chromium")), ["CBASE_CHROMIUM does not point at Google Chrome"], "sabotage: the runner's sandboxless Chromium");
});
