// Guards for the operating mark and the docker seam of the project containers.
//
// Four promises, each with the way that breaks it:
//   (1) projectboxOps() is true EXACTLY WHEN CBASE_CONTAINER and CBASE_DIND are both "1" - read at run time (matrix over
//       set/"0"/"true"/empty/unset, switched AFTER the import).
//   (2) Without operation projectbox/docker.js starts no child: the fake docker's call log stays EMPTY (the counter-proof of
//       every later integration test). With operation the call is in it - otherwise the empty log would only prove that the
//       fake was never asked.
//   (3) Every docker call under server/backend/electron goes through projectbox/docker.js. An `execFile("docker"`,
//       `spawn("docker"`, `exec("docker ...` (shell string), also through a variable (`const bin = "docker";
//       execFile(bin, ...)`), or a grab at CBASE_DOCKER_BIN outside of it is red unless it is in DOCKER_CALLS_ALLOWED (the
//       form of `CYCLES_ALLOWED` from import-direction.test.js: file, function, count, reason, follow-up job, printed on every
//       run; a hit without an entry is red, an entry without a hit too, a different count too). Built-in sabotage: copies of
//       the real tree with an additional, a missing and a multi-line call.
//   (4) The fake docker reproduces what later tickets build on: the pool overlap, the orphan of a killed exec caller, the
//       daemon in the container (dockerIn), the gate at `stop`, the cap.
// No deadline: waiting is on files and events (a tick in the loop), never on a duration.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { projectboxOps, ONLY_IN_OPS } from "../electron/server/projectbox/ops.js";
import { advanceCap, docker, dockerIn, DockerError } from "../electron/server/projectbox/docker.js";
import { fakeDocker, hostPort, WRAPPER_IN_IMAGE, WRAPPER_IN_REPO, secondLoopback } from "./fake-docker.mjs";
import { RIPCORD_MS } from "./ripcord.mjs";

const TESTDIR = path.dirname(new URL(import.meta.url).pathname);
const ELECTRON = path.resolve(TESTDIR, "..", "electron");
const SEAM = "server/projectbox/docker.js";

const MARKERS = ["CBASE_CONTAINER", "CBASE_DIND", "CBASE_DOCKER_BIN"];
// Sets the marks (undefined = unset) for the duration of fn and restores the old state in the finally.
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(MARKERS.map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}
const inOps = (fd, fn) => withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin }, fn);

// Waiting for an event without a deadline: the tick is a look interval, not a limit.
async function waitForTruthy(check) {
  for (;;) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ── (1) the marks ────────────────────────────────────────────────────────────────────────────

test("Operating mark: true exactly when CBASE_CONTAINER and CBASE_DIND are both \"1\" - read at run time", async () => {
  const values = [undefined, "1", "0", "true", ""];
  const rows = [];
  for (const c of values) {
    for (const d of values) {
      const actual = await withEnvironment({ CBASE_CONTAINER: c, CBASE_DIND: d }, () => projectboxOps());
      rows.push(`${JSON.stringify(c)}×${JSON.stringify(d)}=${actual}`);
      assert.equal(actual, c === "1" && d === "1", `CONTAINER=${JSON.stringify(c)} DIND=${JSON.stringify(d)}`);
    }
  }
  // Switched AFTER the import: a constant frozen at load time would stay here.
  await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: undefined }, async () => {
    assert.equal(projectboxOps(), false);
    process.env.CBASE_DIND = "1";
    assert.equal(projectboxOps(), true);
  });
  assert.equal(ONLY_IN_OPS, "only in server mode");
  console.log(`[projectbox-ops] matrix: ${rows.filter((z) => z.endsWith("true")).length} of ${rows.length} true`);
});

// ── (2) without operation no docker ──────────────────────────────────────────────────────────────

test("Docker seam: without operation no child starts (log empty), with operation the call is in it", async () => {
  const fd = await fakeDocker();
  try {
    for (const [c, d] of [[undefined, undefined], ["1", undefined], [undefined, "1"], ["1", "0"]]) {
      await withEnvironment({ CBASE_CONTAINER: c, CBASE_DIND: d, CBASE_DOCKER_BIN: fd.bin }, async () => {
        await assert.rejects(docker(["ps", "-a", "--format", "json"]), (e) => e instanceof DockerError && e.code === "NO_OPS");
        await assert.rejects(dockerIn("p1", ["ps"]), (e) => e.code === "NO_OPS");
      });
    }
    assert.deepEqual(fd.calls(), [], "without operation the fake docker must never have been started");
    // Counter-proof: the same calls WITH operation reach the fake - so the empty log above is a statement.
    await inOps(fd, async () => {
      const { stdout } = await docker(["ps", "-a", "--format", "json"]);
      assert.equal(stdout, "");
    });
    assert.deepEqual(fd.calls(), [{ daemon: "host", args: ["ps", "-a", "--format", "json"] }]);
  } finally {
    fd.cleanUp();
  }
});

test("Docker seam: never a shell string - args is an array of strings, otherwise nothing starts", async () => {
  const fd = await fakeDocker();
  try {
    await inOps(fd, async () => {
      for (const wrong of ["ps -a", [], ["ps", 3], null]) {
        await assert.rejects(docker(wrong), TypeError);
      }
      await assert.rejects(dockerIn("-e", ["ps"]), TypeError);
      await assert.rejects(dockerIn("", ["ps"]), TypeError);
    });
    assert.deepEqual(fd.calls(), []);
  } finally {
    fd.cleanUp();
  }
});

// ── (3) the grep guard ───────────────────────────────────────────────────────────────────────

/**
 * The named list of docker calls outside the seam. Each row: file (relative to server/backend/electron), the top-level
 * function the call is in, how many there are, WHY it does not (yet) go through the seam and WHO converts it. If a count
 * grows or shrinks, the test is red.
 */
const DOCKER_CALLS_ALLOWED = [
  // The four former entries (dockerContainer, dockerStats, stopService, tailLogAny) are merged into the ONE call
  // `localDocker`; a converted project goes through the seam (services.js, section "Services in the project container"), and
  // only the way WITHOUT an instance calls the docker of B or the local server.
  {
    file: "server/services.js", fn: "localDocker", count: 1,
    reason: "`docker ps -a` (state), `docker stats` (resources), `docker stop` (stop) and `docker logs` (log) of the container services of a NOT converted project against the daemon of the user container or the docker of a backend without the operating mark - without the mark the seam would reject it. A converted project asks the daemon of its project container through projectbox/docker.js.",
    followUpJob: "none - stays as long as there are projects without an instance and backends without the operating mark",
  },
];

/** All source files under server/backend/electron (without node_modules): [{ path, text }], path posix and relative. */
function sourceFiles(root = ELECTRON) {
  const out = [];
  const run = (dir) => {
    for (const n of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (n.name === "node_modules") continue;
      const abs = path.join(dir, n.name);
      if (n.isDirectory()) run(abs);
      else if (/\.(c|m)?js$/.test(n.name)) out.push({ path: path.relative(root, abs).split(path.sep).join("/"), text: fs.readFileSync(abs, "latin1") });
    }
  };
  run(root);
  return out;
}

// A docker call: a child-process call whose first argument begins with "docker" (also as a shell string and across lines),
// or a grab at the seam's binary. The text is read as latin1 - the same as `grep -a` does: grep would take a few server
// files for binary and silently report nothing.
const DOCKER_CALL = /\b(?:execFile|execFileSync|spawn|spawnSync|exec|execSync|fork)\(\s*(["'`])docker\b|\bCBASE_DOCKER_BIN\b/g;
// Comment lines do not count (the same rule as clock-counts.test.js): a commented-out line starts no child.
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;
const FUNCTION_TOP = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/;

// A binary in a VARIABLE (`const bin = "docker"; execFile(bin, ...)`, also `let cmd = "docker ps"` and a later assignment).
// Every binding whose right side carries a literal "docker..." makes its name in the SAME file a docker binary - as a VALUE:
// at the start of the right side or as fallback/branch (`... || "docker"`, `??`, `? "docker" : ...`), not as a comparison
// (`x === "docker"`). A child-process call with exactly this name as first argument counts like the literal (`bin.path` or
// `bin(` does not). A same-named name in another function of the same file counts too - an error in the safe direction: it
// turns red and gets looked at, never silent. Not detected: the binary in an object field (`{ bin: "docker" }`) or through a
// detour via a second variable.
const KIND_CALL = "(?:execFile|execFileSync|spawn|spawnSync|exec|execSync|fork)";
const DOCKER_VALUE = /(?:^|\|\||\?\?|[?:])\s*(["'`])docker\b/;
const BINDING = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?<![=!<>+\-*\/%&|^?])=(?![=>])([^;\n]*)/g;
function dockerVariables(text, rows, rowOf) {
  const names = new Set();
  for (const m of text.matchAll(BINDING)) {
    if (COMMENT.test(rows[rowOf(m.index)])) continue;
    if (DOCKER_VALUE.test(m[2].trim())) names.add(m[1]);
  }
  if (!names.size) return null;
  const old = [...names].map((n) => n.replace(/\$/g, "\\$")).join("|");
  return new RegExp(`\\b${KIND_CALL}\\(\\s*(?:${old})\\b(?!\\s*[.(\\[])`, "g");
}

/** The hits outside the seam: Map "file#function" => { file, fn, count, rows } */
function dockerCalls(files) {
  const hits = new Map();
  for (const { path: filePath, text } of files) {
    if (filePath === SEAM) continue;
    const rows = text.split("\n");
    const beginnings = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") beginnings.push(i + 1);
    const rowOf = (index) => {
      let row = 0;
      while (row + 1 < beginnings.length && beginnings[row + 1] <= index) row++;
      return row;
    };
    const overVariable = dockerVariables(text, rows, rowOf);
    for (const m of [...text.matchAll(DOCKER_CALL), ...(overVariable ? text.matchAll(overVariable) : [])]) {
      const row = rowOf(m.index);
      if (COMMENT.test(rows[row])) continue;
      let fn = "(module level)";
      for (let k = row; k >= 0; k--) {
        const f = rows[k].match(FUNCTION_TOP);
        if (f) { fn = f[1]; break; }
      }
      const key = `${filePath}#${fn}`;
      if (!hits.has(key)) hits.set(key, { file: filePath, fn, count: 0, rows: [] });
      const t = hits.get(key);
      t.count++;
      t.rows.push(row + 1);
    }
  }
  return hits;
}

function dockerViolations(hits, allowed) {
  const v = [];
  const list = new Map(allowed.map((e) => [`${e.file}#${e.fn}`, e]));
  for (const [k, t] of hits) {
    const e = list.get(k);
    if (!e) v.push(`NEW docker call ${t.file} in ${t.fn} (line ${t.rows.join(", ")}) - no entry: go through projectbox/docker.js or add it with reason and follow-up job to DOCKER_CALLS_ALLOWED`);
    else if (e.count !== t.count) v.push(`${k}: ${t.count} call(s) instead of ${e.count} (line ${t.rows.join(", ")})`);
  }
  for (const [k] of list) if (!hits.has(k)) v.push(`Entry without call ${k} - converted? Then remove the entry`);
  return v;
}

test("Docker seam: every docker call under server/backend/electron goes through projectbox/docker.js - except the named list", () => {
  const files = sourceFiles();
  assert.ok(files.some((d) => d.path === SEAM), `${SEAM} is missing - the guard searches in the wrong place`);
  assert.ok(files.some((d) => d.path === "server/services.js"), "server/services.js is missing - the guard searches in the wrong place");
  const hits = dockerCalls(files);
  // Printed on EVERY run: a silent exception list cannot be told from a forgotten one.
  for (const e of DOCKER_CALLS_ALLOWED) {
    console.log(`[projectbox-ops] docker call allowed ${e.file}#${e.fn} (${e.count}x): ${e.reason} FOLLOW-UP: ${e.followUpJob}`);
  }
  const sum = [...hits.values()].reduce((n, t) => n + t.count, 0);
  console.log(`[projectbox-ops] measured: ${sum} docker call(s) outside the seam in ${hits.size} function(s) across ${files.length} files`);
  assert.deepEqual(dockerViolations(hits, DOCKER_CALLS_ALLOWED), []);
});

test("Docker seam, built-in sabotage: an additional, a missing, a multiplied and a hidden call are red", () => {
  const real = sourceFiles();
  const including = (filePath, text) => [...real.filter((d) => d.path !== filePath), { path: filePath, text }];
  const services = real.find((d) => d.path === "server/services.js").text;
  const one = (files) => dockerViolations(dockerCalls(files), DOCKER_CALLS_ALLOWED);

  // An additional call in a file without an entry: NEW.
  const addition = one(including("server/projects/sabotage.js", 'import { execFile } from "node:child_process";\nexport function foreign() {\n  execFile("docker", ["ps"], () => {});\n}\n'));
  assert.equal(addition.length, 1);
  assert.match(addition[0], /^NEW docker call server\/projects\/sabotage\.js in foreign \(line 3\)/);
  // Single quotes, spawn, the shell string, the line break after the bracket, the seam's binary - every spelling is a call.
  for (const body of [
    "spawn('docker', ['run'])",
    "exec(`docker network create x`)",
    "execSync(\"docker ps\")",
    "execFile(\n    \"docker\", [\"ps\"])",
    "spawn(process.env.CBASE_DOCKER_BIN || \"docker\", [\"ps\"])",
    // the binary in a variable - declared, as shell string, assigned late, with $ in the name, across lines
    "const bin = \"docker\";\n  execFile(bin, [\"ps\"], () => {})",
    "let cmd = `docker network ls`;\n  exec(cmd)",
    "let b;\n  b = 'docker';\n  spawnSync(b, ['ps'])",
    "const $d = \"docker\";\n  spawn(\n    $d, [\"ps\"])",
    "const bin = process.env.MY_DOCKER || \"docker\";\n  execFileSync(bin, [\"info\"])",
  ]) {
    const v = one(including("server/projects/sabotage.js", `export async function foreign() {\n  ${body};\n}\n`));
    assert.equal(v.length, 1, `not detected: ${body}`);
  }
  // A missing call: the call in localDocker is dropped - the entry stands there without cause (the ONE entry).
  const withoutLocal = services.replace(/execFile\("docker", args, opts, cb\)/, 'execFile("dockr", args, opts, cb)');
  assert.notEqual(withoutLocal, services, "the sabotage replaced nothing");
  assert.deepEqual(one(including("server/services.js", withoutLocal)), ["Entry without call server/services.js#localDocker - converted? Then remove the entry"]);
  // A second call in an allowed function: the count no longer matches.
  const duplicate = services.replace(/(return execFile\("docker", args, opts, cb\);\n)/, "  execFile(\"docker\", [\"kill\", args[1]], () => {});\n$1");
  assert.notEqual(duplicate, services, "the sabotage replaced nothing");
  const v2 = one(including("server/services.js", duplicate));
  assert.equal(v2.length, 1);
  assert.match(v2[0], /^server\/services\.js#localDocker: 2 call\(s\) instead of 1/);
  // An own docker call back in one of the four old functions (past localDocker) is NEW.
  const back = services.replace(/(function dockerStats\(\) \{\n)/, "$1  execFile(\"docker\", [\"stats\"], () => {});\n");
  assert.notEqual(back, services, "the sabotage replaced nothing");
  const v3 = one(including("server/services.js", back));
  assert.equal(v3.length, 1);
  assert.match(v3[0], /^NEW docker call server\/services\.js in dockerStats/);
  // The other direction: a variable that does NOT carry docker, a field of the variable, a comparison and a commented-out
  // binding are no call.
  for (const body of [
    "const bin = \"git\";\n  execFile(bin, [\"status\"])",
    "const bin = \"docker\";\n  execFile(bin.path, [\"ps\"])",
    "const kind = x === \"docker\";\n  spawn(art ? \"a\" : \"b\")",
    "// const bin = \"docker\";\n  const bin = \"git\";\n  execFile(bin, [\"log\"])",
  ]) {
    assert.deepEqual(one(including("server/projects/sabotage.js", `export async function foreign() {\n  ${body};\n}\n`)), [], `falsely detected: ${body}`);
  }
  // The seam itself never counts; a commented-out line does not either.
  assert.deepEqual(one(including(SEAM, 'execFile("docker", ["ps"]); const b = process.env.CBASE_DOCKER_BIN;\n')), []);
  assert.deepEqual(one(including("server/projects/sabotage.js", '// execFile("docker", ["ps"]);\n * spawn("docker")\n')), []);
});

// ── (4) the fake docker ────────────────────────────────────────────────────────────────────

test("Fake: pool overlap like the real docker - against occupied networks and against own ones", async () => {
  const fd = await fakeDocker({ occupiedNetworks: ["10.200.0.0/16"] });
  try {
    await inOps(fd, async () => {
      const { stdout } = await docker(["network", "create", "--subnet", "10.201.0.0/24", "--label", "cbase.project=1", "cbase-p-1"]);
      assert.match(stdout.trim(), /^[0-9a-f]{64}$/);
      for (const [subnet, name] of [["10.200.5.0/24", "foreign"], ["10.201.0.128/25", "own"]]) {
        await assert.rejects(docker(["network", "create", "--subnet", subnet, name]), (e) => {
          assert.equal(e.code, 1);
          assert.match(e.stderr, /Pool overlaps with other one on this address space/);
          assert.match(e.message, /Pool overlaps/);
          return true;
        });
      }
      await assert.rejects(docker(["network", "create", "cbase-p-1"]), /already exists/);
      const [network] = JSON.parse((await docker(["network", "inspect", "cbase-p-1"])).stdout);
      assert.deepEqual(network.IPAM.Config, [{ Subnet: "10.201.0.0/24" }]);
      assert.deepEqual(network.Labels, { "cbase.project": "1" });
    });
  } finally {
    fd.cleanUp();
  }
  // Counter-proof: without an occupied network the same subnet goes through - so the message above comes from the overlap.
  const free = await fakeDocker();
  try {
    await inOps(free, () => docker(["network", "create", "--subnet", "10.200.5.0/24", "foreign"]));
  } finally {
    free.cleanUp();
  }
});

test("Fake: a killed exec caller does not end its process - only stop does", async () => {
  const fd = await fakeDocker();
  const pidFile = path.join(fd.dir, "orphan.pid");
  let caller = null;
  try {
    await inOps(fd, () => docker(["run", "-d", "--name", "p1", "cbase-projectbox:test"]));
    const script = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1 << 30);`;
    caller = spawn(fd.bin, ["exec", "-u", "agent", "p1", process.execPath, "-e", script], { stdio: "ignore" });
    const pid = Number(await waitForTruthy(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8")));
    assert.notEqual(pid, caller.pid, "the command runs as its own process, not as the caller");
    // Leader of its own group like a process in the container - a signal to the caller's group would not hit it.
    assert.equal(Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim()), pid);
    caller.kill("SIGKILL");
    await once(caller, "exit");
    caller = null;
    assert.equal(alive(pid), true, "the process died with its caller - the real docker does not do that");
    // Counter-proof: stop ends it (the stop chain builds on it).
    await inOps(fd, () => docker(["stop", "p1"]));
    await waitForTruthy(() => !alive(pid));
    const [c] = JSON.parse((await inOps(fd, () => docker(["inspect", "p1"]))).stdout);
    assert.equal(c.State.Status, "exited");
  } finally {
    if (caller) caller.kill("SIGKILL");
    fd.cleanUp();
  }
});

test("Fake: dockerIn talks to the daemon OF the container - own state, own log", async () => {
  const fd = await fakeDocker();
  try {
    await inOps(fd, async () => {
      await docker(["run", "-d", "--name", "cbase-p-7", "--label", "cbase.project=7", "cbase-projectbox:test"]);
      await dockerIn("cbase-p-7", ["network", "create", "inside"]);
      const { stdout } = await dockerIn("cbase-p-7", ["network", "inspect", "--format", "{{.Name}}", "inside"]);
      assert.equal(stdout, "inside\n");
      // Not running: the user container's daemon rejects before anything starts in the container.
      await docker(["stop", "cbase-p-7"]);
      await assert.rejects(dockerIn("cbase-p-7", ["ps"]), /is not running/);
    });
    assert.deepEqual(fd.calls({ daemon: "cbase-p-7" }).map((a) => a.args), [["network", "create", "inside"], ["network", "inspect", "--format", "{{.Name}}", "inside"]]);
    assert.deepEqual(fd.calls({ daemon: "host" })[1].args, ["exec", "-u", "agent", "cbase-p-7", "docker", "network", "create", "inside"]);
    assert.deepEqual(Object.values(fd.state("cbase-p-7").networks).map((n) => n.name), ["inside"]);
    assert.deepEqual(Object.values(fd.state("host").networks), []);
  } finally {
    fd.cleanUp();
  }
});

test("Fake: stop waits at the gate; the seam's cap aborts and says that it is one", async () => {
  const fd = await fakeDocker({ stopGate: "stop" });
  try {
    await inOps(fd, async () => {
      await docker(["run", "-d", "--name", "p1", "img"]);
      const stop = docker(["stop", "p1"]);
      await fd.gateReached("stop");
      assert.deepEqual(Object.values(fd.state().container).map((c) => c.status), ["running"], "nothing is stopped before the gate");
      fd.openGate("stop");
      assert.equal((await stop).stdout, "p1\n");
      assert.deepEqual(Object.values(fd.state().container).map((c) => c.status), ["exited"]);
    });
  } finally {
    fd.cleanUp();
  }
  // The cap: a stop whose gate never opens never ends by itself - without a cap the call would hang for ever. The number is
  // no criterion: the test only turns red if the cap does NOT take hold.
  const to = await fakeDocker({ stopGate: "never" });
  try {
    await inOps(to, async () => {
      await docker(["run", "-d", "--name", "p1", "img"]);
      await assert.rejects(docker(["stop", "p1"], { capMs: 200 }), (e) => {
        assert.equal(e.code, "CAP");
        assert.match(e.message, /cap of 200 ms reached/);
        return true;
      });
    });
  } finally {
    to.cleanUp();
  }
});

// The seam's default cap (120 s) is estimated, not measured - its message says so, so that a hit in operation is recognisable
// as a reason to measure. An own cap does not say it. Forced through the clock seam `advanceCap` (no duration): the `stop`
// hangs at the gate that never opens.
test("A call's cap WITHOUT an own capMs calls itself the seam's estimated default - an own one does not", async () => {
  const fd = await fakeDocker({ stopGate: "never" });
  try {
    await inOps(fd, async () => {
      await docker(["run", "-d", "--name", "p1", "img"]);
      const preset = docker(["stop", "p1"]);
      await fd.gateReached("never");
      assert.equal(advanceCap(), 1);
      await assert.rejects(preset, (e) => {
        assert.equal(e.code, "CAP");
        assert.match(e.message, /^docker stop: cap of 120000 ms \(seam default, estimated, not measured\) reached — aborted/);
        return true;
      });
      const own = docker(["stop", "p1"], { capMs: 3_600_000 });
      assert.equal(advanceCap(), 1);
      await assert.rejects(own, (e) => {
        assert.equal(e.code, "CAP");
        assert.match(e.message, /^docker stop: cap of 3600000 ms reached — aborted/);
        return true;
      });
    });
  } finally {
    fd.cleanUp();
  }
});

// The cap on the collected output. A docker program that writes 2 MiB (stdout or stderr), against a cap of 1 MiB - per call
// (`maxBytes`) and through the knob. Built-in counter-proof: with `stdoutFile` stdout does not count, the 2 MiB are in the
// file; under the cap everything arrives. COUNTER-TEST on the product: docker.js with `if (counted <= capBytes) return true;`
// => `return true;` => red (the 2 MiB came back).
test("docker() caps the collected output - maxBytes and knob, SIGKILL and code OUTPUT; with stdoutFile stdout does not count", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-docker-output-"));
  const bin = path.join(dir, "docker");
  fs.writeFileSync(bin, "#!/bin/sh\nif [ \"$1\" = err ]; then head -c 2097152 /dev/zero | tr '\\000' y >&2; exit 0; fi\nhead -c 2097152 /dev/zero | tr '\\000' x\n", { mode: 0o755 });
  const MIB = 1024 * 1024;
  const saved = process.env.CBASE_DOCKER_OUTPUT_BYTES;
  try {
    await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: bin }, async () => {
      delete process.env.CBASE_DOCKER_OUTPUT_BYTES;
      const check = (e) => {
        assert.ok(e instanceof DockerError, String(e));
        assert.equal(e.code, "OUTPUT");
        assert.match(e.message, /cap of 1048576 bytes/);
        assert.match(e.message, /CBASE_DOCKER_OUTPUT_BYTES/);
        return true;
      };
      await assert.rejects(docker(["out"], { maxBytes: MIB }), check);
      await assert.rejects(docker(["err"], { maxBytes: MIB }), check);
      process.env.CBASE_DOCKER_OUTPUT_BYTES = String(MIB);
      await assert.rejects(docker(["out"]), (e) => check(e) && /seam default, estimated, not measured/.test(e.message));
      // Counter-proofs: into the file stdout does not count; under the cap everything arrives.
      const file = path.join(dir, "out");
      const r = await docker(["out"], { stdoutFile: file });
      assert.equal(r.stdout, "");
      assert.equal(fs.statSync(file).size, 2 * MIB);
      delete process.env.CBASE_DOCKER_OUTPUT_BYTES;
      assert.equal((await docker(["out"], { maxBytes: 3 * MIB })).stdout.length, 2 * MIB);
      assert.equal((await docker(["out"])).stdout.length, 2 * MIB, "the default (64 MiB) rejected 2 MiB");
      await assert.rejects(docker(["out"], { maxBytes: 0 }), TypeError);
    });
  } finally {
    if (saved === undefined) delete process.env.CBASE_DOCKER_OUTPUT_BYTES; else process.env.CBASE_DOCKER_OUTPUT_BYTES = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// What the fake docker does not reproduce, it says loudly (125) - never a silent success. The fake wording stays German.
// Without a command `run` stays the one-shot container that ends at once with 0 (the seed in projectbox-server-end.test.js).
test("run without -d with a command and network connect/disconnect are 125, never a silent success; without a command an ended container", async () => {
  const fd = await fakeDocker();
  try {
    await inOps(fd, async () => {
      await assert.rejects(docker(["run", "--rm", "img", "sh", "-c", "echo hello"]), (e) => {
        assert.equal(e.code, 125);
        assert.match(e.message, /run without -d with a command \(sh -c echo hello\) is not replicated/);
        return true;
      });
      await assert.rejects(docker(["run", "--name", "once2", "img", "true"]), (e) => e.code === 125);
      assert.equal((await docker(["run", "--name", "once", "img"])).stdout, "", "without -d no id on stdout");
      await docker(["network", "create", "n1"]);
      await docker(["run", "-d", "--name", "p1", "img"]);
      for (const what of ["connect", "disconnect"]) {
        await assert.rejects(docker(["network", what, "n1", "p1"]), (e) => e.code === 125 && /not replicated/.test(e.message), what);
      }
    });
    const container = Object.values(fd.state().container).map((c) => [c.name, c.status, c.exitCode]).sort();
    assert.deepEqual(container, [["once", "exited", 0], ["p1", "running", 0]], "a rejected run creates no container");
  } finally {
    fd.cleanUp();
  }
});

test("Fake: run refuses -p, -P, --publish, -v and --network host; a missing bind source is an error", async () => {
  const fd = await fakeDocker();
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-fake-source-"));
  try {
    await inOps(fd, async () => {
      for (const flags of [["-p", "8080:80"], ["-P"], ["--publish=8080:80"], ["-v", "/a:/b"], ["--network", "host"], ["--nonexistent"]]) {
        await assert.rejects(docker(["run", "-d", ...flags, "img"]), (e) => e.code === 125, flags.join(" "));
      }
      await assert.rejects(docker(["run", "-d", "--mount", "type=bind,source=/exists/es/not,target=/x", "img"]), /bind source path does not exist/);
      await docker(["network", "create", "--subnet", "10.210.3.0/24", "network3"]);
      const id = (await docker(["run", "-d", "--name", "p3", "--network", "network3", "--mount", `type=bind,source=${source},target=/w,readonly`, "img"])).stdout.trim();
      const [c] = JSON.parse((await docker(["inspect", id])).stdout);
      assert.deepEqual(c.Mounts, [{ Type: "bind", Source: source, Destination: "/w", RW: false }]);
      assert.match(c.NetworkSettings.Networks.network3.IPAddress, /^10\.210\.3\.\d+$/);
      await assert.rejects(docker(["run", "-d", "--name", "p3", "img"]), /Conflict/);
    });
    assert.equal(Object.keys(fd.state().container).length, 1, "a refused run creates no container");
  } finally {
    fd.cleanUp();
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test("Fake: ps -a --format json with labels and filter; rm by id, a running one only with -f", async () => {
  const fd = await fakeDocker();
  try {
    await inOps(fd, async () => {
      const a = (await docker(["run", "-d", "--name", "cbase-p-1", "--label", "cbase.project=1", "img"])).stdout.trim();
      await docker(["run", "-d", "--name", "foreign", "img"]);
      await docker(["stop", "foreign"]);
      const rows = (await docker(["ps", "-a", "--format", "json"])).stdout.trim().split("\n").map((z) => JSON.parse(z));
      assert.deepEqual(rows.map((z) => [z.Names, z.State]), [["foreign", "exited"], ["cbase-p-1", "running"]]);
      assert.equal(rows[1].ID, a.slice(0, 12));
      assert.equal(rows[1].Labels, "cbase.project=1");
      assert.equal((await docker(["ps", "-a", "--filter", "label=cbase.project", "--format", "{{.Names}}"])).stdout, "cbase-p-1\n");
      assert.equal((await docker(["ps", "--format", "{{.Names}}"])).stdout, "cbase-p-1\n", "without -a only running ones");
      await assert.rejects(docker(["rm", a]), /container is running/);
      await docker(["rm", "-f", a]);
      await assert.rejects(docker(["inspect", a]), (e) => e.code === 1 && /No such object/.test(e.stderr));
    });
  } finally {
    fd.cleanUp();
  }
});

test("Fake: image inspect/save/load - load reads a stream over stdin", async () => {
  const source = await fakeDocker({ images: { "cbase-projectbox:cand-1": "ab12" } });
  const target = await fakeDocker();
  const file = path.join(source.dir, "image.tar");
  try {
    await inOps(source, async () => {
      const [b] = JSON.parse((await docker(["image", "inspect", "cbase-projectbox:cand-1"])).stdout);
      assert.equal(b.Id, "sha256:ab12");
      await docker(["image", "save", "-o", file, "cbase-projectbox:cand-1"]);
    });
    await inOps(target, async () => {
      await assert.rejects(docker(["image", "inspect", "cbase-projectbox:cand-1"]), /No such image/);
      const { stdout } = await docker(["image", "load"], { stdin: fs.createReadStream(file) });
      assert.equal(stdout, "Loaded image: cbase-projectbox:cand-1\n");
      assert.equal((await docker(["image", "inspect", "--format", "{{.Id}}", "cbase-projectbox:cand-1"])).stdout, "sha256:ab12\n");
    });
  } finally {
    source.cleanUp();
    target.cleanUp();
  }
});

test("docker(): text and buffer stdin go through kind-stdin.js; a child that never reads stdin is a verdict, no EPIPE crash", async () => {
  const fd = await fakeDocker();
  // A docker that ends at once with 3 without reading stdin - 8 MB fit in no pipe buffer, the write attempt runs into EPIPE.
  // docker.js used to write raw (`kind.stdin.end(stdin)`, guard stdin-epipe.test.js).
  const silent = path.join(fd.dir, "docker-silent.sh");
  fs.writeFileSync(silent, "#!/bin/sh\necho 'broken' >&2\nexit 3\n", { mode: 0o755 });
  const unhandled = [];
  const fang = (e) => unhandled.push(e);
  process.on("uncaughtException", fang);
  try {
    await inOps(fd, async () => {
      const image = JSON.stringify({ fakeDockerImages: [{ ref: "cbase-projectbox:cand-2", id: "sha256:cd34" }] });
      assert.equal((await docker(["image", "load"], { stdin: image })).stdout, "Loaded image: cbase-projectbox:cand-2\n");
      const image3 = JSON.stringify({ fakeDockerImages: [{ ref: "cbase-projectbox:cand-3", id: "sha256:ef56" }] });
      assert.equal((await docker(["image", "load"], { stdin: Buffer.from(image3) })).stdout, "Loaded image: cbase-projectbox:cand-3\n");
    });
    await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: silent }, async () => {
      await assert.rejects(docker(["image", "load"], { stdin: Buffer.alloc(8 * 1024 * 1024, 120) }),
        (e) => e instanceof DockerError && e.code === 3 && /broken/.test(e.message));
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled.map((e) => e.message), []);
  } finally {
    process.off("uncaughtException", fang);
    fd.cleanUp();
  }
});

test("Fake: exec passes output and exit code through, -e NAME comes from the docker child's environment, -w must exist", async () => {
  const fd = await fakeDocker();
  try {
    await inOps(fd, async () => {
      await docker(["run", "-d", "--name", "p1", "-e", "IN_CONTAINER=yes", "img"]);
      const script = "process.stdout.write(`${process.env.SECRET}|${process.env.IN_CONTAINER}|${process.cwd()}`); process.stderr.write(\"e\"); process.exit(3)";
      await assert.rejects(
        docker(["exec", "-e", "SECRET", "-w", fd.dir, "p1", process.execPath, "-e", script], { env: { SECRET: "value" } }),
        (e) => {
          assert.equal(e.code, 3);
          assert.equal(e.stdout, `value|yes|${fs.realpathSync(fd.dir)}`);
          assert.equal(e.stderr, "e");
          return true;
        },
      );
      await assert.rejects(docker(["exec", "-w", "/exists/es/not", "p1", "true"]), (e) => e.code === 126 && /chdir to cwd/.test(e.stderr));
      await docker(["exec", "-d", "p1", process.execPath, "-e", "0"]);
    });
    // The value is not on the command line - only the name.
    assert.ok(fd.calls().every((a) => !a.args.some((x) => x.includes("value"))));
  } finally {
    fd.cleanUp();
  }
});

// The wrapper's docking point: `docker exec ... /usr/sbin/cbase-wrapper ...` runs the REAL wrapper from the repo.
//
// The test must not wait only for the exit file: if the wrapper never ends (its `waitpid` does not return) or ends WITHOUT
// the file, it would wait for ever - a regression would become a hang without a red line. So the END of the wrapper process
// leads it (pid from the fake docker's state, `exec -d` remembers it):
//   - if the wrapper ends, it counts whether the exit file is there (it appears BEFORE the end, so no race);
//   - if it never ends, its watchdog reports it: at its end the command leaves a background process that watches the
//     command's parent (the wrapper, `$PPID`) and writes a line after WRAPPER_TICKS looks. An emergency brake
//     (ripcord.mjs), not a deadline: an event cannot report "never ends", and "the wrapper lives after the command" is true
//     for a moment even in the right run - a way out through this feature alone would be a race against the clock.
// Counter-tests below, on copies of the wrapper (`programs`): `waitpid` replaced by an endless loop => the ripcord reports
// (red, no hang); the writing of the exit file removed => "without exit file" (red).
const WRAPPER_TICKS = Math.ceil(RIPCORD_MS / 50);
// The service command: writes a line, leaves the watchdog behind and ends with 3. The watchdog hangs on /dev/null, not on the
// log - otherwise it would be in the log and hold it open.
function serviceCommand(watchdog, ticks = WRAPPER_TICKS) {
  const w = `i=0; while kill -0 "$PPID" 2>/dev/null; do i=$((i + 1)); if [ "$i" -ge ${ticks} ]; then `
    + `echo "ripcord: the wrapper lives after the end of its command" > '${watchdog}'; exit 9; fi; sleep 0.05; done`;
  return ["/bin/sh", "-c", `echo im-service; ( ${w} ) </dev/null >/dev/null 2>&1 & exit 3`];
}
// Ended means: no process any more OR a zombie (without a reaping init it would stay) - `ps` only when it matters.
function wrapperEnded(pid) {
  if (!alive(pid)) return true;
  try { return /^Z/.test(execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim()); } catch { return true; }
}
// Runs `exec -d ... cbase-wrapper --log --exit` and waits for the wrapper's end or the ripcord of its watchdog.
async function wrapperWithExit(fd, { ticks } = {}) {
  const b = {
    pgid: path.join(fd.dir, "b.pgid"), log: path.join(fd.dir, "b.log"), exit: path.join(fd.dir, "b.exit"),
    watchdog: path.join(fd.dir, "b.ripcord"),
  };
  await inOps(fd, () => docker(["exec", "-d", "p1", WRAPPER_IN_IMAGE, "--pgid-file", b.pgid, "--log", b.log, "--exit", b.exit, "--", ...serviceCommand(b.watchdog, ticks)]));
  const c = Object.values(fd.state().container).find((x) => x.name === "p1");
  const wrapper = c.processes.at(-1);
  try {
    const kind = await waitForTruthy(() => {
      if (fs.existsSync(b.watchdog)) return "ripcord";
      if (!fs.existsSync(b.exit)) return alive(wrapper) ? null : "end";
      return wrapperEnded(wrapper) ? "end" : null;
    });
    return {
      kind, b,
      ripcord: kind === "ripcord" ? fs.readFileSync(b.watchdog, "utf8").trim() : null,
      exit: fs.existsSync(b.exit) ? fs.readFileSync(b.exit, "utf8").trim() : null,
    };
  } finally {
    // The watchdog is in the command's group (pgid file), the wrapper in its own - cleanUp() clears that.
    try { process.kill(-Number(fs.readFileSync(b.pgid, "utf8")), "SIGKILL"); } catch {}
  }
}
function checkWrapperWithExit(r) {
  assert.equal(r.ripcord, null, `the wrapper did not end: ${r.ripcord}`);
  assert.equal(r.kind, "end");
  assert.notEqual(r.exit, null, "the wrapper ended without an exit file");
  assert.equal(r.exit, "3");
  assert.equal(fs.readFileSync(r.b.log, "utf8"), "im-service\n");
  assert.match(fs.readFileSync(r.b.pgid, "utf8"), /^\d+\n$/);
}
// A copy of the wrapper with exactly one replacement (counter-tests).
function sabotagedWrapper(old, fresh) {
  const text = fs.readFileSync(WRAPPER_IN_REPO, "utf8");
  assert.equal(text.split(old).length - 1, 1, `the spot "${old}" is not exactly once in the wrapper`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-wrapper-sabotage-"));
  const file = path.join(dir, "cbase-wrapper");
  fs.writeFileSync(file, text.replace(old, fresh), { mode: 0o755 });
  return { file, cleanUp: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("Fake: exec on the image path of the wrapper runs the real wrapper - pgid file, and with -d log and exit file", async () => {
  const fd = await fakeDocker();
  try {
    const pgid = path.join(fd.dir, "a.pgid");
    await inOps(fd, async () => {
      await docker(["run", "-d", "--name", "p1", "cbase-projectbox:test"]);
      const r = await docker(["exec", "p1", WRAPPER_IN_IMAGE, "--pgid-file", pgid, "--", process.execPath, "-e", "process.stdout.write(String(process.pid))"]);
      assert.equal(fs.readFileSync(pgid, "utf8").trim(), r.stdout, "the pgid file does not name the command (exec of the wrapper)");
    });
    checkWrapperWithExit(await wrapperWithExit(fd));
  } finally {
    fd.cleanUp();
  }
});

test("Fake: counter-tests for the wrapper with exit file - if it never ends, the ripcord reports; if it ends without the file, it is red", async () => {
  const cases = [
    { name: "waitpid never returns", old: "do { $r = waitpid($kind, 0); } while ($r == -1 && $!{EINTR});",
      fresh: "select(undef, undef, undef, 0.05) while 1;", kind: "ripcord", notice: /the wrapper did not end: ripcord/ },
    { name: "exit file removed", old: "my $e = write_atomic($exit_file, \"$code\\n\");", fresh: "my $e = undef;",
      kind: "end", notice: /without an exit file/ },
  ];
  for (const f of cases) {
    const copy = sabotagedWrapper(f.old, f.fresh);
    const fd = await fakeDocker({ programs: { [WRAPPER_IN_IMAGE]: copy.file } });
    try {
      await inOps(fd, () => docker(["run", "-d", "--name", "p1", "cbase-projectbox:test"]));
      const r = await wrapperWithExit(fd, { ticks: 20 });
      assert.equal(r.kind, f.kind, f.name);
      assert.throws(() => checkWrapperWithExit(r), f.notice, f.name);
    } finally {
      fd.cleanUp();
      copy.cleanUp();
    }
  }
});

test("Fake: counter-proof - without the preset (`programs: {path: null}`) there is no wrapper (127)", async () => {
  const fd = await fakeDocker({ programs: { [WRAPPER_IN_IMAGE]: null } });
  try {
    await inOps(fd, async () => {
      await docker(["run", "-d", "--name", "p1", "cbase-projectbox:test"]);
      await assert.rejects(docker(["exec", "p1", WRAPPER_IN_IMAGE, "--pgid-file", path.join(fd.dir, "p"), "--", "true"]), (e) => e.code === 127);
    });
  } finally {
    fd.cleanUp();
  }
});

test("Address: hostPort brackets IPv6; the second loopback address is bindable and reachable through hostPort", async () => {
  assert.equal(hostPort("127.0.0.2", 7718), "127.0.0.2:7718");
  assert.equal(hostPort("::1", 7718), "[::1]:7718");
  assert.equal(hostPort("[::1]", 80), "[::1]:80");
  assert.equal(hostPort("fd00::5", "8080"), "[fd00::5]:8080");
  for (const wrong of [["::1", Number.NaN], ["::1", 70000], ["::1", 1.5], ["", 80]]) assert.throws(() => hostPort(...wrong), TypeError);
  const ip = await secondLoopback();
  assert.ok(["127.0.0.2", "::1"].includes(ip), ip);
  const server = http.createServer((req, res) => res.end("instance"));
  await new Promise((r) => server.listen(0, ip, r));
  try {
    const response = await fetch(`http://${hostPort(ip, server.address().port)}/`, { headers: { connection: "close" } });
    assert.equal(await response.text(), "instance");
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
