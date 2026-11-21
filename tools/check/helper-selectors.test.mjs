// NO search for project containers hits a helper.
// The helper (server/backend/electron/server/projectbox/helper.js) carries `cbase.helper=<kind>` plus `cbase.helper.project/
// .instance/.run` and is named `cbase-helper-…`, never `cbase.project`/`cbase.instance`, never `cbase-p-…`. Here stand the
// searches from server/backend/ and the operator tooling (no glob of the gate reaches them) and the two from the backend that ask
// the same question, run against the fake docker (server/backend/test/fake-docker.mjs), which filters `--filter label=<key>`
// by the WHOLE key like the real one.
//
// Split: this file holds the searches of server/backend/, server/gateway/ and lib/projectbox-scripts.mjs and the cbase-project fallback;
// `innerFrom`, `restoreInner` and the probe leftovers (installation tooling) stand in
// the maintainer's private suite, on the same fixture (lib/helper-selectors-fixture.mjs).
//
// What holds:
//   - SELECTORS: every search stands verbatim in its file (else the table must be updated: red) and, asked against the same
//     state, returns the project container and neither of the two real helpers. Built-in counter-test: a helper of the WRONG
//     form (with `cbase.project`/`cbase.instance`) is hit by EVERY search, so the check has teeth.
//   - Deploy: `innerFrom` (lib/gates.mjs) leaves out every helper (also the wrong form: the helper label suffices) and
//     reports the project container as `project`; `restoreInner` fetches no helper back. Counter-test against the fixed state
//     BEFORE_E (not HEAD): its `innerFrom` returns the helper as an inner container of the user, `retrievalList` fetched it.
//   - cbase-project without backend: a project with only a helper ends with exit 2 ("no project container with cbase.project=…"), without
//     `exec`; counter-test: with the helper of the wrong form the fallback would fall into it (exec into its id).
//
// COUNTER-TESTS (each shown red):
//   projectbox/helper.js: `--label cbase.project=<pid>` and `cbase.instance=<instance>` in helperArgs (its check
//     `helperViolations` removed) => the selectors test and the cbase-project test red
//   the inner-container selection at state BEFORE_E => the innerFrom test red (also built in below)
//
//   `innerFrom` recognises probe, helper and project container only by their own keys ON the container
//     (projectbox/own-labels.js). A user container from an image with `LABEL cbase.helper=…`/`cbase.probe=1`/`cbase.project=…`
//     is fetched back; for that `innerContainers` reads the exact labels including those of the images (`EXACTLY_SCRIPT`,
//     run here against the fake docker, which inherits image labels like the real one). Counter-test: gates.mjs at state
//     9ee81f4 has no EXACTLY_SCRIPT, and its `innerFrom` leaves the three out (red).
//
//   The probe leftovers of the distribution (lib/projectbox-distribution.mjs `leftoversScript`) follow the same rule: a user
//     container that merely inherits `cbase.probe=1` from the image stays; the real probe goes. Counter-test built in: the
//     script at state BEFORE_PE28 removes both. Sabotage: delete the line
//     `if [ -n "$bw" ] && [ "$bw" = "$cw" ]; then continue; fi` in leftoversPart => the leftovers test red.
//
// No clock: the fake docker answers synchronously; the cbase-project fallback runs against a dead port.
import assert from "node:assert/strict";
import test from "node:test";

import { SELECTORS, PID, PID_ONLY, PID_WRONG, checkSelectors, withBuild, deadPort, start } from "./lib/helper-selectors-fixture.mjs";

test("selectors: every search for project containers hits the project container and no helper; a helper of the wrong form would be hit by every one", async () => {
  await checkSelectors(SELECTORS);
});

test("cbase-project without backend: a project with only a helper has no project container; the helper of the wrong form would be fallen into", async () => {
  await withBuild(async ({ fd, wrong }) => {
    const env = { CBASE_DOCKER_BIN: fd.bin, CBASE_PROJECT_API: `http://127.0.0.1:${await deadPort()}` };
    let from = fd.calls().length;
    const r = await start([PID_ONLY, "--", "true"], env);
    assert.equal(r.code, 2, JSON.stringify(r));
    assert.match(r.err, /no project container with cbase\.project=p-only-helper/);
    assert.ok(!fd.calls().slice(from).some((a) => a.args[0] === "exec"), "no exec, least of all into the helper");

    from = fd.calls().length;
    const g = await start([PID_WRONG, "--", "true"], env);
    const ex = fd.calls().slice(from).find((a) => a.args[0] === "exec");
    assert.ok(ex && ex.args.includes(wrong), `counter-test: the fallback did not fall into the helper of the wrong form (${JSON.stringify(g)})`);
  });
});
