// The helper container: projectbox/helper.js against the fake docker, plus the restart-grace hook "project-helper".
// Searches for project containers outside the backend (entry.sh, gateway, deploy, cbase-project) are held by
// tools/check/helper-selectors.test.mjs.
//
// What holds:
//   - Shape: `run -d --name cbase-helper-... --network none --restart no`, the four helper labels, only `--mount`, entrypoint
//     tini with `sleep`, the project-box image. Every deviation is a violation (`helperViolations`), and a violation starts
//     nothing: `--privileged`, a `cbase.project`/`cbase.instance` label, a network, `-v`, `-p`, a comma in a label value or
//     mount path, a name `cbase-p-...`, a missing run label.
//   - Without the operating mark no docker call - start, restart grace.
//   - In operation: the start is logged as checked, `exec` as root with the environment only as a name, removal by id and only
//     for a helper (a project container is refused), an already gone object is no error; `withHelper` also removes after a
//     throw; a bind source through a symlink is refused before docker starts.
//   - Orphans: restart grace removes by id exactly the helpers of another server run - never its own, never a project or user
//     container.
//   - A user container that only inherits `cbase.helper` from its image is no helper: `removeHelper` throws `NoHelper`, the
//     restart grace leaves it alone (no error). Counter-test: the old helper.js removed it with its anonymous volumes
//     (`rm -f -v`) - red.
//   - Registration: `fireHooks("restartGrace")` in the server calls "project-helper" before "project-instances".
//
// COUNTER-TESTS (each shown red, then reverted):
//   projectbox/helper.js: `--label cbase.project=<pid>` in helperArgs                                  => "Shape ..." red
//     (and tools/check/helper-selectors.test.mjs red)
//   projectbox/helper.js: the query for the OWN helpers in restart grace removed (every helper is an orphan) => "Orphans ..." red
//   projectbox/helper.js: the label check in removeHelper removed                                       => "In operation ..." red
//     (the project container is gone)
//   server.js: the registration "project-helper" removed                                                => "Registration ..." red
//
// No clock: everything only waits for the answers of the fake docker.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FOREIGN_LABELS, HELPER_PREFIX, LABEL_HELPER, LABEL_HELPER_RUN, removeHelper, helperArgs, executeHelper, helperRun, helperRestartGrace,
  helperViolations, cleanUpHelperOrphans, withHelper, startHelper,
} from "../electron/server/projectbox/helper.js";
import { PROJECTBOX_IMAGE } from "../electron/server/projectbox/creation.js";
import { observeHooks, fireHooks } from "../electron/server/runs/hooks.js";
import { fakeDocker } from "./fake-docker.mjs";
import { withAgentsServer } from "./agent-harness.mjs";

const TUNABLES = ["CBASE_CONTAINER", "CBASE_DIND", "CBASE_DOCKER_BIN"];
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(TUNABLES.map((k) => [k, process.env[k]]));
  try {
    for (const k of TUNABLES) { if (values[k] === undefined) delete process.env[k]; else process.env[k] = values[k]; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
async function withFake(fn, { ops = true, images } = {}) {
  const fd = await fakeDocker(images ? { images } : {});
  try {
    return await withEnvironment({ CBASE_DOCKER_BIN: fd.bin, ...(ops ? { CBASE_CONTAINER: "1", CBASE_DIND: "1" } : {}) }, () => fn(fd));
  } finally {
    fd.cleanUp();
  }
}
const fakeRun = (fd, args) => {
  const r = spawnSync(fd.bin, args, { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const container = (fd) => Object.values(fd.state("host").container || {});

const GUT = { kind: "relocation", projectId: "p-1", mounts: [{ type: "volume", source: "geo_pgdata", target: "/src", onlyRead: true }, { type: "volume", source: "cbase-p-p-1-docker", target: "/dst" }], labels: { "cbase.relocation": "7" } };

test("Shape: only --network none, --restart no, helper labels, --mount, tini+sleep - every deviation is a violation (project-container labels included)", () => {
  const args = helperArgs({ ...GUT, seq: "abcd1234" });
  assert.deepEqual(helperViolations(args), [], "the own shape is allowed");
  assert.ok(!args.includes("--privileged"));
  assert.equal(args[args.indexOf("--name") + 1], `${HELPER_PREFIX}relocation-abcd1234`);
  assert.deepEqual(args.slice(-4), [PROJECTBOX_IMAGE, "--", "sleep", "infinity"]);
  const labels = args.flatMap((a, i) => (a === "--label" ? [args[i + 1]] : []));
  assert.deepEqual(labels.map((l) => l.split("=")[0]), [LABEL_HELPER, "cbase.helper.project", "cbase.helper.instance", LABEL_HELPER_RUN, "cbase.relocation"]);
  for (const k of FOREIGN_LABELS) assert.ok(!labels.some((l) => l.startsWith(`${k}=`)), `${k} on the helper`);
  assert.deepEqual(helperViolations(helperArgs({ ...GUT, mounts: [{ type: "bind", source: "/home/agent/My Project", target: "/home/agent/My Project" }] })), [], "spaces in the path are no violation");

  const before = (fresh) => { const a = [...args]; a.splice(1, 0, ...fresh); return a; };
  const replace = (old, fresh) => args.map((a) => (a === old ? fresh : a));
  const cases = [
    ["--privileged", before(["--privileged"]), /forbidden: --privileged/],
    ["cbase.project", before(["--label", "cbase.project=p-1"]), /never carries the labels of the project containers/],
    ["cbase.instance", before(["--label", "cbase.instance=copy-k1"]), /never carries the labels of the project containers/],
    ["network", replace("none", "bridge"), /--network none/],
    ["second network", before(["--network", "cbase-pn-p-1"]), /--network none/],
    ["-v", before(["-v", "/:/host"]), /forbidden: -v/],
    ["-p", before(["-p", "80:80"]), /forbidden: -p/],
    ["restart", replace("no", "always"), /--restart no/],
    ["Name cbase-p-", replace(`${HELPER_PREFIX}relocation-abcd1234`, "cbase-p-p-1"), /name/],
    ["comma in label value", before(["--label", "cbase.relocation2=1,cbase.project=p"]), /without a valid value/],
    ["comma in mount path", helperArgs({ ...GUT, mounts: [{ type: "bind", source: "/a,readonly=false,src=/", target: "/b", onlyRead: true }] }), /mount field (src|readonly)/],
    ["relative mount target", before(["--mount", "type=volume,src=v,dst=rel"]), /mount target/],
    ["label without run", args.filter((a, i) => !(a.startsWith(`${LABEL_HELPER_RUN}=`) || args[i + 1]?.startsWith(`${LABEL_HELPER_RUN}=`))), /without label cbase\.helper\.run/],
    ["unknown kind", replace(`${LABEL_HELPER}=relocation`, `${LABEL_HELPER}=drill`), /not a known kind/],
    ["other image", replace(PROJECTBOX_IMAGE, "alpine"), /image alpine/],
    ["other command", [...args.slice(0, -2), "rm", "-rf"], /command/],
  ];
  for (const [what, a, pattern] of cases) {
    const v = helperViolations(a);
    assert.ok(v.some((x) => pattern.test(x)), `${what}: not detected (${JSON.stringify(v)})`);
  }
});

test("Without the operating mark no docker call - start and restart grace", async () => {
  await withFake(async (fd) => {
    await assert.rejects(startHelper(GUT), (e) => e.code === "NO_OPS");
    assert.deepEqual(await helperRestartGrace(), { removed: [], error: [] });
    assert.deepEqual(await cleanUpHelperOrphans(), { removed: [], error: [] });
    assert.deepEqual(fd.calls(), [], "the fake docker's log is empty");
  }, { ops: false });
});

test("In operation: start as checked, exec as root with the environment only as a name, removal by id and only for helpers; symlink source refused", async () => {
  await withFake(async (fd) => {
    const h = await startHelper(GUT);
    assert.match(h.id, /^[0-9a-f]{64}$/);
    const [run] = fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "run").map((a) => a.args);
    assert.deepEqual(helperViolations(run), [], "what docker received is the checked shape");
    const c = container(fd).find((x) => x.id === h.id);
    assert.equal(c.status, "running");
    assert.deepEqual([c.labels[LABEL_HELPER], c.labels["cbase.helper.project"], c.labels[LABEL_HELPER_RUN]], ["relocation", "p-1", helperRun()]);
    assert.ok(!("cbase.project" in c.labels) && !("cbase.instance" in c.labels));
    assert.deepEqual(c.networks, [{ name: "none", ip: "" }]);
    assert.deepEqual(c.mounts.map((m) => [m.Source, m.Destination, m.RW]), [["geo_pgdata", "/src", false], ["cbase-p-p-1-docker", "/dst", true]]);

    const r = await executeHelper(h, ["sh", "-c", "printf %s \"$HELPER_TEST_VALUE\""], { env: { HELPER_TEST_VALUE: "secret-42" } });
    assert.equal(r.stdout, "secret-42");
    const ex = fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec").at(-1).args;
    assert.deepEqual(ex.slice(0, 6), ["exec", "-u", "0", "-e", "HELPER_TEST_VALUE", h.id], "root, environment only as a name, by id");
    assert.ok(!ex.join(" ").includes("secret-42"), "the value never appears on the command line");

    // A project container is not removed - not even if someone hands over its id.
    const pc = fakeRun(fd, ["run", "-d", "--name", "cbase-p-p-1", "--label", "cbase.project=p-1", "--label", "cbase.instance=main", PROJECTBOX_IMAGE]);
    await assert.rejects(removeHelper(pc), /is not a helper/);
    assert.ok(container(fd).some((x) => x.id === pc), "the project container is still there");
    await assert.rejects(removeHelper("cbase-p-p-1"), /not a full id/, "never by name");

    assert.equal(await removeHelper(h.id), true);
    const rm = fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "rm").at(-1).args;
    assert.deepEqual(rm, ["rm", "-f", "-v", h.id]);
    assert.ok(!container(fd).some((x) => x.id === h.id));
    assert.equal(await removeHelper(h.id), false, "already gone is no error");

    // withHelper: gone even after a throw.
    let inside = null;
    await assert.rejects(withHelper(GUT, async (x) => { inside = x.id; throw new Error("cp fails"); }), /cp fails/);
    assert.ok(inside && !container(fd).some((x) => x.id === inside), "removed after the throw");

    // Bind source through a symlink (a project container could have planted it): refused before docker starts.
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-helper-")));
    try {
      fs.mkdirSync(path.join(tmp, "real"));
      fs.symlinkSync(path.join(tmp, "real"), path.join(tmp, "link"));
      const prior = fd.calls().length;
      await assert.rejects(startHelper({ ...GUT, mounts: [{ type: "bind", source: path.join(tmp, "link"), target: "/src", onlyRead: true }] }), /symlink/);
      await assert.rejects(startHelper({ ...GUT, mounts: [{ type: "bind", source: path.join(tmp, "missing"), target: "/src" }] }), /missing/);
      await assert.rejects(startHelper({ ...GUT, labels: { "cbase.project": "p-1" } }), /helper refused.*never carries the labels/);
      await assert.rejects(startHelper({ ...GUT, mounts: [{ type: "bind", source: `${tmp}/real,src=/`, target: "/src" }] }), /comma/);
      assert.equal(fd.calls().length, prior, "no docker call for a refused helper");
      const ok = await startHelper({ ...GUT, mounts: [{ type: "bind", source: path.join(tmp, "real"), target: "/src", onlyRead: true }] });
      await removeHelper(ok.id);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test("Orphans: restart grace removes by id exactly the helpers of another server run - never its own, never a project or user container", async () => {
  await withFake(async (fd) => {
    const waise = fakeRun(fd, ["run", "-d", "--name", `${HELPER_PREFIX}relocation-alt`, "--network", "none", "--label", `${LABEL_HELPER}=relocation`,
      "--label", "cbase.helper.project=p-1", "--label", "cbase.helper.instance=main", "--label", `${LABEL_HELPER_RUN}=one-old-run`, PROJECTBOX_IMAGE]);
    const ended = fakeRun(fd, ["run", "--name", `${HELPER_PREFIX}clone-alt`, "--label", `${LABEL_HELPER}=clone`, "--label", `${LABEL_HELPER_RUN}=still-one`, PROJECTBOX_IMAGE]);
    const pc = fakeRun(fd, ["run", "-d", "--name", "cbase-p-p-1", "--label", "cbase.project=p-1", "--label", "cbase.instance=main", PROJECTBOX_IMAGE]);
    const user = fakeRun(fd, ["run", "-d", "--name", "db", "--label", "com.docker.compose.project=geo", "postgres:16"]);
    const own = await startHelper(GUT);
    const idEnded = container(fd).find((c) => c.name === `${HELPER_PREFIX}clone-alt`)?.id;
    assert.ok(idEnded && ended === "", "an ended helper (without -d) is in the state");

    const result = await helperRestartGrace();
    assert.deepEqual(result.error, []);
    assert.deepEqual([...result.removed].sort(), [waise, idEnded].sort(), "exactly the two orphans");
    const rms = fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "rm").map((a) => a.args.at(-1));
    assert.ok(rms.every((x) => /^[0-9a-f]{64}$/.test(x)), `by id: ${JSON.stringify(rms)}`);
    const leftOver = container(fd).map((c) => c.id).sort();
    assert.deepEqual(leftOver, [pc, user, own.id].sort(), "project container, user container and the own helper stay");
    await removeHelper(own.id);
  });
});

test("Registration: restart grace calls \"project-helper\" before \"project-instances\" - without the operating mark without docker", async () => {
  await withFake(async (fd) => {
    await withAgentsServer(async () => {
      const seen = [];
      observeHooks((info) => { if (info.kind === "restartGrace" && info.phase === "start") seen.push(info.name); });
      try { await fireHooks("restartGrace", {}); } finally { observeHooks(null); }
      const h = seen.indexOf("project-helper");
      assert.ok(h >= 0, `not registered: ${JSON.stringify(seen)}`);
      assert.ok(h < seen.indexOf("project-instances"), `after \"project-instances\": ${JSON.stringify(seen)}`);
      assert.deepEqual(fd.calls(), [], "without the operating mark no docker call");
    });
  }, { ops: false });
});

test("A user container with cbase.helper ONLY from the image is no helper - restart grace leaves it alone, removeHelper refuses", async () => {
  const IMAGE = "d4".repeat(32);
  await withFake(async (fd) => {
    const user = fakeRun(fd, ["run", "-d", "--name", "tool-1", "tool:1"]);
    const c = container(fd).find((x) => x.id === user);
    assert.equal(c.labels[LABEL_HELPER], "relocation", "the fake docker does not inherit the image's labels");
    // The same key ON the container with another value counts (it was set there): a real orphan.
    const waise = fakeRun(fd, ["run", "-d", "--name", `${HELPER_PREFIX}clone-alt`, "--network", "none", "--label", `${LABEL_HELPER}=clone`,
      "--label", `${LABEL_HELPER_RUN}=one-old-run`, "tool:1"]);
    const result = await helperRestartGrace();
    assert.deepEqual(result.error, [], "a user container is no cleanup error");
    assert.deepEqual(result.removed, [waise]);
    assert.ok(container(fd).some((x) => x.id === user), "the user container is still there");
    assert.ok(!fd.calls({ daemon: "host" }).some((a) => a.args[0] === "rm" && a.args.includes(user)), "rm on the user container");
    await assert.rejects(removeHelper(user), (e) => e.name === "NoHelper" && /inherited only from the image/.test(e.message));
  }, { images: { "tool:1": { id: IMAGE, labels: { [LABEL_HELPER]: "relocation", "cbase.acceptance": "s1-26" } }, [PROJECTBOX_IMAGE]: "e5".repeat(32) } });
});
