// Guard of the ONE start function of the project containers (runtime/inProject.js).
//
// The promises, each with the way that breaks it:
//   (1) Without an instance inProject is EXACTLY `spawn(cmd, args, opts)` — the same child, the same arguments, no docker, even with
//       the operating mark and the seam set (the golden proof golden-runs.test.js holds the runs byte-equal). Plus the main seam
//       without an instance row: a turn with the operating mark starts no docker.
//   (2) With an instance the argv form `docker exec -i [-t] -u agent [-w <cwd>] [-e NAME …] <container> /usr/sbin/cbase-wrapper
//       --pgid-file <runtime>/processes/<id>.pgid -- cmd …`; behind `-e` there is never a `=`; the environment is the allowlist
//       (what the caller changes/adds, plus ENV_TOGGLE) — measured into the exec of the fake docker, including B's empty
//       CLAUDE_SECURESTORAGE_CONFIG_DIR beating the value of the image.
//   (3) `.kill` ends the whole process group in the container (the fake docker deliberately does NOT pass signals on, like the real
//       one with a killed exec caller): first `docker exec … kill -<SIG> -- -<pgid>`, then the docker child; beside it the
//       counter-test that the signal at the docker child alone lets the long runner live. A kill before the pgid file is made up
//       for, even after the docker child has ended; the cap says that it is one.
//   (4) The main seam through withAgentsServer: Claude and Codex chat of a converted project start in the project container, the
//       fake CLI starts a long runner (like its bash tool), `POST /api/chats/:id/stop` — waiting without a limit until
//       `process.kill(-pgid, 0)` reports ESRCH. A subagent runs in the same container and carries the identifier of the instance in
//       its image (store/subagents.js); the core passes it on and takes it from the image when picking one up.
//   (5) Monitor and terminal (pty) the same way: stop or close ends the group in the container.
//   (5b) A terminal in the project container carries a locale that the image knows (C.UTF-8, never en_US.UTF-8).
//   (3b) ESCALATION: a group that ignores TERM gets KILL after the grace period (`CBASE_IN_PROJECT_ESCALATION_MS`) — independent of
//       the end of the docker child, which dies at TERM at once (stopRun's own KILL after 3 s comes only while runChildren holds the
//       child, so never). A KILL after the end of the docker child still reaches the group (the pgid is in memory), and the pgid file
//       falls only when the group is empty or got KILL. At the main seam: a fake CLI that ignores TERM, with an equally stubborn
//       long runner — after the chat stop it waits without a limit until `process.kill(-pgid, 0)` reports ESRCH. Waiting is on
//       `openEscalations()`, never on a duration; the grace period is 200 ms in these tests (it speeds up, but decides nothing).
//   (6) Project switch: the instance is fixed at the start of the turn — a living subagent stays in the container of its core, the
//       turn in the new (not converted) project runs in B and gets ONE silent hint (`instance-switch`), the next turn in the same
//       situation no second one.
//   (7) At the main seams the wait is on "gate OR run end" (`gateOrEnd`) or on quiet (`turnThrough`) and THEN checked — a failing
//       start is red instead of a hang. The built-in proof stops the container before the turn: the run ends, a gate mark never comes.
//   (8) Instance row there, operating mark off (two cases: both unset; only CBASE_CONTAINER) => the Claude turn and the project
//       terminal (codeRoute) run in B, the fake docker sees no call.
//   (9) A finished subagent from A, continued from the chat on B after a project switch and restart (cbase_agent_send), starts in
//       A — exec, pgid file and MCP file under data/projects/<A>/.
//  (10) The pgid file lies in the read-write mounted runtime folder — B reads it only without a reference (real-path.js
//       openFileWithoutReference, anchor the runtime folder): a FIFO in its place does not stop B (in the child process: it ends, no
//       group kill with a number from the FIFO), a reference in its place or in the place of `processes` yields no pgid (the kill
//       waits, as without a file), a regular file does. Judged without a clock: the test opens the FIFO for writing itself beforehand
//       and writes a pgid as soon as a reader is there — a blocking reader (the bug) reads it and ends RED instead of hanging.
//
// Counter-test map (one sabotage each, shown red):
//   - runtime/inProject.js: `kind.kill = …` dropped in inProject (the original kill at the docker child) => (3) and the main seam
//     red: the long runner lives, the log has no `kill`;
//   - runtime/inProject.js: `CLAUDE_SECURESTORAGE_CONFIG_DIR` dropped from ENV_TOGGLE => (2) red: the exec sees the value of the image;
//   - providers/connectors/claude.js: `spawn(claudeBin(), …)` instead of inProject => main seam Claude AND subagent red (no pgid
//     file at the gate, no exec in the log);
//   - providers/connectors/codex.js: `spawn(codexBin(), …)` instead of inProject => main seam Codex red;
//   - runs/agents.js: without `instance:` to createAgentRuntime => subagent red (image without identifier);
//   - runs/do-run.js: without `reportAgentsElsewhere(chat.id, instance)` => (6) red (no hint); runs/agents.js without the line
//     `if (elsewhereReported.get(chatId) === key) return 0;` => (6) red (the same hint a second time);
//   - (3b) without the escalation: the three tests of (3b) (no escalation after TERM; the pgid file already gone at `close`; at the
//     main seam neither escalation nor KILL) and (3) (no follow-up look after TERM) red;
//   - in `hits` the line `else if (name === "TERM") planEscalation(p);` dropped => the same 4 red;
//   - projectbox/run-instance.js without `!projectboxOps()` => both (8) tests red (the turn without `meta`, the terminal
//     `available:false` with NO_OPS), no hang;
//   - runs/agents.js `const agentInstance = instance;` => (9) red (continuation in the container of B); `const agentLocation =
//     runLocation;` => (9) red (MCP file under data/projects/<B>/). Without the restart in (9) both would stay green: the core of
//     turn 1 holds the finished agent and continues it itself, nothing is picked up then;
//   - projectbox/run-instance.js `containerOf = () => "cbase-p-wrong"` (every exec fails) => all seven main seams red quickly;
//   - (10) without the reference-free read of the pgid file: the group kill went out with the number from the FIFO or behind the
//     reference.
// No clock: waiting is on files, log entries and process ends (waitForTruthy, without a limit). Where the file MUST already be there
// (the wrapper writes P before the exec, the CLI stands at the gate), nothing is waited for but checked — a start past the wrapper
// turns red at once instead of hanging silently.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { B_OWN_ENV, ENV_TOGGLE, GIT_WRAPPER_FOLDER, WRAPPER_PATH, envAllowlist, withGitWrapperFront, sentGroupsKills, inProject, inProjectCall, inProjectKill, openEscalations, openCatchUpKills, setInProjectSeam } from "../electron/server/runtime/inProject.js";
import { dockerKind, dockerProgram } from "../electron/server/projectbox/docker.js";
import { createAgentRuntime } from "../electron/server/providers/agent-runtime.js";
import { createMonitorRuntime } from "../electron/server/providers/monitor-runtime.js";
import { createTerminal, killTerminal, terminalLang } from "../electron/server/terminal.js";
import { LOCATION, fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { WRAPPER_IN_REPO, fakeDocker } from "./fake-docker.mjs";
import { RIPCORD } from "./ripcord.mjs";

const TESTDIR = path.dirname(new URL(import.meta.url).pathname);
const SOURCE = path.resolve(TESTDIR, "..", "electron", "server", "runtime", "inProject.js");

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────
// Sets environment values (undefined = unset) for the duration of fn and restores the old state in the finally.
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
// The grace period of the escalation TERM → KILL at 200 ms (runtime/inProject.js): it speeds up the tests that drive a stop;
// the decision is made on `openEscalations()` and on the log, never on it.
// The homes of the CLIs in B lie in the throwaway folder: with an instance row the start of the turn searches sessions in B and in
// the project homes (runs/session-location.js) — never in the real ~/.claude of the machine the test runs on.
const ops = (fd) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200",
  CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex") });
// A running project container in the fake docker; `imageEnv` plays the ENV of the image (Dockerfile, stage projectbox).
function containerStart(fd, name, imageEnv = {}) {
  execFileSync(fd.bin, ["run", "-d", "--name", name, ...Object.entries(imageEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "cbase-projectbox:test"],
    { env: { ...process.env, ...fd.env } });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const output = (kind) => new Promise((resolve) => {
  let out = "", err = "";
  kind.stdout?.on("data", (d) => { out += d; });
  kind.stderr?.on("data", (d) => { err += d; });
  kind.on("close", (code, signal) => resolve({ out, err, code, signal }));
});
const execCalls = (fd) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec");
const killCalls = (fd, container) => execCalls(fd).filter((a) => a.args.includes("kill") && a.args.includes(container));
// The signals of the group kills to a container, in log order ("-TERM", "-0" = follow-up look of the escalation, …).
const signalsTo = (fd, container) => killCalls(fd, container).map((a) => a.args[5]);
const termTo = (fd, container) => killCalls(fd, container).find((a) => a.args[5] === "-TERM");
// The seam for unit tests without a server (server.js sets the real one; a later startServer sets it anew).
const unitSeam = (location) => ({ kind: dockerKind, program: dockerProgram, processLocation: () => location, container: (i) => i.containerId });
const INST = (name) => ({ projectId: "p1", instance: "main", identifier: "p1/main", containerId: name });

async function unit(fn, { imageEnv = {} } = {}) {
  const fd = await fakeDocker();
  const location = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-in-project-"));
  const name = `cbase-p-${path.basename(location).replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  try {
    return await withEnvironment(ops(fd), async () => {
      containerStart(fd, name, imageEnv);
      setInProjectSeam(unitSeam(path.join(location, "processes")));
      const r = await fn({ fd, location, name, inst: INST(name) });
      // A pending follow-up look of the escalation still needs the fake docker — clean up only afterwards.
      await waitForTruthy(() => openEscalations() === 0, "escalations done");
      return r;
    });
  } finally {
    setInProjectSeam(null);
    fd.cleanUp();
    fs.rmSync(location, { recursive: true, force: true });
  }
}

// ── (1) Without an instance: spawn ─────────────────────────────────────────────────────────────────────
test("without an instance inProject is exactly spawn — the same child, the same arguments, no docker (even with operation and seam)", async () => {
  // The contract stands as the first line in the body: no detour, no copy of the options.
  const source = fs.readFileSync(SOURCE, "utf8");
  const body = source.slice(source.indexOf("export function inProject(inst, cmd, args, opts) {"));
  // `opts` runs through withGitWrapperFront — without the operating mark the same object (test below).
  assert.match(body, /^export function inProject\(inst, cmd, args, opts\) \{\n {2}if \(!inst\) return spawn\(cmd, args, withGitWrapperFront\(opts\)\);\n/);
  await unit(async ({ fd, location }) => {
    const opts = { cwd: location, env: { ...process.env, IN_PROJECT_PROBE: "7" } };
    const args = ["-e", "process.stdout.write(process.cwd() + '|' + process.env.IN_PROJECT_PROBE)"];
    const [including, without] = [inProject(null, process.execPath, args, opts), spawn(process.execPath, args, opts)];
    assert.equal(including.spawnfile, without.spawnfile);
    assert.deepEqual(including.spawnargs, without.spawnargs);
    assert.equal(including.inProject, undefined, "without an instance no mark on the child");
    const [a, b] = await Promise.all([output(including), output(without)]);
    assert.equal(a.out, b.out);
    assert.equal(a.out, `${fs.realpathSync(location)}|7`);
    assert.deepEqual(fd.calls(), fd.calls().filter((x) => x.args[0] === "run"), "without an instance no docker call except the seeding");
  });
});

// ── (2) argv form and allowlist ─────────────────────────────────────────────────────────────────
test("with an instance: argv form, -w, -t, allowlist — behind -e there is never a \"=\", B's environment does not go along", async () => {
  await unit(async ({ location, name, inst }) => {
    await withEnvironment({ IN_PROJECT_SECRET: "secret", CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined, CLAUDE_CODE_DISABLE_AUTO_MEMORY: undefined }, async () => {
      const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", FRESH: "value = with equals", "BROKEN=NAME": "x" };
      delete env.IN_PROJECT_SECRET; // removed: does not go along (B's environment does not reach the container anyway)
      const a = inProjectCall(inst, "claude", ["-p", "--x"], { cwd: "/work", env });
      const pgid = a.args[a.args.indexOf("--pgid-file") + 1];
      assert.equal(path.dirname(pgid), path.join(location, "processes"), "the pgid file lies in the runtime folder");
      assert.match(path.basename(pgid), /^[0-9a-f-]{36}\.pgid$/);
      assert.ok(fs.statSync(path.join(location, "processes")).isDirectory(), "the folder of the pgid files stands BEFORE the start");
      assert.deepEqual(a.args, ["exec", "-i", "-u", "agent", "-w", "/work", "-e", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "-e", "FRESH",
        name, WRAPPER_PATH, "--pgid-file", pgid, "--", "claude", "-p", "--x"]);
      for (let i = 0; i < a.args.length; i++) if (a.args[i] === "-e") assert.ok(!a.args[i + 1].includes("="), `value in argv: ${a.args[i + 1]}`);
      assert.equal(a.env.FRESH, "value = with equals", "the value stands in the environment of the docker child");
      assert.equal(a.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
      assert.ok(!a.args.some((x) => x.includes("secret") || x.includes("IN_PROJECT_SECRET")));
      assert.equal(a.program, process.env.CBASE_DOCKER_BIN);
      // Without cwd no -w; with tty a -t behind -i.
      const b = inProjectCall(inst, "sh", [], { tty: true });
      assert.deepEqual(b.args.slice(0, 4), ["exec", "-i", "-t", "-u"]);
      assert.ok(!b.args.includes("-w"));
    });
    // The named switches go along, even if the caller does not change them — and also empty.
    await withEnvironment({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }, async () => {
      assert.deepEqual(envAllowlist(undefined).names, [...ENV_TOGGLE]);
      assert.deepEqual(envAllowlist(process.env).names, [...ENV_TOGGLE]);
      assert.deepEqual(envAllowlist(process.env).values, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" });
    });
    await withEnvironment({ CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined, CLAUDE_CODE_DISABLE_AUTO_MEMORY: undefined }, async () => {
      assert.deepEqual(envAllowlist(process.env).names, [], "without a change and without a switch: nothing");
    });
  });
});

test("into the exec of the fake docker: the allowlist arrives, B's secret does not, and the empty value beats the value of the image", async () => {
  await unit(async ({ fd, location, name, inst }) => {
    await withEnvironment({ IN_PROJECT_SECRET: "secret", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }, async () => {
      const work = fs.mkdtempSync(path.join(location, "work-"));
      const kind = inProject(inst, "/bin/sh", ["-c", 'printf "%s|%s|%s|%s" "$FRESH" "${CLAUDE_SECURESTORAGE_CONFIG_DIR-UNSET}" "${IN_PROJECT_SECRET-UNSET}" "$(pwd -P)"'],
        { cwd: work, env: { ...process.env, FRESH: "a=b c" } });
      assert.equal(kind.spawnfile, fd.bin, "the child is the docker child");
      assert.equal(typeof kind.pid, "number");
      const { out, code } = await output(kind);
      assert.equal(code, 0);
      assert.equal(out, `a=b c||UNSET|${fs.realpathSync(work)}`);
      const [exec] = execCalls(fd);
      assert.ok(exec.args.includes(name) && exec.args.includes("agent"), JSON.stringify(exec.args));
      assert.ok(!fs.existsSync(kind.inProject.pgidFile), "the pgid file is gone after the end");
    });
  }, { imageEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/home/agent/.claude-login" } });
});

// ── B's package caches never go into a project container ────────────────────────────────────────────────────────────
// The backend stage sets npm_config_cache, UV_CACHE_DIR, PIP_CACHE_DIR and PLAYWRIGHT_BROWSERS_PATH to folders of B
// (B_OWN_ENV). Neither as a deviation nor through envAlways/envEmpty, not even in another spelling.
// Counter-test: inProject.js with `isBOwn = () => false` => red (the exec carries `-e npm_config_cache`).
test("the four package caches of B never go along — neither deviating nor through envAlways/envEmpty, in no spelling", async () => {
  await unit(async ({ inst }) => {
    await withEnvironment({ npm_config_cache: "/home/agent/.cache/cbase-b/npm", UV_CACHE_DIR: undefined }, async () => {
      const env = { ...process.env, npm_config_cache: "/different/npm", NPM_CONFIG_CACHE: "/different/N", UV_CACHE_DIR: "/b/uv", PIP_CACHE_DIR: "/b/pip",
        PLAYWRIGHT_BROWSERS_PATH: "/b/pw", FRESH: "1" };
      const a = inProjectCall(inst, "sh", [], { env, envAlways: [...B_OWN_ENV, "NPM_CONFIG_CACHE"], envEmpty: ["UV_CACHE_DIR", "pip_cache_dir"] });
      const named = a.args.filter((_, i) => a.args[i - 1] === "-e").map((x) => x.split("=")[0].toLowerCase());
      assert.ok(named.includes("fresh"), `the allowlist itself is missing: ${JSON.stringify(a.args)}`);
      for (const k of B_OWN_ENV) assert.ok(!named.includes(k.toLowerCase()), `${k} goes into the project container: ${JSON.stringify(a.args)}`);
      assert.deepEqual(envAllowlist(env, B_OWN_ENV).names, ["FRESH", ...ENV_TOGGLE.filter((k) => env[k] !== undefined)]);
    });
  });
});

// ── Without an instance, in operation, git through the wrapper ──────────────────────────────────────────────────────
// inProject(null, …) puts GIT_WRAPPER_FOLDER at the front of the PATH in operation (there `git` → /usr/bin/cbase-git, created in the
// backend stage of the Dockerfile, bound in tools/check/projectbox-dockerfile.test.mjs). Without the operating mark `opts` is the
// same object. The decision is the same as projectboxOps (runtime/ never imports projectbox/: bound here).
// Counter-tests: inProject.js `return spawn(cmd, args, opts)` (the state before the wrapper) => "in operation …" red (PATH without
// the folder); withGitWrapperFront without checking the mark => "without operating mark …" red.
test("git wrapper: in operation without an instance the git folder stands at the front of the PATH, and a `git` of the run hits the wrapper", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-path-"));
  try {
    fs.writeFileSync(path.join(folder, "git"), "#!/bin/sh\nprintf '|wrapper:%s' \"$*\"\n", { mode: 0o755 });
    await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_GIT_WRAPPER_FOLDER: undefined }, async () => {
      const o = withGitWrapperFront({ cwd: "/x", env: { ...process.env, PATH: "/usr/bin:/bin" } });
      assert.equal(o.env.PATH, `${GIT_WRAPPER_FOLDER}:/usr/bin:/bin`);
      assert.equal(o.cwd, "/x");
      assert.equal(withGitWrapperFront(o).env.PATH, o.env.PATH, "the folder stands twice");
      assert.ok(withGitWrapperFront(undefined).env.PATH.startsWith(`${GIT_WRAPPER_FOLDER}:`), "without opts: the environment of B with the folder at the front");
      process.env.CBASE_GIT_WRAPPER_FOLDER = folder;
      const kind = inProject(null, "/bin/sh", ["-c", 'printf %s "$PATH"; git cbase-probe'], { env: { ...process.env } });
      const { out, code } = await output(kind);
      assert.equal(code, 0);
      assert.ok(out.startsWith(`${folder}:`), `PATH does not begin with the git folder: ${out}`);
      assert.ok(out.endsWith("|wrapper:cbase-probe"), `git did not hit the wrapper: ${out}`);
    });
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

// A passed environment WITHOUT PATH (a stdio MCP entry with its own env) must not get the git folder ALONE as PATH in operation —
// else `sh`, `python3` … would end with ENOENT. The default path stands behind the folder.
// Counter-test: the PATH line of withGitWrapperFront as PATH = only the folder => red.
test("git wrapper: an environment without PATH keeps the default path behind the git folder in operation — a child starts by its name", async () => {
  const { DEFAULT_SEARCH_PATH } = await import("../electron/server/runtime/inProject.js");
  await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_GIT_WRAPPER_FOLDER: undefined }, async () => {
    const o = withGitWrapperFront({ env: { TOKEN_X: "1" } });
    assert.equal(o.env.PATH, `${GIT_WRAPPER_FOLDER}:${DEFAULT_SEARCH_PATH ?? "/usr/bin:/bin"}`);
    assert.equal(o.env.TOKEN_X, "1");
    const kind = inProject(null, "sh", ["-c", 'printf "%s" "$TOKEN_X"'], { env: { TOKEN_X: "ok" } });
    const error = new Promise((resolve) => kind.on("error", (e) => resolve({ out: "", code: e.code })));
    const { out, code } = await Promise.race([output(kind), error]);
    assert.equal(code, 0, `sh by name did not start: ${code} ${out}`);
    assert.equal(out, "ok");
  });
});

test("git wrapper: without the operating mark `opts` is the same object — the decision is projectboxOps()", async () => {
  const { projectboxOps } = await import("../electron/server/projectbox/ops.js");
  for (const [c, d] of [[undefined, undefined], ["1", undefined], [undefined, "1"], ["1", "1"], ["true", "1"], ["1", "0"]]) {
    await withEnvironment({ CBASE_CONTAINER: c, CBASE_DIND: d }, async () => {
      const opts = { cwd: "/x", env: { PATH: "/bin" } };
      assert.equal(withGitWrapperFront(opts) !== opts, projectboxOps(), `CBASE_CONTAINER=${c} CBASE_DIND=${d}`);
      if (!projectboxOps()) {
        assert.equal(withGitWrapperFront(opts), opts);
        assert.equal(withGitWrapperFront(undefined), undefined);
        assert.deepEqual(opts, { cwd: "/x", env: { PATH: "/bin" } }, "opts changed");
      }
    });
  }
});

// ── (3) Kill ────────────────────────────────────────────────────────────────────────────────────
test("kill: the group in the container, then the docker child — the signal at the docker child alone would let the long runner live", async () => {
  await unit(async ({ fd, location, name, inst }) => {
    const start = (tag) => {
      const duration = path.join(location, `duration-${tag}`);
      const kind = inProject(inst, "/bin/sh", ["-c", `sleep 100000 & echo $! > ${duration}; wait`], { cwd: location });
      const finished = output(kind);
      return { kind, duration, finished };
    };
    const ready = async ({ kind, duration }) => {
      await waitForTruthy(() => fs.existsSync(kind.inProject.pgidFile) && fs.existsSync(duration) && fs.readFileSync(duration, "utf8").trim(), "pgid file and long runner");
      return { pgid: Number(fs.readFileSync(kind.inProject.pgidFile, "utf8")), durationPid: Number(fs.readFileSync(duration, "utf8")) };
    };

    // Counter-test in the test: only the docker child hit (the way without the group kill) — the group in the container lives on.
    const old = start("old");
    const a = await ready(old);
    process.kill(old.kind.pid, "SIGTERM");
    await old.finished;
    assert.ok(alive(-a.pgid) && alive(a.durationPid), "the signal at the docker child reached the container — does the fake pass it on after all?");
    process.kill(-a.pgid, "SIGKILL");
    await waitForTruthy(() => !alive(-a.pgid), "counter-test cleaned up");

    // The way with the group kill.
    const fresh = start("fresh");
    const n = await ready(fresh);
    const prior = sentGroupsKills();
    assert.equal(fresh.kind.kill("SIGTERM"), true);
    // At once, not awaited: without a group kill there would never be a log entry, and the test would hang instead of being red.
    assert.equal(sentGroupsKills(), prior + 1, "kill() sent no group kill in the container");
    await fresh.finished;
    await waitForTruthy(() => !alive(-n.pgid) && !alive(n.durationPid), "group in the container ended");
    assert.deepEqual(termTo(fd, name).args, ["exec", "-u", "agent", name, "kill", "-TERM", "--", `-${n.pgid}`]);
    // The follow-up look of the escalation sees the empty group; only afterwards the pgid file falls.
    await waitForTruthy(() => openEscalations() === 0, "follow-up look of the escalation");
    assert.ok(signalsTo(fd, name).includes("-0"), `no follow-up look after TERM: ${signalsTo(fd, name)}`);
    assert.ok(!fs.existsSync(fresh.kind.inProject.pgidFile), "the pgid file is gone");
    // A kill after a demonstrably empty group hits nothing any more and waits for nothing (no kill to a pgid that somebody else
    // might carry meanwhile).
    const afterwards = sentGroupsKills();
    fresh.kind.kill("SIGKILL");
    assert.equal(sentGroupsKills(), afterwards, "a kill to a demonstrably empty group");
    assert.equal(openCatchUpKills(), 0);
  });
});

// A wrapper that waits at a gate before it starts the real one: so the kill surely comes BEFORE the pgid file.
function gateWrapper(location) {
  const gate = path.join(location, "wrappers-gate");
  const file = path.join(location, "wrapper-with-gate");
  fs.writeFileSync(file, `#!/bin/sh\n: > '${gate}.waiting'\nwhile [ ! -e '${gate}' ]; do sleep 0.02; done\nexec /usr/bin/perl '${WRAPPER_IN_REPO}' "$@"\n`);
  fs.chmodSync(file, 0o755);
  return { file, gate };
}

test("kill before the pgid file: made up for in the tick, even after the docker child is already gone", async () => {
  await unit(async ({ fd, location, name, inst }) => {
    const h = gateWrapper(location);
    // The cap in the opposite direction (no clock on which this test turns red): it is ALWAYS made up for here.
    await withEnvironment({ CBASE_WRAPPER: h.file, CBASE_IN_PROJECT_KILL_MS: String(24 * 3_600_000) }, async () => {
      const kind = inProject(inst, "/bin/sh", ["-c", "sleep 100000 & wait"], { cwd: location });
      const finished = output(kind);
      await waitForTruthy(() => fs.existsSync(`${h.gate}.waiting`), "wrapper at the gate");
      kind.kill("SIGTERM");
      assert.equal(openCatchUpKills(), 1, "the kill waits for the pgid file");
      await finished; // the docker child is gone — the start in the container goes on (as with the real docker)
      fs.writeFileSync(h.gate, "");
      await waitForTruthy(() => openCatchUpKills() === 0, "made-up kill");
      // The docker child of the kill writes the log itself as soon as it runs — so wait for it, do not look.
      const k = await waitForTruthy(() => termTo(fd, name), "group kill in the log");
      assert.deepEqual(k.args.slice(0, 7), ["exec", "-u", "agent", name, "kill", "-TERM", "--"]);
      const pgid = -Number(k.args[7]);
      await waitForTruthy(() => !alive(-pgid), "group ended");
      await waitForTruthy(() => openEscalations() === 0, "follow-up look of the escalation");
      assert.ok(!fs.existsSync(kind.inProject.pgidFile), "the pgid file is gone");
    });
  });
});

test("the cap of the made-up kill says that it is one", async (t) => {
  await unit(async ({ location, inst }) => {
    const h = gateWrapper(location); // the gate never opens: the pgid file does not come
    const warnings = [];
    t.mock.method(console, "warn", (...a) => { warnings.push(a.join(" ")); });
    await withEnvironment({ CBASE_WRAPPER: h.file, CBASE_IN_PROJECT_KILL_MS: "1" }, async () => {
      const kind = inProject(inst, "/bin/sh", ["-c", "sleep 100000"], { cwd: location });
      const finished = output(kind);
      await waitForTruthy(() => fs.existsSync(`${h.gate}.waiting`), "wrapper at the gate");
      kind.kill("SIGTERM");
      await finished;
      await waitForTruthy(() => openCatchUpKills() === 0, "Cap");
    });
    assert.ok(warnings.some((w) => /cap of 1 ms reached: no pgid file/.test(w) && /may keep running/.test(w)), warnings.join("\n"));
  });
});

// ── (3b) Escalation TERM → KILL ─────────────────────────────────────────────────────────────
// A group that ignores TERM: the shell (group leader, `trap '' TERM`) and its long runner (inherits the ignoring).
function stubbornStart(inst, location) {
  const duration = path.join(location, `duration-stubborn-${Math.random().toString(36).slice(2)}`);
  const kind = inProject(inst, "/bin/sh", ["-c", `trap '' TERM; sleep 100000 & echo $! > ${duration}; wait`], { cwd: location });
  return { kind, duration, finished: output(kind) };
}
async function stubbornReady({ kind, duration }) {
  await waitForTruthy(() => fs.existsSync(kind.inProject.pgidFile) && fs.existsSync(duration) && fs.readFileSync(duration, "utf8").trim(), "pgid file and stubborn long runner");
  return { pgid: Number(fs.readFileSync(kind.inProject.pgidFile, "utf8")), durationPid: Number(fs.readFileSync(duration, "utf8")) };
}

test("escalation: a group that ignores TERM gets KILL after the grace period — even if the docker child is long gone", async () => {
  await unit(async ({ fd, location, name, inst }) => {
    const s = stubbornStart(inst, location);
    const { pgid, durationPid } = await stubbornReady(s);
    s.kind.kill("SIGTERM"); // like stopRun (runs/state.js)
    // At once, not awaited: without an escalation there would never be a KILL, and the wait below would hang instead of being red.
    assert.equal(openEscalations(), 1, "after TERM no escalation to KILL is pending — a group that ignores TERM would stay");
    await s.finished; // the docker child is gone: stopRun's KILL after 3 s (only while runChildren holds it) would never come
    await waitForTruthy(() => openEscalations() === 0, "escalation done");
    const signals = signalsTo(fd, name);
    assert.deepEqual([...signals].sort(), ["-0", "-KILL", "-TERM"], `Gruppen-Kills: ${signals}`);
    assert.ok(signals.indexOf("-KILL") > signals.indexOf("-0"), "KILL only after the follow-up look");
    await waitForTruthy(() => !alive(-pgid) && !alive(durationPid), "stubborn group in the container ended");
    assert.ok(!fs.existsSync(s.kind.inProject.pgidFile), "the pgid file is gone as soon as the group got KILL");
  });
});

test("a KILL after the end of the docker child still reaches the group — the pgid is in memory, the file falls only afterwards", async () => {
  await unit(async ({ fd, location, name, inst }) => {
    // The grace period in the opposite direction: here only the caller escalates (like stopRun, if it still held the child).
    await withEnvironment({ CBASE_IN_PROJECT_ESCALATION_MS: String(24 * 3_600_000) }, async () => {
      const s = stubbornStart(inst, location);
      const { pgid, durationPid } = await stubbornReady(s);
      s.kind.kill("SIGTERM");
      await s.finished;
      assert.ok(fs.existsSync(s.kind.inProject.pgidFile), "the pgid file fell at close although the group ignores TERM and still lives");
      const prior = sentGroupsKills();
      s.kind.kill("SIGKILL");
      assert.equal(sentGroupsKills(), prior + 1, "the KILL after the end of the docker child fizzled out");
      assert.equal(openEscalations(), 0, "the KILL replaces the escalation");
      assert.ok(!fs.existsSync(s.kind.inProject.pgidFile), "after KILL the pgid file is gone");
      await waitForTruthy(() => !alive(-pgid) && !alive(durationPid), "stubborn group in the container ended");
      // Every docker child writes the log itself at its start (two processes, no fixed order) — so sorted.
      await waitForTruthy(() => signalsTo(fd, name).length >= 2, "both group kills in the log");
      assert.deepEqual([...signalsTo(fd, name)].sort(), ["-KILL", "-TERM"]);
    });
  });
});

// ── (5) Monitor and terminal ────────────────────────────────────────────────────────────────────
test("monitor in the project container: the stop ends the group there (killProcessTree asks the mark)", async () => {
  await unit(async ({ fd, location, name, inst }) => {
    const duration = path.join(location, "duration-monitor");
    const mon = createMonitorRuntime({ cwd: location, instance: inst });
    const task = mon.start({ command: `sleep 100000 & echo $! > ${duration}; wait`, persistent: true });
    await waitForTruthy(() => fs.existsSync(duration) && fs.readFileSync(duration, "utf8").trim(), "long runner of the monitor");
    const durationPid = Number(fs.readFileSync(duration, "utf8"));
    const [exec] = execCalls(fd);
    assert.ok(exec.args.includes("-w") && exec.args[exec.args.indexOf("-w") + 1] === location);
    const prior = sentGroupsKills();
    assert.equal(mon.stop(task.taskId), true);
    assert.equal(sentGroupsKills(), prior + 1, "the stop of the monitor sent no group kill");
    await waitForTruthy(() => !alive(durationPid), "long runner ended");
    assert.equal(signalsTo(fd, name).filter((x) => x === "-TERM").length, 1);
    await waitForTruthy(() => mon.endProcess() === 1, "docker child closed");
    mon.close();
  });
});

test("terminal (pty) in the project container: docker exec -it, closing ends the group there with SIGHUP", async () => {
  await unit(async ({ fd, location, name, inst }) => {
    const duration = path.join(location, "duration-terminal");
    const { id } = createTerminal({ cwd: location, command: "/bin/sh", args: ["-c", `sleep 100000 & echo $! > ${duration}; wait`], instance: inst });
    await waitForTruthy(() => fs.existsSync(duration) && fs.readFileSync(duration, "utf8").trim(), "long runner of the terminal");
    const durationPid = Number(fs.readFileSync(duration, "utf8"));
    const [exec] = execCalls(fd);
    assert.deepEqual(exec.args.slice(0, 5), ["exec", "-i", "-t", "-u", "agent"]);
    assert.ok(exec.args.includes("SHELL_SESSIONS_DISABLE"), "the terminal environment goes along as a name");
    const prior = sentGroupsKills();
    assert.equal(killTerminal(id), true);
    assert.equal(sentGroupsKills(), prior + 1, "closing the terminal sent no group kill");
    await waitForTruthy(() => !alive(durationPid), "long runner ended");
    assert.equal(killCalls(fd, name)[0].args[5], "-HUP");
  });
});

// (5b) A terminal in the project container must not get `-e LANG` with the fallback en_US.UTF-8 — a locale that the project box image
// does not have (only C, C.utf8, POSIX): the perl wrapper wrote six warning lines before the prompt, the shell fell back to C.
// Measured into the shell behind the fake docker: B without LANG, the value the shell sees is C.UTF-8. On a Mac perl does not warn
// with en_US.UTF-8 — so the value is caught, not the warning.
// Counter-test: terminal.js with `-e LANG` carrying en_US.UTF-8 into the shell => red.
test("terminal locale: a terminal in the project container never carries LANG=en_US.UTF-8 — without LANG in B C.UTF-8 arrives in the shell", async () => {
  await unit(async ({ fd, location, inst }) => {
    await withEnvironment({ LANG: undefined }, async () => {
      const marker = path.join(location, "long-in-terminal");
      const { id } = createTerminal({ cwd: location, command: "/bin/sh", args: ["-c", `printf '%s|' "$LANG" > ${marker}.tmp && mv ${marker}.tmp ${marker}`], instance: inst });
      try {
        const seen = await waitForTruthy(() => fs.existsSync(marker) && fs.readFileSync(marker, "utf8"), "LANG of the shell in the project container");
        const [exec] = execCalls(fd);
        assert.ok(exec.args.includes("LANG"), "LANG goes along as a name (B has none)");
        assert.notEqual(seen, "en_US.UTF-8|", "the project box image does not know en_US.UTF-8 — the perl wrapper warns, the shell falls back to C");
        assert.equal(seen, "C.UTF-8|");
      } finally { killTerminal(id); }
    });
  });
  // The pure rule behind it (terminal.js terminalLang): a Linux target gets C.UTF-8, the Mac without an instance stays
  // en_US.UTF-8, a LANG set in B always applies.
  assert.equal(terminalLang({ lang: undefined, platform: "linux" }), "C.UTF-8", "terminal in B (Linux) without an instance");
  assert.equal(terminalLang({ lang: undefined, platform: "linux", instance: INST("x") }), "C.UTF-8");
  assert.equal(terminalLang({ lang: undefined, platform: "darwin" }), "en_US.UTF-8", "local on the Mac");
  assert.equal(terminalLang({ lang: undefined, platform: "darwin", instance: INST("x") }), "C.UTF-8", "the target of an instance is always Linux");
  assert.equal(terminalLang({ lang: "de_DE.UTF-8", platform: "linux", instance: INST("x") }), "de_DE.UTF-8", "a LANG of B applies");
  // The asserts above must not depend on the LANG of the CALLING environment — a gate from a terminal has LANG set, one from a
  // desktop app does not, and `lang` used to be a default parameter (a passed `undefined` triggered it). So here explicitly with
  // LANG set and missing: a MISSING field reads process.env.LANG (the way of createTerminal), a passed `undefined` means "no LANG".
  // Counter-test: with the default parameter "a passed undefined means no LANG" got de_DE.UTF-8 => red.
  await withEnvironment({ LANG: "de_DE.UTF-8" }, async () => {
    assert.equal(terminalLang({ platform: "linux" }), "de_DE.UTF-8", "without the field the LANG of B applies");
    assert.equal(terminalLang({ platform: "darwin", instance: INST("x") }), "de_DE.UTF-8");
    assert.equal(terminalLang({ lang: undefined, platform: "linux" }), "C.UTF-8", "a passed undefined means no LANG");
    assert.equal(terminalLang({ lang: undefined, platform: "darwin" }), "en_US.UTF-8");
  });
  await withEnvironment({ LANG: undefined }, async () => {
    assert.equal(terminalLang({ platform: "linux" }), "C.UTF-8", "without the field and without LANG in B");
    assert.equal(terminalLang(), process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8", "without an argument");
  });
});

// ── Core of the subagents: the identifier travels in the image ──────────────────────────────────────────────
test("core: a new agent carries the instance of the core (spec and image), a picked-up one that of its image", async () => {
  const core = (instance) => {
    const specs = [];
    const images = [];
    let finished;
    const end = new Promise((r) => { finished = r; });
    const rt = createAgentRuntime({
      chatId: "c-instance", cwd: process.cwd(), parentProvider: "codex", instance,
      resolveRef: () => ({ connector: {}, providerId: "codex", model: "gpt-5.6-sol" }),
      buildSpec: (b) => { specs.push(b); return {}; },
      runChat: async ({ onSpawn }) => { onSpawn({ kill() {} }); return { code: 0, sessionId: "s1", resultText: "finding" }; },
      deposit: { remember: (b) => images.push(b), row() {} },
      onFinish: (rec, info) => finished(info),
    });
    return { rt, specs, images, end };
  };
  const a = core("p1/main");
  await a.rt.start({ prompt: "Do something" });
  await a.end;
  assert.equal(a.specs[0].instance, "p1/main", "the factory gets the identifier");
  const image = a.images.at(-1);
  assert.equal(image.instance, "p1/main", "the image carries it (resume, orphan report)");
  a.rt.close();

  // Another core (the chat is somewhere else meanwhile) picks it up: it stays in ITS instance.
  const b = core("p2/main");
  b.rt.pickUp({ ...image, state: "finished", rows: [] });
  await b.rt.send({ agentId: image.agentId, message: "further" });
  await b.end;
  assert.equal(b.specs.at(-1).instance, "p1/main");
  b.rt.close();

  // Without an instance: no field in the image, null at the factory.
  const c = core(null);
  await c.rt.start({ prompt: "Do something" });
  await c.end;
  assert.equal(c.specs[0].instance, null);
  assert.ok(!("instance" in c.images.at(-1)), "without an instance the image carries no field");
  c.rt.close();
});

// ── (4) Main seam ───────────────────────────────────────────────────────────────────────────────
// The main agent: "DURATION" starts a long runner (like the bash tool of the CLI: a child in the same group) and holds at the gate
// "never"; "AGENT" calls cbase_agent in the foreground; otherwise an answer.
const MAIN = `
  if (text.includes("DURATION")) {
    const d = spawn("/bin/sh", ["-c", "sleep 100000"], { stdio: "ignore" });
    fs.writeFileSync(path.join(LOCATION, "duration.pid"), String(d.pid));
    fs.writeFileSync(path.join(LOCATION, "pids", String(d.pid)), "duration");
    say({ type: "assistant", message: { id: "m-duration", content: [{ type: "text", text: "work" }] } });
    await gate("never");
    return;
  }
  if (text.includes("STUBBORN")) {
    // A CLI that hangs in its TERM handler, with an equally stubborn long runner in its group.
    process.on("SIGTERM", () => {});
    const d = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 100000"], { stdio: "ignore" });
    fs.writeFileSync(path.join(LOCATION, "stubborn.pid"), String(d.pid));
    fs.writeFileSync(path.join(LOCATION, "pids", String(d.pid)), "duration");
    say({ type: "assistant", message: { id: "m-stubborn", content: [{ type: "text", text: "working stubbornly" }] } });
    await gate("stubborn");
    return;
  }
  if (text.includes("AGENT")) {
    const args = { description: "On the side", prompt: "Take a look", run_in_background: false };
    say({ type: "assistant", message: { id: "m-ag", content: [{ type: "tool_use", id: "toolu_ag", name: "mcp__cbase__cbase_agent", input: args }] } });
    const r = await mcpCall("cbase_agent", args);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_ag", content: textOf(r) }] } });
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;
const SUB = `
    fs.writeFileSync(path.join(LOCATION, "sub-argv.json"), JSON.stringify(argv));
    finished();
    say({ type: "result", result: "finding", session_id: "sub-session" });`;

// Operating mark, fake docker, a project with a running container — and (with `converted`) its instance row. With
// `chat: null` the chat stays where it is (a second project).
async function projectInOps(ctx, fd, { converted = true, chat = ctx.chat, name: title = "Shop", folder = "till" } = {}) {
  const projPath = path.join(ctx.root, "workspace", folder);
  fs.mkdirSync(projPath, { recursive: true });
  const p = await ctx.projectWithoutInstance({ name: title, path: projPath });
  const name = `cbase-p-${p.id}`;
  containerStart(fd, name);
  if (converted) store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: name });
  if (chat) await json(`${ctx.base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
  return { p, name, processes: path.join(ctx.dataRoot, "data", "projects", p.id, "processes") };
}
const oneFile = (folder) => {
  const d = fs.existsSync(folder) ? fs.readdirSync(folder).filter((n) => n.endsWith(".pgid")) : [];
  return d.length === 1 ? path.join(folder, d[0]) : null;
};
// Wait for "gate OR run end", then check. A start that fails (an exec that docker refuses, a start past the seam that throws)
// ends the run without the fake CLI ever reaching its gate — `ctx.gate.reached` alone would hang then instead of turning red. Run
// end means: no turn any more (`runs`), with `agents` also no living subagent (a gate in the subagent). The number stands
// synchronously after POST /message (doRun: `running.add` before the first await).
async function gateOrEnd(ctx, name, { agents = false, chatId = ctx.chat.id } = {}) {
  const marker = path.join(ctx.root, "gates", `${name}.waiting`);
  const what = await waitForTruthy(async () => {
    if (fs.existsSync(marker)) return "gate";
    const s = await json(`${ctx.base}/api/runs/active`);
    return s.runs === 0 && (!agents || !(s.agents || []).length) ? "end" : null;
  }, `gate ${name} or run end`);
  if (what === "gate" || fs.existsSync(marker)) return;
  const log = await json(`${ctx.base}/api/chats/${chatId}/log`).catch(() => []);
  assert.fail(`the run ended without the fake CLI reaching the gate "${name}" — its start failed (history: ${JSON.stringify(log).slice(-600)})`);
}
// The same for a turn without a gate: wait for QUIET (run end including subagents), THEN check that it ran through — never wait
// for `meta`, which a failed start never writes.
async function turnThrough(ctx, chatId = ctx.chat.id) {
  await ctx.waitForQuiet();
  const log = await json(`${ctx.base}/api/chats/${chatId}/log`);
  assert.ok(log.some((m) => m.role === "meta"), `the turn did not run through — its start failed (history: ${JSON.stringify(log).slice(-600)})`);
}

test("main seam Claude: without an instance row no docker; with it the chat starts in the project container, and the stop ends the group there", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat, ws } = ctx;
      await withEnvironment(ops(fd), async () => {
        // Without an instance row (operating mark on): the turn runs as before — no exec.
        const { p, name, processes } = await projectInOps(ctx, fd, { converted: false });
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Hello" }) });
        await turnThrough(ctx);
        assert.deepEqual(execCalls(fd), [], "without an instance row no docker exec");

        // With an instance row: the next turn runs in the container (fixed at the start of the turn).
        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: name });
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "DURATION" }) });
        await gateOrEnd(ctx, "never");
        // The wrapper writes P BEFORE it replaces itself by the CLI — at the gate the file is there already (no waiting: a start
        // past the wrapper turns red here at once instead of silent).
        const pgidFile = oneFile(processes);
        assert.ok(pgidFile, `no pgid file under ${processes} — the turn did not run through the wrapper`);
        const pgid = Number(fs.readFileSync(pgidFile, "utf8"));
        const durationPid = Number(fs.readFileSync(path.join(ctx.root, "duration.pid"), "utf8"));
        assert.ok(alive(-pgid) && alive(durationPid));
        const [exec] = execCalls(fd);
        const w = exec.args.indexOf("-w");
        // In the project container the project folder is the working folder (not the workspace).
        assert.equal(exec.args[w + 1], p.path, "-w: the working folder of the run is the project folder");
        assert.notEqual(exec.args[w + 1], store.getWorkspace(ws.id).path);
        assert.deepEqual(exec.args.slice(exec.args.indexOf(name), exec.args.indexOf("--") + 2), [name, WRAPPER_PATH, "--pgid-file", pgidFile, "--", process.env.CLAUDE_BIN]);
        assert.ok(exec.args.includes("CLAUDE_CODE_DISABLE_AUTO_MEMORY"), "the switch of the auto memory goes along");

        const prior = sentGroupsKills();
        await json(`${base}/api/chats/${chat.id}/stop`, { method: "POST" });
        await waitForTruthy(async () => (await json(`${base}/api/runs/active`)).runs === 0, "turn ended");
        assert.ok(sentGroupsKills() > prior, "the stop sent no group kill into the container");
        await waitForTruthy(() => !alive(-pgid) && !alive(durationPid), "group in the container ended");
        assert.deepEqual(termTo(fd, name).args, ["exec", "-u", "agent", name, "kill", "-TERM", "--", `-${pgid}`]);
        await waitForTruthy(() => !oneFile(processes), "pgid file gone");
      });
    }, { claude: fakeClaude({ main: MAIN, sub: SUB }) });
  } finally {
    fd.cleanUp();
  }
});

test("main seam stop: a CLI that ignores TERM ends in the container anyway — with its long runner (escalation)", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat } = ctx;
      await withEnvironment(ops(fd), async () => {
        const { name, processes } = await projectInOps(ctx, fd);
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "STUBBORN" }) });
        await gateOrEnd(ctx, "stubborn");
        const pgidFile = oneFile(processes);
        assert.ok(pgidFile, `no pgid file under ${processes} — the turn did not run through the wrapper`);
        const pgid = Number(fs.readFileSync(pgidFile, "utf8"));
        const durationPid = Number(fs.readFileSync(path.join(ctx.root, "stubborn.pid"), "utf8"));
        assert.ok(alive(-pgid) && alive(durationPid));
        await json(`${base}/api/chats/${chat.id}/stop`, { method: "POST" });
        await waitForTruthy(async () => (await json(`${base}/api/runs/active`)).runs === 0, "turn ended");
        // The run is closed (the docker child died at TERM), runChildren holds nothing any more — stopRun's KILL never comes. So the
        // escalation is pending, or it has already sent KILL (it ends only when its docker child is closed).
        assert.ok(openEscalations() > 0 || signalsTo(fd, name).includes("-KILL"),
          `after the stop neither escalation nor KILL (${signalsTo(fd, name)}) — the CLI would stay in the container as an orphan`);
        await waitForTruthy(() => !alive(-pgid) && !alive(durationPid), "stubborn group in the container ended");
        assert.ok(signalsTo(fd, name).includes("-KILL"), `ended without KILL: ${signalsTo(fd, name)}`);
        await waitForTruthy(() => !oneFile(processes), "pgid file gone");
      });
    }, { claude: fakeClaude({ main: MAIN, sub: SUB }) });
  } finally {
    fd.cleanUp();
  }
});

test("main seam subagent: it runs in the container of its core and carries the identifier of the instance in its image", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat } = ctx;
      await withEnvironment(ops(fd), async () => {
        const { p, name } = await projectInOps(ctx, fd);
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "AGENT" }) });
        await turnThrough(ctx);
        const execs = execCalls(fd).filter((a) => a.args.includes(name) && a.args.includes(WRAPPER_PATH));
        assert.equal(execs.length, 2, `main run and subagent in the container: ${execs.length}`);
        assert.ok(execs.some((a) => a.args.some((x) => x.includes("SUBAGENT of cbase"))), "the subagent ran in the container");
        const [image] = store.subagentsOf(chat.id);
        assert.equal(image.instance, `${p.id}/main`, JSON.stringify(image).slice(0, 300));
      });
    }, { claude: fakeClaude({ main: MAIN, sub: SUB }) });
  } finally {
    fd.cleanUp();
  }
});

// Project switch with a living subagent: the main agent starts it in the background; every input it writes as a line to
// texts.jsonl (the whole content, including the fenced hint). The subagent holds at the gate "sub-alive".
const MAIN_SWITCH = `
  fs.appendFileSync(path.join(LOCATION, "texts.jsonl"), JSON.stringify(msg.message.content) + "\\n");
  if (text.includes("BACKGROUND")) {
    const args = { description: "On the side", prompt: "Take a look", run_in_background: true };
    say({ type: "assistant", message: { id: "m-bg", content: [{ type: "tool_use", id: "toolu_bg", name: "mcp__cbase__cbase_agent", input: args }] } });
    const r = await mcpCall("cbase_agent", args);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: textOf(r) }] } });
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;
const SUB_ALIVE = `
    await gate("sub-alive");
    finished();
    say({ type: "result", result: "Befund", session_id: "sub-session" });`;

test("project switch: the living subagent stays in the container of its core, the turn in the new project runs in B and learns of it ONCE", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat, ws } = ctx;
      await withEnvironment(ops(fd), async () => {
        const { p, name } = await projectInOps(ctx, fd);
        const texts = path.join(ctx.root, "texts.jsonl");
        const rows = () => (fs.existsSync(texts) ? fs.readFileSync(texts, "utf8").trim().split("\n").filter(Boolean) : []);
        const runningNothing = async () => (await json(`${base}/api/runs/active`)).runs === 0;
        const inContainer = () => execCalls(fd).filter((a) => a.args.includes(name) && a.args.includes(WRAPPER_PATH)).length;

        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "BACKGROUND" }) });
        await gateOrEnd(ctx, "sub-alive", { agents: true });
        await waitForTruthy(runningNothing, "turn 1 ended (the subagent lives)");
        assert.equal(inContainer(), 2, "main run and subagent in the container");

        // Switch the project: the new one is NOT converted — the next turn runs in B, the subagent stays where it is.
        const lagerPath = path.join(ctx.root, "workspace", "warehouse");
        fs.mkdirSync(lagerPath, { recursive: true });
        const p2 = await ctx.projectWithoutInstance({ name: "Warehouse", path: lagerPath });
        await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p2.id }) });

        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "TWO" }) });
        await waitForTruthy(async () => rows().length === 2 && (await runningNothing()), "turn 2 ended");
        assert.equal(inContainer(), 2, "the turn in the not converted project ran in B");
        const two = rows()[1];
        assert.match(two, /source=\\"instance-switch\\"/, "no silent hint about the subagent in the other instance");
        assert.ok(two.includes(`in the project container ${p.id}/main`) && two.includes("in the backend (without a project container)"), two.slice(0, 600));

        // The same situation: no second hint.
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "THREE" }) });
        await waitForTruthy(async () => rows().length === 3 && (await runningNothing()), "turn 3 ended");
        assert.ok(!rows()[2].includes("instance-switch"), "the same hint came a second time");

        ctx.gate.open("sub-alive");
        await ctx.waitForQuiet();
      });
    }, { claude: fakeClaude({ main: MAIN_SWITCH, sub: SUB_ALIVE }) });
  } finally {
    fd.cleanUp();
  }
});

// Fake Codex that starts a long runner and then does nothing more (a turn that is computing).
const CODEX_DURATION = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for the EXISTENCE of a file and then reads it — without rename it would read an empty one
// under load. pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".part-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
${RIPCORD}
const say = (o) => console.log(JSON.stringify(o));
say({ type: "thread.started", thread_id: "codex-thread" });
say({ type: "turn.started" });
const d = spawn("/bin/sh", ["-c", "sleep 100000"], { stdio: "ignore" });
fs.writeFileSync(path.join(LOCATION, "duration-codex.pid"), String(d.pid));
fs.writeFileSync(path.join(LOCATION, "pids", String(d.pid)), "duration");
fs.writeFileSync(path.join(LOCATION, "gates", "codex.waiting"), String(process.pid));
setInterval(() => {}, 1 << 30);
`;

test("main seam Codex: the turn process starts in the project container, the stop ends the group there", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws } = ctx;
      await withEnvironment(ops(fd), async () => {
        const cx = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "codex", model: "gpt-5.6-sol", permissionMode: "bypassPermissions" }) });
        await json(`${base}/api/chats/${cx.id}`, { method: "PATCH", body: JSON.stringify({ title: "Codex in container" }) });
        const { name, processes } = await projectInOps(ctx, fd, { chat: cx });
        await json(`${base}/api/chats/${cx.id}/message`, { method: "POST", body: JSON.stringify({ text: "Compute" }) });
        await gateOrEnd(ctx, "codex", { chatId: cx.id });
        const pgidFile = oneFile(processes);
        assert.ok(pgidFile, `no pgid file under ${processes} — the turn did not run through the wrapper`);
        const pgid = Number(fs.readFileSync(pgidFile, "utf8"));
        const durationPid = Number(fs.readFileSync(path.join(ctx.root, "duration-codex.pid"), "utf8"));
        const [exec] = execCalls(fd);
        assert.equal(exec.args[exec.args.indexOf("--") + 1], process.env.CODEX_BIN);
        assert.ok(!exec.args.includes("OPENAI_API_KEY"), "removed names do not go along");
        const prior = sentGroupsKills();
        await json(`${base}/api/chats/${cx.id}/stop`, { method: "POST" });
        await waitForTruthy(async () => (await json(`${base}/api/runs/active`)).runs === 0, "turn ended");
        assert.ok(sentGroupsKills() > prior, "the stop sent no group kill into the container");
        await waitForTruthy(() => !alive(-pgid) && !alive(durationPid), "group in the container ended");
        assert.equal(termTo(fd, name).args.at(-1), `-${pgid}`);
        await waitForTruthy(() => openEscalations() === 0, "follow-up look of the escalation");
      });
    }, { codex: CODEX_DURATION });
  } finally {
    fd.cleanUp();
  }
});

// ── (7) A failing start turns red instead of hanging ─────────────────────────────────
test("when the exec fails (container stopped), waiting for \"gate OR run end\" reports red — ctx.gate.reached would hang", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat } = ctx;
      await withEnvironment(ops(fd), async () => {
        const { name } = await projectInOps(ctx, fd);
        // The container is stopped: every exec ends in the fake docker as in the real one with "is not running" (exit 1).
        execFileSync(fd.bin, ["stop", name], { env: { ...process.env, ...fd.env } });
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "DURATION" }) });
        await assert.rejects(gateOrEnd(ctx, "never"), /the run ended without the fake CLI reaching the gate "never"/);
        assert.ok(execCalls(fd).some((a) => a.args.includes(name) && a.args.includes(WRAPPER_PATH)), "the turn did not even try the exec");
        assert.ok(!fs.existsSync(path.join(ctx.root, "gates", "never.waiting")), "the fake CLI ran after all");
      });
    }, { claude: fakeClaude({ main: MAIN, sub: SUB }) });
  } finally {
    fd.cleanUp();
  }
});

// ── (8) At the main seam — instance row there, operating mark off ──────────────────────────────────────────────────
// The row alone switches nothing on: without CBASE_CONTAINER AND CBASE_DIND the run instance is null (projectbox/run-instance.js),
// the turn and the project terminal start in B, and the fake docker sees no call. Waiting is on the RUN END, not on `meta`: if the
// mark dropped out of the run instance, the docker child without a mark would throw (NO_OPS), and the run would end without `meta`
// — the test is red then, instead of waiting for a result that never comes.
const MARKERS_FROM = { CBASE_CONTAINER: undefined, CBASE_DIND: undefined };
// Created as in operation (container in the fake docker, instance row, the chat on the project); afterwards the marks off.
async function convertedWithoutOps(ctx, fd) {
  const location = await withEnvironment(ops(fd), () => projectInOps(ctx, fd));
  assert.equal(store.converted(location.p.id), true, "the instance row stands");
  return { ...location, seeded: fd.calls().length };
}

test("instance row there, operating mark off — the Claude turn runs in B, no docker", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat } = ctx;
      const { processes, seeded } = await convertedWithoutOps(ctx, fd);
      const cases = [["both marks unset (local)", MARKERS_FROM], ["only CBASE_CONTAINER (user container without Sysbox)", { ...MARKERS_FROM, CBASE_CONTAINER: "1" }]];
      for (const [what, markers] of cases) {
        await withEnvironment({ ...ops(fd), ...markers }, async () => {
          const metas = async () => (await json(`${base}/api/chats/${chat.id}/log`)).filter((m) => m.role === "meta").length;
          const prior = await metas();
          await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Hello" }) });
          await waitForTruthy(async () => (await json(`${base}/api/runs/active`)).runs === 0, `turn ended (${what})`);
          const log = await json(`${base}/api/chats/${chat.id}/log`);
          assert.equal(await metas(), prior + 1, `${what}: the turn did not run through — ${JSON.stringify(log.slice(-2)).slice(0, 500)}`);
          assert.deepEqual(fd.calls().slice(seeded), [], `${what}: a docker call without the operating mark`);
          assert.equal(oneFile(processes), null, `${what}: a pgid file — the turn ran through the wrapper`);
          await ctx.waitForQuiet();
        });
      }
    }, { claude: fakeClaude({ main: MAIN, sub: SUB }) });
  } finally {
    fd.cleanUp();
  }
});

test("instance row there, operating mark off — the project terminal (codeRoute) starts in B, no docker", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base } = ctx;
      const { p, seeded } = await convertedWithoutOps(ctx, fd);
      // The login shell with SHELL=/bin/sh (without zsh first-time setup in the temp HOME), as in in-project-start-places (C).
      await withEnvironment({ ...ops(fd), ...MARKERS_FROM, SHELL: "/bin/sh" }, async () => {
        const t = await json(`${base}/api/projects/${p.id}/terminal`, { method: "POST", body: JSON.stringify({ cols: 80, rows: 24 }) });
        assert.equal(t.available, true, JSON.stringify(t));
        const marker = path.join(ctx.root, "terminal-in-b");
        await json(`${base}/api/terminal/${t.id}/input`, { method: "POST", body: JSON.stringify({ data: `echo b > '${marker}.tmp' && mv '${marker}.tmp' '${marker}'\r` }) });
        await waitForTruthy(() => fs.existsSync(marker), "mark of the terminal");
        assert.deepEqual(fd.calls().slice(seeded), [], "terminal: a docker call without the operating mark");
        await json(`${base}/api/terminal/${t.id}`, { method: "DELETE" });
      });
    }, { claude: fakeClaude({ main: MAIN, sub: SUB }) });
  } finally {
    fd.cleanUp();
  }
});

// ── (9) A picked-up subagent starts in the instance of its image ───────────────────────────────────────────────────
// Two converted projects A and B. Turn 1 (chat on A) starts a subagent in the foreground; it ends in A. The chat switches to B,
// turn 2 (in B) continues it with cbase_agent_send. The core of turn 2 does not know it, picks it up from its image
// (runs/agents.js fromStock), and the agent spec factory starts it in A — exec into the container of A, MCP file and pgid file in
// the runtime folder of A (`data/projects/<A>/`), not in that of B.
// With the token of B the main agent does NOT continue it any more — the fence asks the instance of the agent also in the stock
// (runs/agents.js instanceOfTheTarget), and A is not the instance of the token (other projects invisible). The promise (a
// continuation starts in the instance of its image) is therefore checked over the way without a fence (B itself): POST /agent/send
// without a token, while turn 2 runs.
const MAIN_SEND = `
  const everything = (msg.message.content || []).map((c) => (c && c.text) || "").join("\\n");
  if (everything.includes("START-SUBAGENT")) {
    const args = { description: "On the side", prompt: "Take a look", run_in_background: false };
    say({ type: "assistant", message: { id: "m-ag", content: [{ type: "tool_use", id: "toolu_ag", name: "mcp__cbase__cbase_agent", input: args }] } });
    const r = await mcpCall("cbase_agent", args);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_ag", content: textOf(r) }] } });
  }
  const send = /SEND-TO (\\S+)/.exec(everything);
  if (send) {
    const args = { agentId: send[1], message: "Check once more" };
    say({ type: "assistant", message: { id: "m-send", content: [{ type: "tool_use", id: "toolu_send", name: "mcp__cbase__cbase_agent_send", input: args }] } });
    const r = await mcpCall("cbase_agent_send", args);
    fs.writeFileSync(path.join(LOCATION, "send-response.txt"), textOf(r));
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_send", content: textOf(r) }] } });
  }
  if (everything.includes("HOLD")) await gate("pd5-hold");
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;
const SUB_ARGV = `
    fs.appendFileSync(path.join(LOCATION, "sub-argv.jsonl"), JSON.stringify(argv) + "\\n");
    finished();
    say({ type: "result", result: "Befund", session_id: "sub-session" });`;

test("main seam: a finished subagent from A, continued from the chat on B, starts in A — MCP file under data/projects/<A>/, cleaned up there at its end; the token of B does not continue it", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat } = ctx;
      await withEnvironment(ops(fd), async () => {
        const A = await projectInOps(ctx, fd);
        const B = await projectInOps(ctx, fd, { chat: null, name: "Warehouse", folder: "warehouse" });
        const locationOf = (x) => path.join(ctx.dataRoot, "data", "projects", x.p.id);
        const argvFile = path.join(ctx.root, "sub-argv.jsonl");
        const subStarts = () => (fs.existsSync(argvFile) ? fs.readFileSync(argvFile, "utf8").trim().split("\n").filter(Boolean).map((z) => JSON.parse(z)) : []);
        const isSub = (a) => a.args.some((x) => x.includes("SUBAGENT of cbase"));
        const subExecs = () => execCalls(fd).filter((a) => a.args.includes(WRAPPER_PATH) && isSub(a));
        const containerOfThe = (a) => a.args[a.args.indexOf(WRAPPER_PATH) - 1];

        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "START-SUBAGENT" }) });
        await ctx.waitForQuiet();
        const [image] = store.subagentsOf(chat.id);
        assert.ok(image, "no subagent in the stock");
        assert.equal(image.instance, `${A.p.id}/main`);
        assert.equal(subStarts().length, 1, "the subagent did not run in turn 1");
        assert.deepEqual(subExecs().map(containerOfThe), [A.name]);

        // The chat switches to B. The restart closes the core of turn 1 (it would otherwise keep holding the finished agent, and the
        // continuation would run in IT — in the instance A of the core, without ever being picked up). Turn 2 runs in B and
        // continues the subagent (in the background, it reports afterwards).
        await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: B.p.id }) });
        // Before listening, startServer sets every converted instance to `start`; only the restart grace (the restore) brings it to
        // `ready`. The harness switches off the restart timer (CBASE_RESTART_GRACE_MS = 24 h), and the restore itself (network mark,
        // stages) is checked by projectbox-restore.test.js — here stands its result: both instances `ready` again (the harness does
        // this with `instancesReady`). Without it turn 2 would wait at the lock forever.
        await ctx.restart({ instancesReady: true });
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: `SEND-TO ${image.agentId} HOLD` }) });
        await gateOrEnd(ctx, "pd5-hold");
        // The main agent of turn 2 (token of B) does not reach the agent from A — 403, nothing starts.
        const responseFile = path.join(ctx.root, "send-response.txt");
        const response = fs.existsSync(responseFile) ? fs.readFileSync(responseFile, "utf8") : "(no)";
        assert.match(response, /instance other than/, `cbase_agent_send with the token of B to the agent from A: ${response.slice(0, 300)}`);
        assert.equal(subStarts().length, 1, "with the token of B the continuation started after all");
        // The way without a fence (B itself): the continuation starts in the instance of its image.
        const gone = await json(`${base}/api/chats/${chat.id}/agent/send`, { method: "POST", body: JSON.stringify({ agentId: image.agentId, message: "Check once more", from: "agent" }) });
        assert.equal(gone?.status, "running", `/agent/send ohne Token: ${JSON.stringify(gone).slice(0, 300)}`);
        // Wait for the end of the continuation while turn 2 still stands at the gate: the next turn (its completion message wakes one)
        // would pull the files of the chat from A to B (do-run.js) — the check below would then see nothing.
        await waitForTruthy(async () => !((await json(`${base}/api/runs/active`)).agents || []).some((a) => a.agentId === image.agentId), "continuation ended");
        const starts = subStarts();
        assert.equal(starts.length, 2, `the continuation did not run (answer of /agent/send: ${JSON.stringify(gone).slice(0, 300)})`);
        const cfg = starts[1][starts[1].indexOf("--mcp-config") + 1];
        assert.ok(cfg.startsWith(locationOf(A) + path.sep), `MCP file of the continuation outside data/projects/<A>/: ${cfg}`);
        assert.ok(!cfg.startsWith(locationOf(B) + path.sep), cfg);
        // At the end of the continuation the core of turn 2 (location B) clears the traces in the location of the AGENT (runs/agents.js
        // locationOfTheAgent, the same computation as the spec factory). Clearing in the location of the core would leave the MCP
        // file under data/projects/<A>/ until the chat is deleted.
        // Counter-test: `location: runLocation` in onFinish => red at this line (the file is still there).
        assert.ok(!fs.existsSync(cfg), `the MCP file of the continuation stayed after its end: ${cfg}`);
        ctx.gate.open("pd5-hold");
        await ctx.waitForQuiet();
        const main = execCalls(fd).filter((a) => a.args.includes(WRAPPER_PATH) && !isSub(a));
        assert.ok(main.some((a) => containerOfThe(a) === B.name), "turn 2 did not run in the container of B — the test would not measure the project switch");

        // The continuation: exec in A, pgid file in the runtime folder of A.
        const execs = subExecs();
        assert.deepEqual(execs.map(containerOfThe), [A.name, A.name], "the continuation did not run in the container of A");
        const pgid = execs[1].args[execs[1].args.indexOf("--pgid-file") + 1];
        assert.equal(path.dirname(pgid), A.processes, "the pgid file of the continuation does not lie under processes/ of A");
      });
    }, { claude: fakeClaude({ main: MAIN_SEND, sub: SUB_ARGV }) });
  } finally {
    fd.cleanUp();
  }
});

// ── (10) The pgid file only without a reference ─────────────────────────────────────────────────────────────────────────
// A FIFO without a writer, read in a CHILD PROCESS (`script`, ESM) — the same form as in projectbox-git.test.js: the test opens it
// for writing itself BEFORE (blocks in the thread pool until a reader opens) and writes `content` as soon as that succeeds; a
// blocking reader (the bug) gets the content that way and ends with it (red at the result, no hang). After the end of the child a
// reader of its own (O_NONBLOCK) releases a still waiting writer.
async function fifoInChild(fifo, content, script, env) {
  const writer = fs.promises.open(fifo, "w").then(async (fh) => {
    try { await fh.write(content); } catch { /* the reader is already gone (EPIPE) */ } finally { await fh.close(); }
  });
  const subprocess = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const r = await output(subprocess);
  const fd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try { await writer; } finally { fs.closeSync(fd); }
  return r;
}
// A seam whose docker children are only recorded (a group kill is a call of `kind`).
function recordingSeam(location) {
  const called = [];
  return { called, seam: { kind: (args) => { called.push(args); return new EventEmitter(); }, program: () => "docker", processLocation: () => location, container: () => "c" } };
}

test("(10) B reads the pgid file only without a reference — a FIFO does not stop B, a reference (also at `processes`) yields no pgid, a regular file does", async () => {
  const lz = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-pgid-"));
  const location = path.join(lz, "processes");
  fs.mkdirSync(location);
  try {
    // The FIFO — in the child process (a hang there would stay a hang of the child, not of the test).
    const fifo = path.join(location, "fifo.pgid");
    execFileSync("mkfifo", [fifo]);
    const script = `const m = await import(process.env.SOURCE);
      const { EventEmitter } = await import("node:events");
      const called = [];
      m.setInProjectSeam({ kind: (args) => { called.push(args); return new EventEmitter(); }, program: () => "docker", processLocation: () => process.env.LOCATION, container: () => "c" });
      m.inProjectKill({ container: "c", pgidFile: process.env.FILE, identifier: "p1/main" }).kill("SIGKILL");
      process.stdout.write(JSON.stringify({ called, catchingUp: m.openCatchUpKills() }));
      process.exit(0);`;
    const r = await fifoInChild(fifo, "4242\n", script, { SOURCE, FILE: fifo, LOCATION: location });
    assert.equal(r.code, 0, `child: ${r.signal || r.code} ${r.err}`);
    assert.deepEqual(JSON.parse(r.out), { called: [], catchingUp: 1 }, `B read the pgid from the FIFO: ${r.out}`);

    // References — in the test process (no hang threatens here): in the place of the file, in the place of `processes`.
    const outside = path.join(lz, "b-folder");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "foreign.pgid"), "4243\n");
    fs.symlinkSync(path.join(outside, "foreign.pgid"), path.join(location, "reference.pgid"));
    fs.symlinkSync(outside, path.join(lz, "processes-reference"));
    const { called, seam } = recordingSeam(location);
    setInProjectSeam(seam);
    for (const file of [path.join(location, "reference.pgid"), path.join(lz, "processes-reference", "foreign.pgid")]) {
      inProjectKill({ container: "c", pgidFile: file, identifier: "p1/main" }).kill("SIGKILL");
      assert.deepEqual(called, [], `B read the pgid behind the reference ${file}`);
      // The kill waits (as without a file); a regular file in the same place is taken by the next look in the tick.
      fs.rmSync(file);
      if (!fs.existsSync(path.dirname(file))) fs.mkdirSync(path.dirname(file)); // `processes-reference` was the reference
      else if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) { fs.rmSync(path.dirname(file)); fs.mkdirSync(path.dirname(file)); }
      fs.writeFileSync(file, "4244\n");
      await waitForTruthy(() => openCatchUpKills() === 0, "the waiting kill takes the regular file");
      assert.deepEqual(called.map((a) => a.slice(4)), [["kill", "-KILL", "--", "-4244"]], `regular file ${file}: ${JSON.stringify(called)}`);
      called.length = 0;
    }
  } finally {
    setInProjectSeam(null);
    fs.rmSync(lz, { recursive: true, force: true });
  }
});
