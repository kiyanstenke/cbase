// The build stamp of a rollout, the store gate of the iOS app and the build numbers (lib/build-stamp.mjs; VERSIONING.md).
//   (1) describe --json is parsed strictly; a failing describe gives build "<version>+unknown" (never a clean-looking build),
//       dirty false (a boolean, as describe without git) and a warning
//   (2) build.json carries exactly the fields of the contract, `dirty` always a boolean; a dirty checkout warns, a clean one does not
//   (4) the status text of a stamp file
//   (5) the store gate: TestFlight/IPA refused for a dirty tree, a missing tag, a tag that is not v<version>, an unknown state —
//       and there is no force; --device always passes
//   (6) the wiring: deployMobile asks the gate before anything else and without `force`; the scripts pass the build number to
//       xcodebuild and do not let App Store Connect renumber; the client build gets buildVersion; the server target places the
//       stamp next to the release and NOT into the image (no build context copy, no labels, no COPY in the Dockerfile — a stamp
//       in the image changes it on every deploy); web-out gets the stamp; status never asks /api/usage; .gitignore holds it
// COUNTER-PROOFS (each red once, see the hand-over): storeGateVerdict without the dirty check ⇒ (5) "dirty tree"; without the tag
// comparison ⇒ (5) "missing tag" and "tag != version"; describeBuild falling back to `build: version` or to `dirty: null` ⇒ (1); deployMobile
// without the storeGate call ⇒ (6) "deployMobile asks the gate"; manageAppVersionAndBuildNumber back to true ⇒ (6) "scripts"; the
// Dockerfile copying build.json again ⇒ (6) "server, web and status".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildNumber, buildStamp, describeBuild, dirtyWarning, parseDescribe, stampBuildText, storeGateVerdict,
} from "./lib/build-stamp.mjs";
import { storeGate } from "./targets/mobile.mjs";
import { distArgs } from "./targets/client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const SHA = "c".repeat(40);
const DESCRIBE = { version: "0.2.0", build: "0.2.0+3.gabc1234", commit: SHA, dirty: false };

// A fake `run(cmd, args)` for the version tool: answers per subcommand.
function fakeRun(answers) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const sub = args[0] === "git" ? args.join(" ") : (args[1] ?? "");
    const a = answers[sub] ?? answers[cmd === "git" ? `git ${args.join(" ")}` : sub];
    if (a instanceof Error) throw a;
    return { code: 0, stdout: "", stderr: "", ...(a || { code: 1, stderr: `unexpected ${sub}` }) };
  };
  return { run, calls };
}

// ── (1) describe ──

test("(1) parseDescribe takes the contract and nothing else", () => {
  assert.deepEqual(parseDescribe(JSON.stringify(DESCRIBE)), DESCRIBE);
  assert.deepEqual(parseDescribe(JSON.stringify({ version: "0.2.0", build: "0.2.0", commit: SHA, dirty: false })).build, "0.2.0");
  assert.equal(parseDescribe(JSON.stringify({ version: "0.2.0", build: "0.2.0+unknown", commit: null, dirty: true })).commit, null);
  for (const bad of [
    "", "{", JSON.stringify({ ...DESCRIBE, version: "latest" }), JSON.stringify({ ...DESCRIBE, build: "0.2.0; rm -rf /" }),
    JSON.stringify({ ...DESCRIBE, commit: "abc" }), JSON.stringify({ ...DESCRIBE, dirty: "no" }), JSON.stringify({ ...DESCRIBE, dirty: undefined }),
  ]) assert.throws(() => parseDescribe(bad), undefined, bad);
});

test("(1) describeBuild: the subprocess answer — and on failure build \"<version>+unknown\", dirty false, and a warning", async () => {
  const ok = fakeRun({ describe: { stdout: `${JSON.stringify(DESCRIBE)}\n` } });
  assert.deepEqual(await describeBuild({ run: ok.run }), { describe: DESCRIBE, warning: null });
  assert.deepEqual(ok.calls[0].slice(-2), ["describe", "--json"]);

  const failing = fakeRun({ describe: { code: 1, stderr: "usage: node tools/version.mjs …" }, "": { stdout: "0.2.0\n" } });
  const r = await describeBuild({ run: failing.run });
  assert.deepEqual(r.describe, { version: "0.2.0", build: "0.2.0+unknown", commit: null, dirty: false });
  assert.match(r.warning, /could not be computed.*usage.*0\.2\.0\+unknown/);
  assert.notEqual(r.describe.build, r.describe.version, "a build equal to the version reads as \"exactly on the tag, clean\"");

  const garbage = fakeRun({ describe: { stdout: "0.2.0" }, "": { code: 1 } });
  const g = await describeBuild({ run: garbage.run });
  assert.deepEqual(g.describe, { version: null, build: "unknown", commit: null, dirty: false });
  const thrown = fakeRun({ describe: new Error("spawn node ENOENT"), "": new Error("spawn node ENOENT") });
  assert.equal((await describeBuild({ run: thrown.run })).describe.build, "unknown");
  for (const x of [r, g]) assert.equal(typeof buildStamp(x.describe, { release: "r" }).dirty, "boolean", "dirty stays a boolean in build.json");
});

// ── (2) build.json ──

test("(2) build.json: exactly the contract fields, in order; a dirty checkout warns", () => {
  const stamp = buildStamp(DESCRIBE, { release: "20261123-1", builtAt: "2026-11-23T10:00:00.000Z" });
  assert.deepEqual(Object.keys(stamp), ["version", "build", "commit", "dirty", "release", "builtAt"]);
  assert.deepEqual(stamp, { ...DESCRIBE, release: "20261123-1", builtAt: "2026-11-23T10:00:00.000Z" });
  assert.match(buildStamp(DESCRIBE, { release: "r" }).builtAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(dirtyWarning(stamp), null);
  assert.match(dirtyWarning({ ...stamp, dirty: true, build: "0.2.0+3.gabc1234.dirty" }), /uncommitted changes.*0\.2\.0\+3\.gabc1234\.dirty.*warning only/);
  for (const dirty of [null, undefined, "yes"]) assert.equal(buildStamp({ ...DESCRIBE, dirty }, { release: "r" }).dirty, false, String(dirty));
  assert.equal(buildStamp({ ...DESCRIBE, dirty: true }, { release: "r" }).dirty, true);
});

// ── (4) status ──

test("(4) the status text of a stamp file", () => {
  assert.equal(stampBuildText(JSON.stringify({ build: "0.2.0", release: "r1" })), "0.2.0 (release r1)");
  assert.equal(stampBuildText(JSON.stringify({ build: "0.2.0+3.gabc1234" })), "0.2.0+3.gabc1234");
  for (const bad of ["", "{", "null", JSON.stringify({ release: "r1" })]) assert.equal(stampBuildText(bad), "—", bad);
});

// ── (5) store gate ──

const CLEAN = { dirty: false, version: "0.2.0", tags: ["v0.2.0"] };

test("(5) store gate: a clean tree exactly at v<version> passes; --device always", () => {
  for (const mode of ["testflight", "ipa"]) assert.equal(storeGateVerdict({ mode, ...CLEAN }), null, mode);
  for (const state of [CLEAN, { dirty: true, version: "0.2.0", tags: [] }, { dirty: null, version: null, tags: [] }]) {
    assert.equal(storeGateVerdict({ mode: "device", ...state }), null, JSON.stringify(state));
  }
});

test("(5) store gate: a dirty tree is refused", () => {
  for (const mode of ["testflight", "ipa"]) assert.match(String(storeGateVerdict({ mode, ...CLEAN, dirty: true })), /uncommitted changes/, mode);
  assert.match(String(storeGateVerdict({ mode: "ipa", ...CLEAN, dirty: null })), /clean is unknown/);
});

test("(5) store gate: a missing tag is refused", () => {
  assert.match(String(storeGateVerdict({ mode: "testflight", ...CLEAN, tags: [] })), /HEAD is not at the tag v0\.2\.0/);
  assert.match(String(storeGateVerdict({ mode: "testflight", ...CLEAN, tags: ["geparkt/x", "0.2.0"] })), /not at the tag v0\.2\.0/);
});

test("(5) store gate: a tag that is not v<version> is refused", () => {
  const r = String(storeGateVerdict({ mode: "testflight", ...CLEAN, tags: ["v0.1.9"] }));
  assert.match(r, /HEAD carries v0\.1\.9, not v0\.2\.0/);
  assert.match(String(storeGateVerdict({ mode: "ipa", ...CLEAN, version: "0.3.0" })), /v0\.2\.0, not v0\.3\.0/);
  assert.match(String(storeGateVerdict({ mode: "ipa", ...CLEAN, version: null })), /version is unreadable/);
});

test("(5) store gate: there is no force — the refusal says so, and a force argument changes nothing", () => {
  const dirty = { mode: "testflight", ...CLEAN, dirty: true };
  assert.equal(storeGateVerdict({ ...dirty, force: true }), storeGateVerdict(dirty));
  assert.match(String(storeGateVerdict(dirty)), /no --force/);
  assert.equal(storeGateVerdict.length, 1, "one argument object — no second switch");
});

test("(5) storeGate in the mobile target: injected git state, the verdict passed through", async () => {
  assert.deepEqual(await storeGate({ mode: "device", read: () => { throw new Error("device must not read git"); } }), { refused: null, state: null });
  assert.equal((await storeGate({ mode: "testflight", state: CLEAN })).refused, null);
  assert.match((await storeGate({ mode: "testflight", state: { ...CLEAN, dirty: true } })).refused, /uncommitted/);
  assert.match((await storeGate({ mode: "ipa", state: { ...CLEAN, tags: [] } })).refused, /not at the tag/);
  assert.match((await storeGate({ mode: "ipa", read: async () => ({ ...CLEAN, tags: ["v0.1.0"] }) })).refused, /not v0\.2\.0/);
});

test("(5) buildNumber: the integer of ios-build, a refusal is a warning without a number", async () => {
  assert.deepEqual(await buildNumber({ run: fakeRun({ "ios-build": { stdout: "1234\n" } }).run }), { number: 1234, warning: null });
  const shallow = await buildNumber({ run: fakeRun({ "ios-build": { code: 1, stderr: "version: shallow clone — the commit count is wrong" } }).run });
  assert.equal(shallow.number, null);
  assert.match(shallow.warning, /shallow clone/);
  assert.equal((await buildNumber({ run: fakeRun({ "ios-build": { stdout: "12" } }).run })).number, null, "below the base 100 is no build number");
});

// ── (6) wiring ──

function body(text, start, end) {
  const i = text.indexOf(start);
  if (i < 0) throw new Error(`anchor not found: ${start}`);
  const j = text.indexOf(end, i + start.length);
  if (j < 0) throw new Error(`end anchor not found: ${end}`);
  return text.slice(i, j);
}

test("(6) deployMobile asks the gate before the preflight and the build, without force", () => {
  const fn = body(read("tools/deploy/targets/mobile.mjs"), "export async function deployMobile(", "\n}\n");
  const gate = fn.indexOf("await storeGate({ mode })");
  assert.ok(gate > 0, "deployMobile does not call storeGate({ mode })");
  assert.ok(gate < fn.indexOf("await preflight("), "the gate comes after the preflight");
  assert.ok(gate < fn.indexOf("await act("), "the gate comes after the build");
  assert.match(fn, /if \(gate\.refused\) throw new Error\(gate\.refused\)/);
  assert.doesNotMatch(fn.slice(fn.indexOf("storeGate("), fn.indexOf(")", fn.indexOf("storeGate(")) + 1), /force/);
  assert.match(fn, /CBASE_BUILD_NUMBER=\$\{b\.number\}/);
});

test("(6) scripts: the build number goes to xcodebuild, App Store Connect does not renumber, the archive is named after it", () => {
  const tf = read("mobile/deploy-testflight.command");
  const archive = body(tf, "xcodebuild -quiet", "  archive\n");
  assert.match(archive, /CURRENT_PROJECT_VERSION="\$BUILD_NUMBER"/);
  assert.match(tf, /<key>manageAppVersionAndBuildNumber<\/key><false\/>/);
  assert.doesNotMatch(tf, /manageAppVersionAndBuildNumber<\/key><true/);
  assert.match(tf, /Archives\/cbase-\$VERSION-\$BUILD_NUMBER\.xcarchive/);
  for (const [name, text] of [["deploy-testflight", tf], ["make-ipa", read("mobile/make-ipa.command")]]) {
    assert.match(text, /BUILD_NUMBER="\$\{CBASE_BUILD_NUMBER:-\$\(node "\$REPO_DIR\/tools\/version\.mjs" ios-build\)\}"/, name);
    assert.match(text, /CURRENT_PROJECT_VERSION="\$BUILD_NUMBER"/, name);
  }
  // The device build carries the same number (VERSIONING.md section 10), not the project's fixed value.
  const device = read("mobile/refresh-on-iphone.command");
  assert.match(device, /BUILD_NUMBER="\$\{CBASE_BUILD_NUMBER:-\$\(node "\$REPO_DIR\/tools\/version\.mjs" ios-build/);
  assert.match(device, /BUILD_SETTING=\$\{BUILD_NUMBER:\+CURRENT_PROJECT_VERSION=\$BUILD_NUMBER\}/);
  assert.match(body(device, "xcodebuild -quiet", "  build\n"), /\$\{BUILD_SETTING\}/, "the device xcodebuild gets the number");
});

test("(6) the client build gets the build number as electron-builder buildVersion", () => {
  assert.deepEqual(distArgs(173), ["--prefix", "client", "run", "dist", "--", "-c.buildVersion=173"]);
  assert.deepEqual(distArgs(null), ["--prefix", "client", "run", "dist"]);
  const fn = body(read("tools/deploy/targets/client.mjs"), "export async function deployClient(", "\n}\n");
  assert.match(fn, /await act\("npm", distArgs\(b\.number\)/);
});

test("(6) server, web and status: the stamp lies next to the release and in web-out, never in the image — never /api/usage", () => {
  const server = read("tools/deploy/targets/server.mjs");
  const deploy = body(server, "export async function deployServer(", "\n}\n");
  assert.ok(deploy.indexOf("await placeStamp(stamp, rel, release)") > 0, "deployServer does not place the stamp");
  assert.match(deploy, /docker build -t \$\{cand\} -f /, "the candidate is built without extra arguments (no labels)");
  assert.doesNotMatch(deploy, /--label/);
  const place = body(server, "async function placeStamp(", "\n}\n");
  assert.match(place, /rsyncUp\(stamp\.file, `\$\{rel\}\/\$\{BUILD_JSON\}`\)/);
  assert.match(place, /rm -f \$\{rel\}\/\$\{BUILD_JSON\}`/, "without a stamp the predecessor's is removed");
  assert.doesNotMatch(place, /backend/, "the stamp must not reach the build context");
  const dockerfile = read("server/backend/Dockerfile");
  assert.match(dockerfile, /^COPY headless\.js \.\/$/m);
  assert.doesNotMatch(dockerfile, /build\.js/, "the image must not carry the build stamp");
  const web = body(read("tools/deploy/targets/web.mjs"), "export async function deployWebOut(", "\n}\n");
  assert.match(web, /rsyncUp\(stamp\.file, `\$\{remote\}\/\$\{BUILD_JSON\}`\)/);
  const status = read("tools/deploy/targets/status.mjs");
  assert.doesNotMatch(status, /\/api\/version/, "the backend knows no build id — status reads the stamps of current/ and web-out");
  assert.doesNotMatch(status, /curl [^\n]*\/api\/usage/, "GET /api/usage starts a CLI in the container");
  const main = read("tools/deploy/deploy.mjs");
  assert.match(main, /deployServer\(\{ release, stamp,/);
  assert.match(main, /deployWebOut\(\{ release, stamp \}\)/);
});

test("(6) build.json is never committed", () => {
  assert.match(read(".gitignore"), /^build\.json$/m);
  for (const rel of ["build.json", "server/backend/build.json", "web/out/build.json"]) {
    const out = execFileSync("git", ["check-ignore", "--no-index", rel], { cwd: REPO, encoding: "utf8" }).trim();
    assert.equal(out, rel);
  }
});
