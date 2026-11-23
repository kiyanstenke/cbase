// Distribution of the project box into every user container — lib/projectbox-distribution.mjs, targets/server.mjs
// `rollOutAfterBackendBuild`/`swapContainerValue`, targets/rollback.mjs, targets/status.mjs, lib/remote.mjs `readImageId`,
// lib/gates.mjs `innerContainers`.
//
// PROMISES, each with a counter-test:
//   (1) Inside, `cbase-projectbox:latest` only points at a candidate that passed the start probe: load, check the id,
//       `run -d --privileged … --label cbase.probe=1`, wait until `docker info` answers in the probe container,
//       `rm -f -v <id>` — ONLY THEN, in a step of its own, `tag`. If the probe dies: no tag, the loaded name is gone again.
//       COUNTER-TEST: the same script without the probe part (sabotage in the test) tags without a probe.
//   (2) Same id ⇒ no `load`; deviating ⇒ `load` + probe + tag; unreachable ⇒ "unknown", no tag, no abort.
//   (3) Repointing inside happens BEFORE the early return "all already run this image" and BEFORE the gate. COUNTER-TEST: a copy of
//       targets/server.mjs with the repointing BEHIND the early return does not tag.
//   (4) `--dry-run` shows the commands (save|load, probe, tag) and runs none.
//   (5) The rollback sets inside :latest back to the candidate of the target release — after the swap of every B, after repointing
//       the host :latest AND after bringing back the inner containers, with start probe, without a stream if the id is already
//       inside. COUNTER-TESTS: rollback.mjs at the state before it; the distribution BEFORE the swap; the distribution between
//       repointing and bringing back (the old chain without restoreInner does not see that, the new one does).
//   (6) Cleanup inside: the two youngest candidates stay, older ones go by id — except :latest and used ones.
//   (7) The probe pool touches no occupied range in B.
//   (8) the operator's status check: inside == host candidate per B and the number of project containers with a deviating image — run
//       through projectboxStatus, the same function status.mjs calls (text guard on the wiring).
//   Load and start probe run in the deploy BEFORE `docker tag <cand> cbase-backend:latest`; a failure in one B holds back only its
//         tag, nothing throws, no hint to --force. COUNTER-TESTS: a copy with the preparation behind the tag; targets/server.mjs +
//         lib at the old state throw with "--force swaps anyway".
//   A bad verdict of the host probe or of the backend image check (lsof in the backend) throws before every tag, loads nothing and
//         does not repoint `current`. COUNTER-TEST: copies in which the verdict only warns repoint.
//   In the deploy a missing or unreadable host candidate is a throw before the tag; in the rollback "missing" is a warning.
//         COUNTER-TEST: the old distribution calls a read error "missing" and does not throw in the deploy.
//   A `run -d`, `docker load` or `inside=$(…)` that fails itself ends with EXIT.START/LOAD/ID and removes the name again.
//         COUNTER-TEST: the script at the old state ends with the code of docker, the name stays.
//   Every `docker exec` in B runs under `timeout`; a hanging one ends with "Cap exceeded: …", the B is unknown. COUNTER-TEST: the
//         old distribution calls docker exec without a cap.
//   Rollback dry run to a release without a project box: the same warning as the real run, no save|load. COUNTER-TEST: the old state
//         shows save|load, probe and tag in the dry run.
//   If the probe container stays, nothing is tagged; leftovers go on EVERY readable plan; innerContainers (so restoreInner and the
//         gate) knows no probe containers. COUNTER-TESTS: the old state tags anyway, leaves the leftover next to a current :latest,
//         and its innerContainers lists the probe as an inner container.
//   The host probe holds the sha256 of entry and wrapper IN the candidate against the state BEFORE the upload (`SNAPSHOT` =
//         localProjectboxStatus); a candidate with other bytes throws before every tag, and the seam rollOutAfterBackendBuild
//         without a state is a TypeError. checkReleaseSource holds the release folder (under REMOTE) against the same bytes: equal ⇒
//         silent, a file of the chain changed or gone ⇒ throw without a build, dry run ⇒ log only. COUNTER-TESTS: projectboxVerdict
//         without the block `expectation.files` ⇒ "a candidate …" red (the deploy ran on up to the container check);
//         releaseSourceVerdict always ok ⇒ "checkReleaseSource …" red (no rejection).
//   The start probe asks in the ready probe container `git lfs version` and `git config --system --get-all credential.helper` (the
//         `git` of the containers: `probeLfs(…)`). Both pass (git-lfs/… AND exactly LFS_HELPER_IM_BACKEND, the version stands in
//         "Start probe passed") or neither (a project box from before the LFS helper — only via a rollback); only one, a foreign or
//         second helper or git-lfs without a version line is EXIT.LFS without a tag, the name is gone. COUNTER-TEST (built in, per
//         situation): the same script without the LFS part (`withoutLfs`) passes and leaves the candidate ready.
//
// HOW. Fake ssh (runs the script with bash, like `bash -s` on the host), fake curl/pgrep/sleep/timeout and the fake docker of the
// project containers (server/backend/test/fake-docker.mjs): the host daemon holds the candidates, every B has its own daemon
// (`docker exec -u agent <B> docker …`), every probe container too. PATH is ${BIN}:/usr/bin:/bin — a real docker or ssh is not
// reachable. In front of the fake docker sits an entry with DISRUPTIONS per test (`disruptions`: a pattern on the arguments ⇒ fixed
// output and exit code — the answers of both image checks, the project box build, a failing `run -d`). No clock: the fake `sleep`
// returns at once, "dockerd is still starting" is a number of failures per daemon (infoFailures), the fake `timeout` ends with 124
// as soon as a call stands at the gate of the fake docker (event "hangs"), and the end of a run is the end of the call.
//
//
// SPLIT. This file is the PUBLIC half: the planning functions, the situation reader, the probe pool and the scripts of
// lib/projectbox-scripts.mjs against the fake docker (lib/projectbox-distribution-fixture.mjs). Everything that runs the flow over ssh,
// the server and rollback targets, the status wiring and the old-state copies of the distribution (they load the deploy configuration)
// stands in the maintainer's private suite. The promises (1)–(8) above are numbered as before.
//
// Run:  node --test --test-reporter=tap tools/check/projectbox-distribution.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { LFS_HELPER_IN_BACKEND, SOURCE_LABEL, readProjectboxExpectation } from "./lib/projectbox.mjs";
import {
  OCCUPIED_RANGES, EXEC_CAP_S, EXIT, LOAD_CAP_S, PROBE_LABEL, PROBE_POOL, cleanupPlan, cleanupScript, rangesIntersect, readScript, probeScript, projectboxSituation, projectboxPlan, projectboxRows, sourceFromLabels, leftoversScript, tagScript, prepareScript,
} from "./lib/projectbox-scripts.mjs";
import {
  READY, probeStatus, statusReadings, probeLfs, B, R1, R2, R_OLD, R_NEW, hex, PB_NEW, PB_OLD, PB_R1, cand, LATEST, sh, shOk, build, insideLatest, isTagLatest, probeLeftovers, tagsOnlyAfterProbe, Q1, Q2, rowsOf, probeAndTagSeparated, withoutProbe, lfsCalls, withoutLfs, bringsLeftoverBack,
} from "./lib/projectbox-distribution-fixture.mjs";

test("(7) the probe pool touches no occupied range in B (level 2, inner pool, block list, default pools of B)", () => {
  assert.equal(PROBE_POOL, "10.249.0.0/16");
  assert.deepEqual(OCCUPIED_RANGES.filter((b) => rangesIntersect(PROBE_POOL, b.cidr)).map((b) => b.what), []);
  // Counter-test: the check sees an overlap — the inner pool of the project containers, docker0 of B, a subnet.
  for (const wrong of ["10.241.0.0/16", "172.17.0.0/16", "10.230.5.0/24", "10.0.0.0/8"]) {
    assert.ok(OCCUPIED_RANGES.some((b) => rangesIntersect(wrong, b.cidr)), wrong);
  }
  assert.throws(() => rangesIntersect("10.249.0.0", "10.0.0.0/8"), TypeError);
});
test("(2) projectboxPlan: same id ⇒ nothing, other or missing ⇒ load, unreadable ⇒ unknown", () => {
  const hostId = `sha256:${PB_NEW}`;
  assert.deepEqual(projectboxPlan({ hostId, inside: {
    equal: hostId, different: `sha256:${PB_OLD}`, missing: null, unknown: "unknown", empty: "", undef: undefined,
  } }), { equal: "nothing", different: "load", missing: "load", unknown: "unknown", empty: "unknown", undef: "unknown" });
  assert.throws(() => projectboxPlan({ hostId: null, inside: {} }), TypeError);
  assert.throws(() => projectboxPlan({ hostId: "sha256:short", inside: {} }), TypeError);
});
test("projectboxSituation: \"No such image\" is missing, every other kind of error unknown with its reason — never an empty list for something unreadable", () => {
  const part = (k, rows, rc) => [`--- ${k}`, ...rows, `--- rc ${rc}`];
  const ok = [
    ...part("LATEST", [`sha256:${PB_NEW}`], 0),
    ...part("IMAGES", [`cand-${R_NEW} sha256:${PB_NEW}`, `latest sha256:${PB_NEW}`], 0),
    ...part("ALL", [`sha256:${PB_OLD} /cbase-p-1`], 0),
    ...part("PROJECTS", [`sha256:${PB_OLD} /cbase-p-1`], 0),
  ].join("\n");
  assert.deepEqual(projectboxSituation(ok), {
    latest: `sha256:${PB_NEW}`,
    source: null,
    reason: null,
    images: [{ tag: `cand-${R_NEW}`, id: `sha256:${PB_NEW}` }, { tag: "latest", id: `sha256:${PB_NEW}` }],
    used: [`sha256:${PB_OLD}`],
    projects: [{ image: `sha256:${PB_OLD}`, name: "cbase-p-1" }],
    daemon: null,
  });
  assert.equal(projectboxSituation(part("LATEST", ["Error: No such image: cbase-projectbox:latest"], 1).join("\n")).latest, null);
  for (const text of [
    "Error response from daemon: No such container: cbase-u-abc",
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    "OCI runtime exec failed: exec failed: unable to start container process: unknown",
    "Error response from daemon: container 1234 is not running",
    `Cap exceeded: docker exec -u agent cbase-u-abc docker image … did not answer within ${EXEC_CAP_S} s`,
  ]) {
    const l = projectboxSituation(part("LATEST", [text], text.startsWith("Cap") ? 124 : 1).join("\n"));
    assert.equal(l.latest, "unknown", text);
    assert.equal(l.reason, text, "the reason of the unknown is missing");
  }
  assert.equal(projectboxSituation("").latest, "unknown");
  assert.equal(projectboxSituation(part("LATEST", ["broken"], 0).join("\n")).latest, "unknown");
  const l = projectboxSituation([...part("IMAGES", ["Error: broken"], 1), ...part("ALL", ["unreadable"], 0)].join("\n"));
  assert.equal(l.images, null);
  assert.equal(l.used, null);
  assert.equal(l.projects, null);
});
test("projectboxPlan: other id, same source ⇒ source; a missing or deviating source ⇒ load; sourceFromLabels", () => {
  const hostId = `sha256:${PB_NEW}`;
  const inside = { equal: `sha256:${PB_OLD}`, different: `sha256:${PB_OLD}`, without: `sha256:${PB_OLD}`, missing: null, unknown: "unknown", idEqual: hostId };
  assert.deepEqual(projectboxPlan({ hostId, inside, hostSource: Q1, insideSource: { equal: Q1, different: Q2, without: null, missing: Q1, unknown: Q1, idEqual: Q2 } }),
    { equal: "source", different: "load", without: "load", missing: "load", unknown: "unknown", idEqual: "nothing" });
  assert.deepEqual(projectboxPlan({ hostId, inside: { equal: `sha256:${PB_OLD}` }, hostSource: null, insideSource: { equal: null } }), { equal: "load" }, "two missing sources are not equal ones");
  assert.deepEqual(projectboxPlan({ hostId, inside: { a: `sha256:${PB_OLD}` }, hostSource: "broken", insideSource: { a: "broken" } }), { a: "load" });
  assert.equal(sourceFromLabels(JSON.stringify({ [SOURCE_LABEL]: Q1, x: "y" })), Q1);
  for (const t of ["null", "", "no json", JSON.stringify({ [SOURCE_LABEL]: "short" }), JSON.stringify({ other: Q1 })]) assert.equal(sourceFromLabels(t), null, t);
  const situation = projectboxSituation([`--- LATEST`, `sha256:${PB_NEW}`, `--- rc 0`, `--- SOURCE`, JSON.stringify({ [SOURCE_LABEL]: Q1 }), `--- rc 0`].join("\n"));
  assert.equal(situation.source, Q1);
  assert.equal(projectboxSituation([`--- LATEST`, `sha256:${PB_NEW}`, `--- rc 0`, `--- SOURCE`, "Error", `--- rc 1`].join("\n")).source, null);
});
test("(6) cleanupPlan: the two youngest candidates stay, older ones go by id — except :latest and used ones; unknown removes nothing", () => {
  const id = (c) => `sha256:${hex(c)}`;
  const images = [
    { tag: `cand-${R1}`, id: id("e") }, { tag: `cand-${R2}`, id: id("f") }, { tag: `cand-${R_OLD}`, id: id("c") },
    { tag: `cand-${R_NEW}`, id: id("b") }, { tag: "latest", id: id("b") }, { tag: "cand-19990101-1", id: id("1") },
  ];
  assert.deepEqual(cleanupPlan({ images, used: [id("e")], latest: id("b") }),
    { remove: [id("f"), id("1")], stay: [`cand-${R_NEW}`, `cand-${R_OLD}`], unknown: false });
  // Rollback situation: :latest is an older candidate — it stays.
  assert.deepEqual(cleanupPlan({ images, used: [], latest: id("f") }).remove, [id("e"), id("1")]);
  // An old name on the same id as a kept one: the id stays.
  assert.deepEqual(cleanupPlan({ images: [...images, { tag: `cand-${R1}x`, id: id("c") }], used: [id("e")], latest: id("b") }).remove, [id("f"), id("1")]);
  for (const wrong of [{ images: null, used: [], latest: id("b") }, { images, used: null, latest: id("b") }, { images, used: [], latest: "unknown" }]) {
    assert.deepEqual(cleanupPlan(wrong).remove, []);
  }
});
test("(1) prepareScript: save|load as a stream with a cap, id comparison, probe with pool and label, no tag; tagScript: id before the tag", async () => {
  const hostId = `sha256:${PB_NEW}`;
  const s = prepareScript({ container: B, cand: cand(R_NEW), hostId });
  const t = tagScript({ container: B, ref: cand(R_NEW), hostId });
  assert.ok(rowsOf(s).some((l) => l.startsWith(`  docker save ${cand(R_NEW)} | timeout -k 5 ${LOAD_CAP_S} docker exec -i -u agent ${B} docker load || {`)), s);
  assert.ok(s.includes(`dx docker run -d --privileged -e CBASE_DOCKER_POOL=${PROBE_POOL} --label ${PROBE_LABEL} ${cand(R_NEW)}`));
  assert.ok(s.includes(`if [ "$inner" != "${hostId}" ]`));
  assert.equal(probeAndTagSeparated(s, t, hostId), true);
  // Every call in B goes through `dx` (cap) or the stream with a cap — no bare `docker exec`. Counted without the text in double
  // quotes (messages name the command).
  const bare = (script) => rowsOf(script).filter((l) => {
    const command = l.replace(/"[^"]*"/g, '""');
    const all = command.split("docker exec").length - 1;
    const capped = (command.match(/(\bdx|timeout -k 5 \d+) docker exec/g) || []).length;
    return all !== capped;
  });
  for (const script of [s, t, readScript(B, { wait: true }), probeScript({ container: B, ref: cand(R_NEW) }), cleanupScript({ container: B, ids: [`sha256:${PB_R1}`] }), leftoversScript(B)]) {
    assert.deepEqual(bare(script), [], "docker exec without a cap");
  }
  // Removal only by id: every `docker rm` line names "$pid" or $alt (both ids from `run -d` or `ps -q`).
  const rm = rowsOf(s).filter((l) => /docker rm /.test(l));
  assert.equal(rm.length, 2);
  for (const l of rm) assert.match(l, /docker rm -f -v (\$gone|"\$pid")/, l); // $gone = the leftovers with OWN label
  assert.equal(s.includes("\t"), false);
  assert.throws(() => prepareScript({ container: "a b", cand: cand(R_NEW), hostId }), TypeError);
  assert.throws(() => prepareScript({ container: B, cand: cand(R_NEW), hostId: "sha256:short" }), TypeError);
  assert.throws(() => tagScript({ container: B, ref: cand(R_NEW), hostId: "sha256:short" }), TypeError);
  // Counter-test of the text check: a tag in the prepare step or a tag without id check ⇒ false.
  assert.equal(probeAndTagSeparated(`${s}\ndx docker tag ${cand(R_NEW)} ${LATEST}`, t, hostId), false);
  assert.equal(probeAndTagSeparated(s, rowsOf(t).filter((l) => !l.startsWith('if [ "$inner"')).join("\n"), hostId), false);
});
test("(1) the probe against the fake docker: tag only after a passed probe — the sabotage without a probe tags anyway and fails", async () => {
  for (const sabotage of [false, true]) {
    const { fd, fresh } = await build({ images: { [cand(R_NEW)]: PB_NEW }, infoFailures: { ">": 2 } });
    try {
      const s = prepareScript({ container: B, cand: cand(R_NEW), hostId: `sha256:${PB_NEW}` });
      const r = sh(sabotage ? withoutProbe(s) : s);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(insideLatest(fd), null, "the prepare step set :latest");
      shOk(tagScript({ container: B, ref: cand(R_NEW), hostId: `sha256:${PB_NEW}` }));
      assert.equal(insideLatest(fd), PB_NEW);
      assert.equal(tagsOnlyAfterProbe(fresh()), !sabotage, JSON.stringify(fresh().map((a) => [a.daemon, ...a.args.slice(0, 3)])));
      if (!sabotage) {
        // The probe daemon reported "not there yet" twice, answered the third time; after that the probe is gone.
        assert.equal(fresh().filter((a) => a.daemon.startsWith(`${B}>`) && a.args[0] === "info").length, 3);
        assert.deepEqual(probeLeftovers(fd), []);
        assert.match(r.stdout, /Start probe passed/);
      }
    } finally { fd.cleanUp(); }
  }
});
test("(1) a candidate whose entrypoint fails: no tag, the loaded name is gone again, no probe stays", async () => {
  const { fd, fresh } = await build({ images: { [cand(R_NEW)]: PB_NEW, [cand(R_OLD)]: PB_OLD }, inside: [[cand(R_OLD), true]], brokenImages: [PB_NEW] });
  try {
    const r = sh(prepareScript({ container: B, cand: cand(R_NEW), hostId: `sha256:${PB_NEW}` }));
    assert.equal(r.code, EXIT.PROBE, r.stderr);
    assert.match(r.stderr, /no longer running \(Running=false\)/);
    assert.match(r.stderr, /entrypoint of this image failed/, "the last log lines of the probe are missing in the notice");
    assert.equal(insideLatest(fd), PB_OLD, "inside :latest was repointed despite the failed probe");
    assert.equal(fd.state(B).images[cand(R_NEW)], undefined, "the unchecked candidate still lies inside under its name");
    assert.equal(fresh().some(isTagLatest), false);
    assert.deepEqual(Object.keys(fd.state(B).container), []);
  } finally { fd.cleanUp(); }
});
test("(1) a probe container left over from an aborted run is removed by id before the new probe", async () => {
  const { fd } = await build({ images: { [cand(R_NEW)]: PB_NEW }, inside: [[cand(R_NEW), false]] });
  try {
    shOk(`docker exec -u agent ${B} docker run -d --privileged --label ${PROBE_LABEL} ${cand(R_NEW)} >/dev/null`);
    assert.equal(Object.keys(fd.state(B).container).length, 1);
    assert.match(shOk(probeScript({ container: B, ref: cand(R_NEW) })), /^Probe leftovers removed: 1$/m);
    assert.deepEqual(Object.keys(fd.state(B).container), []);
    shOk(tagScript({ container: B, ref: cand(R_NEW), hostId: `sha256:${PB_NEW}` }));
    assert.equal(insideLatest(fd), PB_NEW);
  } finally { fd.cleanUp(); }
});
test("start → wait → ready: the probe reads on until ready and names the notice; if it stays at wait or the file is missing, it ends at the cap without a tag", async () => {
  {
    const { fd, fresh } = await build({ images: { [cand(R_NEW)]: PB_NEW } });
    try {
      probeStatus("phase=start\nnotice=Pool 10.249.0.0/16\n", "phase=wait\nnotice=dockerd started\n", READY);
      const r = sh(prepareScript({ container: B, cand: cand(R_NEW), hostId: `sha256:${PB_NEW}` }));
      assert.equal(r.code, 0, r.stderr);
      assert.equal(statusReadings(fresh()), 3);
      assert.match(r.stdout, /Start probe passed: .* \(phase=ready: own IP 172\.17\.0\.2, docker0 10\.249\.0\.1/);
      assert.equal(fd.state(B).images[cand(R_NEW)]?.id, PB_NEW);
      assert.deepEqual(probeLeftovers(fd), []);
    } finally { fd.cleanUp(); }
  }
  for (const [what, followUp, phase] of [["stays at wait", ["phase=wait\n"], "wait"], ["file missing", [], "—"]]) {
    const { fd, fresh } = await build({ images: { [cand(R_NEW)]: PB_NEW } });
    try {
      probeStatus(...followUp);
      const r = sh(prepareScript({ container: B, cand: cand(R_NEW), hostId: `sha256:${PB_NEW}`, cap: 3 }));
      assert.equal(r.code, EXIT.CAP, `${what}: ${r.stderr}`);
      assert.match(r.stderr, new RegExp(`not ready after 3 attempts at one-second intervals \\(docker info: exit 0, status file: phase=${phase}\\)`), what);
      assert.equal(statusReadings(fresh()), 3, what);
      assert.equal(fd.state(B).images[cand(R_NEW)], undefined, what);
      assert.deepEqual(probeLeftovers(fd), [], what);
      assert.equal(fresh().some(isTagLatest), false, what);
    } finally { fd.cleanUp(); }
  }
});
test("the start probe asks `git lfs version` and the helper: both there ⇒ passed, the version stands in the log; neither there (project box from before the LFS helper, the rollback) ⇒ passed", async () => {
  for (const [situation, row] of [
    [{}, /Start probe passed: .* \(phase=ready: own IP .*; git-lfs\/3\.3\.0\)$/m],
    [{ lfs: null, helper: null }, /Start probe passed: .*; without git-lfs and LFS helper \(project box from before the LFS helper\)\)$/m],
  ]) {
    const { fd, fresh } = await build({ images: { [cand(R_NEW)]: PB_NEW } });
    try {
      probeLfs(situation);
      const r = sh(prepareScript({ container: B, cand: cand(R_NEW), hostId: `sha256:${PB_NEW}` }));
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, row);
      assert.deepEqual(lfsCalls(fresh()), ["git lfs version", "git config --system --get-all credential.helper"]);
      assert.equal(fd.state(B).images[cand(R_NEW)]?.id, PB_NEW);
      assert.deepEqual(probeLeftovers(fd), []);
    } finally { fd.cleanUp(); }
  }
});
test("only one of the two, a foreign or second helper, git-lfs without a version line: EXIT.LFS, no tag, the name is gone, no probe stays — counter-test: without the LFS part the same candidate passes", async () => {
  for (const [what, situation] of [
    ["git-lfs missing, the helper stands", { lfs: null }],
    ["the helper is missing, git-lfs is there", { helper: null }],
    ["a foreign helper", { helper: "store\n" }],
    ["a second helper", { helper: `${LFS_HELPER_IN_BACKEND}\nstore\n` }],
    ["git-lfs without a version line", { lfs: "\n" }],
  ]) {
    const { fd, fresh } = await build({ images: { [cand(R_NEW)]: PB_NEW, [cand(R_OLD)]: PB_OLD }, inside: [[cand(R_OLD), true]] });
    try {
      probeLfs(situation);
      const s = prepareScript({ container: B, cand: cand(R_NEW), hostId: `sha256:${PB_NEW}` });
      const r = sh(s);
      assert.equal(r.code, EXIT.LFS, `${what}: ${r.stderr}`);
      assert.match(r.stderr, /Start probe: git-lfs and LFS helper in \S+ do not fit together \(git lfs version: exit \d+, .*credential\.helper: exit \d+/, what);
      assert.equal(fd.state(B).images[cand(R_NEW)], undefined, `${what}: the unchecked name still lies inside`);
      assert.deepEqual(probeLeftovers(fd), [], what);
      assert.equal(fresh().some(isTagLatest), false, what);
      assert.equal(insideLatest(fd), PB_OLD, what);
      // Counter-test: the same situation, the same script without the LFS part — the probe passes (the candidate would lie ready for the tag).
      const g = sh(withoutLfs(s));
      assert.equal(g.code, 0, `${what}, sabotage: ${g.stderr}`);
      assert.equal(fd.state(B).images[cand(R_NEW)]?.id, PB_NEW, `${what}: the sabotage did not leave the candidate ready — the counter-test proves nothing`);
    } finally { fd.cleanUp(); }
  }
});
test("(8) status: missing inside, host candidate missing, unknown — each warn, never ok", () => {
  const without = { latest: null, images: [], used: [], projects: [], daemon: null };
  assert.deepEqual(projectboxRows({ situation: without, hostId: `sha256:${PB_NEW}`, hostRef: cand(R_NEW) })[0], ["Project box inside == host candidate", "missing inside — the next deploy loads it", "warn"]);
  assert.equal(projectboxRows({ situation: { ...without, latest: `sha256:${PB_NEW}` }, hostId: null, hostRef: cand(R_NEW) })[0][2], "warn");
  const unknownRows = projectboxRows({ situation: projectboxSituation(""), hostId: `sha256:${PB_NEW}`, hostRef: cand(R_NEW) });
  assert.deepEqual(unknownRows.map((z) => z[2]), ["warn", "warn"]);
  assert.match(unknownRows[1][1], /unknown/);
});
test("bringsLeftoverBack: a name that happens to look like the start of the id is no bringing back — the old check thought it was", () => {
  const rest = `db${"a".repeat(62)}`;
  const old = (a) => a.args.some((y) => rest.startsWith(y) || y.startsWith(rest.slice(0, 12)));
  assert.equal(old({ args: ["start", "db"] }), true, "the counter-test does not bite: the old check did not see the false hit");
  assert.equal(bringsLeftoverBack({ args: ["start", "db"] }, rest), false);
  assert.equal(bringsLeftoverBack({ args: ["start", rest.slice(0, 12)] }, rest), true, "an id prefix of 12 characters is the leftover");
  assert.equal(bringsLeftoverBack({ args: ["start", "db", rest] }, rest), true, "the full id is the leftover");
});
