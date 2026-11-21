// Test fixture shared by helper-selectors.test.mjs (public) and the maintainer's private suite: the fake-docker state with a
// project container, two real helpers and one helper of the WRONG form, the table of the searches, and the cbase-project runner.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fakeDocker } from "../../../server/backend/test/fake-docker.mjs";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HELPER = pathToFileURL(path.join(REPO, "server/backend/electron/server/projectbox/helper.js")).href;
export const SCRIPT = path.join(REPO, "server/backend/cbase-project");
export const read2 = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

export const PID = "p-real";          // project with project container AND helper (relocation running)
export const PID_ONLY = "p-only-helper"; // project with only a helper (relocation before creation)
export const PID_WRONG = "p-wrong"; // the helper of the wrong form

// Every search for project containers: file, wording, the docker args derived from it. `pid` only where the search names a project.
export const SELECTORS = [
  { location: "server/backend/entry.sh — stop without network detach", file: "server/backend/entry.sh", pattern: /ps_ids=\$\(docker (ps -q --filter label=cbase\.project)\)/, args: (m) => m[1].split(" ") },
  { location: "server/gateway/containers.js — stop before rm -f", file: "server/gateway/containers.js", pattern: /ids=\$\(own "\$\(docker (ps -q --filter label=cbase\.project)\)"\)/, args: (m) => m[1].split(" ") },
  {
    location: "projectbox/serverEnd.js — stop at server end", file: "server/backend/electron/server/projectbox/serverEnd.js",
    pattern: /export const PROJECT_LABEL = "([^"]+)";[\s\S]*docker\(\["ps", "-q", "--filter", `label=\$\{PROJECT_LABEL\}`\]\)/, args: (m) => ["ps", "-q", "--filter", `label=${m[1]}`],
  },
  {
    location: "projectbox/erase.js — plan of the erase path", file: "server/backend/electron/server/projectbox/erase.js", pid: true,
    pattern: /filter: `label=\$\{LABEL_PROJECT\}=\$\{pid\}`/, args: (m, pid) => ["ps", "-a", "-q", "--no-trunc", "--filter", `label=cbase.project=${pid}`],
    beforehand: () => assert.match(read2("server/backend/electron/server/projectbox/creation.js"), /export const LABEL_PROJECT = "cbase\.project";/),
  },
  { location: "tools/check/lib/projectbox-scripts.mjs — images of the project containers", file: "tools/check/lib/projectbox-scripts.mjs", pattern: /"read_part PROJECTS list_all (--filter label=cbase\.project)"/, args: (m) => ["ps", "-a", "-q", "--no-trunc", ...m[1].split(" ")] },
  {
    location: "server/backend/cbase-project — fallback without backend", file: "server/backend/cbase-project", pid: true,
    // The ONE search `containerTheInstance` (main without backend and copy `<project>/<copy>`); the main one is asked.
    pattern: /const LABEL_PROJECT = "([^"]+)";\nconst LABEL_INSTANCE = "([^"]+)";[\s\S]*\["ps", "-a", "-q", "--no-trunc", "--filter", `label=\$\{LABEL_PROJECT\}=\$\{projectId\}`, "--filter", `label=\$\{LABEL_INSTANCE\}=\$\{instance\}`\]/,
    args: (m, pid) => ["ps", "-a", "-q", "--no-trunc", "--filter", `${"label="}${m[1]}=${pid}`, "--filter", `label=${m[2]}=main`],
  },
];


export async function withBuild(fn) {
  const fd = await fakeDocker();
  const old = { C: process.env.CBASE_CONTAINER, D: process.env.CBASE_DIND, B: process.env.CBASE_DOCKER_BIN };
  const run = (args) => {
    const r = spawnSync(fd.bin, args, { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    process.env.CBASE_CONTAINER = "1";
    process.env.CBASE_DIND = "1";
    process.env.CBASE_DOCKER_BIN = fd.bin;
    const helper = await import(HELPER);
    const pc = run(["run", "-d", "--name", `cbase-p-${PID}`, "--label", `cbase.project=${PID}`, "--label", "cbase.instance=main", "--mount", `type=bind,source=${os.tmpdir()},target=/project`, "cbase-projectbox:latest"]);
    const user = run(["run", "-d", "--name", "db", "--label", "com.docker.compose.project=geo", "postgres:16"]);
    const h1 = await helper.startHelper({ kind: "relocation", projectId: PID, mounts: [{ type: "volume", source: "geo_pgdata", target: "/src", onlyRead: true }], labels: { "cbase.relocation": "1" } });
    const h2 = await helper.startHelper({ kind: "relocation", projectId: PID_ONLY, mounts: [{ type: "bind", source: fs.realpathSync(os.tmpdir()), target: fs.realpathSync(os.tmpdir()) }] });
    // The helper of the WRONG form, bypassing helper.js (its check would not allow it): with the labels of the project containers.
    const wrong = run(["run", "-d", "--name", "cbase-helper-clone-wrong", "--network", "none", "--label", "cbase.helper=clone",
      "--label", `cbase.project=${PID_WRONG}`, "--label", "cbase.instance=main", "--mount", `type=bind,source=${os.tmpdir()},target=/project`, "cbase-projectbox:latest"]);
    await fn({ fd, run, pc, user, real: [h1.id, h2.id], wrong, helper });
    await helper.removeHelper(h1.id);
    await helper.removeHelper(h2.id);
  } finally {
    for (const [k, v] of [["CBASE_CONTAINER", old.C], ["CBASE_DIND", old.D], ["CBASE_DOCKER_BIN", old.B]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fd.cleanUp();
  }
}

// Full ids from the output of a `ps -q` (shortened or not) against the full ids of the state.
const full = (stdout, all) => String(stdout).split(/\s+/).filter(Boolean).map((k) => all.find((id) => id.startsWith(k)) || k);

// One search against the state of withBuild: hits the project container and no helper; the helper of the wrong form is hit.
export async function checkSelectors(selectors) {
  await withBuild(async ({ fd, pc, user, real, wrong }) => {
    const all = Object.keys(fd.state("host").container);
    for (const s of selectors) {
      s.beforehand?.();
      const m = s.pattern.exec(read2(s.file));
      assert.ok(m, `${s.location}: the search no longer stands like this in ${s.file} — update the table (and check whether it hits a helper)`);
      const question = (pid) => {
        const r = spawnSync(fd.bin, s.args(m, pid), { encoding: "utf8" });
        assert.equal(r.status, 0, `${s.location}: ${r.stderr}`);
        return full(r.stdout, all);
      };
      if (s.pid) {
        assert.deepEqual(question(PID), [pc], `${s.location}: project with container and helper`);
        assert.deepEqual(question(PID_ONLY), [], `${s.location}: a project with only a helper has no project container`);
        assert.deepEqual(question(PID_WRONG), [wrong], `${s.location}: counter-test — the helper of the wrong form is hit`);
      } else {
        const ids = question();
        assert.ok(ids.includes(pc), `${s.location}: the project container is missing`);
        for (const h of real) assert.ok(!ids.includes(h), `${s.location}: hits the helper ${h.slice(0, 12)}`);
        assert.ok(!ids.includes(user), `${s.location}: hits a user container`);
        assert.ok(ids.includes(wrong), `${s.location}: counter-test — the helper of the wrong form is NOT hit, the check would have no teeth`);
      }
    }
  });
}

export async function deadPort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
export function start(args, env) {
  const subprocess = spawn(process.execPath, [SCRIPT, ...args], { cwd: os.tmpdir(), env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  subprocess.stdout.on("data", (b) => { out += b; });
  subprocess.stderr.on("data", (b) => { err += b; });
  return new Promise((resolve) => subprocess.once("close", (code) => resolve({ code, out, err })));
}

