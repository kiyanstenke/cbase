// The throttle of the image builds — lib/build-throttle.mjs and its wiring in targets/server.mjs and targets/rollback.mjs.
//
// PROMISES:
//   (1) The built command lines carry `nice -n 10 ionice -c3` in front of `docker build`: the backend build of the deploy, the project box
//       build (deploy and rollback) and the rebuild of the rollback.
//   (2) No `docker build` in the two targets runs without it. COUNTER-PROOF: the text check finds a copy in which one line lost the prefix.
//   (3) throttleBuild refuses a command without a docker build (no silent no-op).
// The end-to-end run (fake ssh with a fake nice/ionice that only drop their arguments) stands in the maintainer's private suite.
//
// Run:  node --test --test-reporter=tap tools/deploy/build-throttle.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BUILD_THROTTLE, throttleBuild } from "./lib/build-throttle.mjs";
import { projectboxBuildCommand } from "../check/lib/projectbox.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), "utf8");

// Every `docker build ` of a source text that does not stand behind the throttle: the line (a `throttleBuild(` call on the line counts).
function unthrottled(text) {
  return text.split("\n").filter((l) => /docker build /.test(l) && !/^\s*(\/\/|\*)/.test(l))
    .filter((l) => !l.includes(`${"${BUILD_THROTTLE}"} docker build `) && !l.includes("throttleBuild("));
}

test("(1) the command lines: backend build, project box build, rollback rebuild", () => {
  assert.equal(BUILD_THROTTLE, "nice -n 10 ionice -c3");
  const pb = projectboxBuildCommand({ root: "/r", release: "R1", cand: "cbase-projectbox:cand-R1", source: "f".repeat(64) });
  assert.equal(throttleBuild(pb), `cd /r && nice -n 10 ionice -c3 docker build --target projectbox -t cbase-projectbox:cand-R1 --label cbase.projectbox.source=${"f".repeat(64)} -f releases/R1/backend/Dockerfile releases/R1/backend`);
  assert.equal(throttleBuild("cd /r && docker build -t i -f d c"), "cd /r && nice -n 10 ionice -c3 docker build -t i -f d c");
  assert.equal(throttleBuild("docker build ."), "nice -n 10 ionice -c3 docker build .");
  // The wiring: the targets build their command with the prefix (the same literal template as before, with the throttle in front).
  assert.ok(read("targets/server.mjs").includes("cd ${root} && ${BUILD_THROTTLE} docker build -t ${cand} -f releases/${release}/backend/Dockerfile"));
  assert.ok(read("targets/server.mjs").includes("throttleBuild(projectboxBuildCommand({ root, release, cand: pbCand, source }))"));
  assert.ok(read("targets/rollback.mjs").includes("cd ${config.remote.root} && ${BUILD_THROTTLE} docker build -t ${targetItem}"));
  assert.ok(read("targets/rollback.mjs").includes("throttleBuild(projectboxBuildCommand({ root: config.remote.root, release: target, cand: pbCand }))"));
});

test("(2) no docker build in the targets without the throttle — and the check sees a copy that lost it", () => {
  assert.deepEqual(unthrottled(read("targets/server.mjs")), []);
  assert.deepEqual(unthrottled(read("targets/rollback.mjs")), []);
  const sabotaged = read("targets/server.mjs").replace("${BUILD_THROTTLE} docker build -t ${cand}", "docker build -t ${cand}");
  assert.equal(unthrottled(sabotaged).length, 1);
  // The project box lines carry no literal `docker build` (the shared builder in tools/check/lib/projectbox.mjs writes it): their wiring is the
  // `throttleBuild(projectboxBuildCommand(` assertion of (1).
});

test("(3) throttleBuild refuses a command that builds nothing", () => {
  assert.throws(() => throttleBuild("cd /r && docker tag a b"), TypeError);
  assert.throws(() => throttleBuild("echo docker builder"), TypeError);
});
