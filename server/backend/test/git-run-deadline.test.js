// Guard for runtime/git-run.js `commandRun`/`gitRun` and `accessAsEnvironment`, runtime/fileAccess.js (passed through).
//
// The promises, each with the way that breaks it:
//   (1) `withoutDeadline: true` sets NO timer: the command runs until it ends (gate instead of duration — it reads from a FIFO until the
//       test writes), the result carries no `cap`, and while it runs `runningCommandDeadlines()` counts no deadline.
//       Built-in counter-test: the same command with `timeout: 1` instead of `withoutDeadline` ends with `cap: "deadline"`.
//   (2) A missing or 0 `timeout` stays the default of 120 s (GIT_RUN_CAP_MS) — measured at the value commandRun gives to `setTimeout`
//       (no clock: the command ends at once). fileAccess passes `withoutDeadline` through (without: 60 s).
//   (3) `signal` (AbortSignal) ends the group IN the container: the log of the fake docker shows `exec -u agent <c> kill -TERM --
//       -<pgid>`, the result `aborted: true`, `code: null`. An already aborted signal starts nothing (no docker call). fileAccess
//       reports `ABORTED`. Ripcord instead of a hang: the command carries the deadline RIPCORD_MS — if the abort breaks, it ends there
//       with `cap: "deadline"` (red), never as a hang.
//   (4) `user: "root"` appears as `-u root` ONLY with the option (without: `-u agent`), and the group kill of a root start goes as
//       root too (as agent it would not hit the root-owned group); another user is a build error.
//   (5) `accessAsEnvironment([…])`: a key of its own per host with port (`credential.https://h:8443.helper`), asked with REAL git in the
//       (fake) container — the host with port gets its token, the same host without port, another host and a foreign host get none
//       (not even the inherited helper); no value in the argv. Built-in counter-test: a helper without port does not answer for `:8443`
//       (git compares the port — a helper without port would be ineffective there).
//   (6) pull/fetch/push with access (git.js via `auth.host`) carry NO hostless `credential.helper` with a value — only the clearing and
//       the helper of the host of their remote; without `auth.host` no access at all. gitRemoteTarget reads the host lowercase and with
//       port (`host` is lowercase too — that is how the accesses are stored).
//   (7) gitSubmoduleUpdate with an instance runs in the container WITHOUT deadline (content) and with the accesses of the hosts the repo
//       and its submodules network to (`.gitmodules`, local `submodule.<n>.url`) — per host its helper, no value in the argv.
//   (8) gitPull with an instance fetches the LFS files afterwards with THE SAME access (helper of the remote host, GIT_LFS_SKIP_SMUDGE=0,
//       in the container); if the fetch fails, the pull throws with a message of its own; a repo WITHOUT an LFS file asks no `lfs pull`
//       (only `ls-files`). A repo WITH an LFS file asks `lfs pull` after every pull — even without new ones: `git lfs ls-files` names every
//       LFS file, fetched or not (the fake git-lfs used to name only pointers in the working tree).
//   (9) gitPull and gitFetch WITH an instance and `accessesFor` carry the helpers of ALL hosts the repo networks to — remote and
//       submodule (`.gitmodules`) for pull/fetch, remote and `.lfsconfig` (`lfs.url`, a SECOND host) for the LFS fetch afterwards —,
//       per host its helper, no value in the argv; push stays with the host of the remote. Counter-test built in: without `accessesFor`
//       the second host is missing. Plus git-auth.js gitErrPayload: the host from git's message (lowercase, without port), else that
//       of the remote.
//  (10) The helper of the management git (gitHelper) no longer answers after an `erase` — get, erase, get with REAL git
//       (`credential fill`/`reject`) ⇒ the second get stays without answer; the marker is a path under /tmp, no value; if the run
//       fails, gitRun clears the markers in the container (`rm -f --`). Counter-test built in: the old helper (`printf` on every action)
//       answers the second get too.
//  (11) networkHosts `{ lfs: true }` reads `.lfsconfig` (`lfs.url`, `lfs.pushurl`) of a second host; hostFromAddress and
//       store.gitAccessesFor as units — each with a built-in counter-test.
//
// COUNTER-TESTS (one sabotage each on runtime/git-run.js or inProject.js):
//   - deadline without `withoutDeadline` (always the timer)                                  ⇒ (1) red ("a deadline is running")
//   - `timeout: 0` ⇒ no timer                                                                ⇒ (2) red
//   - the abort listener missing                                                             ⇒ (3) red (`cap: "deadline"` after RIPCORD_MS)
//   - `-u agent` fixed in inProjectCall                                                      ⇒ (4) red
//   - the group kill fixed as agent                                                          ⇒ (4) red
//   - the old body of accessAsEnvironment (hostless helper)                                   ⇒ (5) and (6) red
// On git.js: `host` without `toLowerCase()` ⇒ (6) red; gitSubmoduleUpdate with an instance in the old body (`timeout: 120000`, without
// access) ⇒ (7) red; gitPull without the LFS block ⇒ (8) red; gitPull/gitFetch with only `access(auth)` ⇒ (9) red (".lfsconfig host
// missing", "submodule host missing"); workspaces/git-auth.js gitErrPayload always with the remote's host ⇒ (9) red; runtime/git-run.js
// gitHelper in the old form ⇒ (10) red; networkHosts with the old pattern (`^lfs\\.url$`) ⇒ (9) and (11) red (`lfs.pushurl`);
// hostFromAddress without the `::` line ⇒ (11) red (`ext::sh -c x` gave `ext`).
//
// No clock: the tests wait for files and process ends; the deadlines in (1)–(3) are caps of the PRODUCT.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as gitModule from "../electron/server/git.js";
import * as store from "../electron/server/store.js";
import {
  GIT_RUN_CAP_MS, commandRun, gitHelper, gitRun, hostFromAddress, runningCommandDeadlines, runningCommandsIn, networkHosts,
  accessAsEnvironment, accessMarkers,
} from "../electron/server/runtime/git-run.js";
import { gitErrPayload } from "../electron/server/workspaces/git-auth.js";
import * as dz from "../electron/server/runtime/fileAccess.js";
import { openEscalations, setInProjectSeam } from "../electron/server/runtime/inProject.js";
import { dockerKind, dockerProgram } from "../electron/server/projectbox/docker.js";
import { waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { fakeLfs, lfsCalls, lfsFails, pointer } from "./fake-lfs.mjs";
import { REAL_GIT, SECRET, realGit, gitLocation, createRepo } from "./projectbox-git-scenario.mjs";
import { RIPCORD_MS } from "./ripcord.mjs";

// ── Helpers (as in projectbox-git.test.js — a .test.js never imports another) ───────────────────────────────────────────
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const ops = (fd) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200", GIT_TERMINAL_PROMPT: undefined });
const INST = (name) => ({ projectId: "p1", instance: "main", identifier: "p1/main", containerId: name });
const execCalls = (fd) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec");
const argValue = (a, flag) => a.args[a.args.indexOf(flag) + 1];
const killCalls = (fd) => execCalls(fd).filter((a) => a.args.includes("kill") && a.args.includes("--") && /^-\d+$/.test(a.args.at(-1)));

// The unit: fake docker, a running project container with the environment of the container location (inherited helper), the seam.
async function unit(fn, { containerEnv = () => ({}) } = {}) {
  const fd = await fakeDocker();
  const o = gitLocation("cbase-gitfrist-");
  const name = `cbase-p-${path.basename(o.location).replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  try {
    return await withEnvironment({ ...o.env, ...ops(fd) }, async () => {
      execFileSync(fd.bin, ["run", "-d", "--name", name, ...Object.entries({ ...o.containerEnv, ...containerEnv(o) }).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "cbase-projectbox:test"],
        { env: { ...process.env, ...fd.env } });
      setInProjectSeam({ kind: dockerKind, program: dockerProgram, processLocation: () => path.join(o.location, "processes"), container: (i) => i.containerId });
      const r = await fn({ fd, o, name, inst: INST(name) });
      await waitForTruthy(() => openEscalations() === 0, "escalations done");
      return r;
    });
  } finally {
    setInProjectSeam(null);
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
}
// The values that commandRun gives to setTimeout during `fn` (the deadline is set at the start — synchronously without a pause).
async function deadlinesDuring(fn) {
  const real = globalThis.setTimeout;
  const values = [];
  globalThis.setTimeout = (f, ms, ...rest) => { values.push(ms); return real(f, ms, ...rest); };
  try { return { result: await fn(), values }; } finally { globalThis.setTimeout = real; }
}
// The gate: a FIFO the command reads from. `open()` blocks (in the thread pool) until the reader is there, and then writes.
function gate(location, name) {
  const p = path.join(location, name);
  execFileSync("mkfifo", [p]);
  return { path: p, open: async (text) => { const fh = await fs.promises.open(p, "w"); try { await fh.write(text); } finally { await fh.close(); } } };
}

// ── (1) withoutDeadline ───────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(1) withoutDeadline: no timer — the command runs until the gate opens, without cap; counter-test: timeout 1 ends with cap deadline", async () => {
  await unit(async ({ o, name, inst }) => {
    const t = gate(o.location, "gate-1");
    const run = commandRun(inst, o.location, "sh", ["-c", `read x < '${t.path}'; printf '%s' "$x"`], { withoutDeadline: true });
    assert.equal(runningCommandsIn(name), 1, "the command counts as running in the container");
    assert.equal(runningCommandDeadlines(), 0, "withoutDeadline: a deadline is running");
    await t.open("open\n");
    const r = await run;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.cap, null);
    assert.equal(r.stdout, "open");
    assert.equal(r.aborted, undefined);
    // Built-in counter-test: the same command with a deadline of 1 ms (the cap of the product) — the gate never opens.
    const t2 = gate(o.location, "gate-1b");
    const r2 = await commandRun(inst, o.location, "sh", ["-c", `read x < '${t2.path}'`], { timeout: 1 });
    assert.equal(r2.cap, "deadline", JSON.stringify(r2));
    assert.equal(r2.code, null);
    assert.equal(runningCommandDeadlines(), 0);
  });
});

// ── (2) Vorgabe 120 s ───────────────────────────────────────────────────────────────────────────────────────────────────────
test("(2) a missing or 0 timeout stays the default of 120 s; withoutDeadline sets no value; fileAccess passes withoutDeadline through", async () => {
  await unit(async ({ o, inst }) => {
    for (const opts of [{}, { timeout: 0 }]) {
      const { result, values } = await deadlinesDuring(() => commandRun(inst, o.location, "true", [], opts));
      assert.equal(result.code, 0, result.stderr);
      assert.ok(values.includes(GIT_RUN_CAP_MS), `${JSON.stringify(opts)}: no deadline of ${GIT_RUN_CAP_MS} ms (${JSON.stringify(values)})`);
    }
    const without = await deadlinesDuring(() => commandRun(inst, o.location, "true", [], { withoutDeadline: true, timeout: 5000 }));
    assert.equal(without.result.code, 0);
    assert.ok(!without.values.includes(GIT_RUN_CAP_MS) && !without.values.includes(5000), `withoutDeadline with a deadline: ${JSON.stringify(without.values)}`);
    // gitRun passes the no-deadline flag through.
    const g = await deadlinesDuring(() => gitRun(inst, o.location, ["--version"], { withoutDeadline: true }));
    assert.equal(g.result.code, 0, g.result.stderr);
    assert.ok(!g.values.includes(GIT_RUN_CAP_MS), JSON.stringify(g.values));
    // fileAccess: without the option its own deadline (DEADLINE_SMALL_MS), with withoutDeadline none.
    const withDeadline = await deadlinesDuring(() => dz.list(inst, o.location));
    assert.ok(withDeadline.values.includes(dz.DEADLINE_SMALL_MS), JSON.stringify(withDeadline.values));
    const dzWithout = await deadlinesDuring(() => dz.list(inst, o.location, { withoutDeadline: true }));
    assert.ok(Array.isArray(dzWithout.result));
    assert.ok(!dzWithout.values.includes(dz.DEADLINE_SMALL_MS), JSON.stringify(dzWithout.values));
  });
});

// ── (3) signal ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(3) signal ends the group in the container (kill -TERM -<pgid> as agent), result aborted; aborted before the start ⇒ no docker; fileAccess ⇒ ABORTED", async () => {
  await unit(async ({ fd, o, name, inst }) => {
    const t = gate(o.location, "gate-3");
    const marker = path.join(o.location, "running-3");
    const ac = new AbortController();
    // Ripcord: if the abort breaks, the command ends at its deadline (RIPCORD_MS) with cap "deadline" — red instead of a hang.
    const run = commandRun(inst, o.location, "sh", ["-c", `echo da > '${marker}'; read x < '${t.path}'`], { signal: ac.signal, timeout: RIPCORD_MS });
    await waitForTruthy(() => fs.existsSync(marker), "the command runs in the container");
    const killsPrior = killCalls(fd).length;
    ac.abort();
    const r = await run;
    assert.equal(r.aborted, true, JSON.stringify(r));
    assert.equal(r.code, null);
    assert.equal(r.cap, null, "the abort did not arrive — the ripcord (deadline) ended the command");
    assert.match(r.stderr, /aborted/);
    await waitForTruthy(() => killCalls(fd).length > killsPrior, "group kill in the container");
    const kill = killCalls(fd)[killsPrior];
    assert.equal(argValue(kill, "-u"), "agent");
    assert.ok(kill.args.includes(name), JSON.stringify(kill.args));
    assert.deepEqual(kill.args.slice(kill.args.indexOf("kill"), kill.args.indexOf("kill") + 3), ["kill", "-TERM", "--"]);
    // Already aborted: nothing starts.
    const prior = fd.calls().length;
    const ac2 = new AbortController();
    ac2.abort();
    const r2 = await commandRun(inst, o.location, "true", [], { signal: ac2.signal });
    assert.equal(r2.aborted, true);
    assert.equal(fd.calls().length, prior, "an aborted signal started a command");
    // file access passes the signal through.
    await assert.rejects(dz.list(inst, o.location, { signal: ac2.signal }), (e) => e instanceof dz.FileAccessError && e.code === "ABORTED");
    // A signal that is none is a build error.
    await assert.rejects(commandRun(inst, o.location, "true", [], { signal: {} }), TypeError);
  });
});

// ── (4) user root ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(4) user root: -u root only with the option (otherwise -u agent), the group kill of a root start as root; another user raises", async () => {
  await unit(async ({ fd, o, inst }) => {
    await commandRun(inst, o.location, "true", []);
    assert.equal(argValue(execCalls(fd).at(-1), "-u"), "agent");
    const r = await commandRun(inst, o.location, "true", [], { asUser: "root" });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(argValue(execCalls(fd).at(-1), "-u"), "root");
    await assert.rejects(commandRun(inst, o.location, "true", [], { asUser: "admin" }), /asUser/);
    // gitRun knows no root (git never runs as root).
    await gitRun(inst, o.location, ["--version"], { asUser: "root" });
    assert.equal(argValue(execCalls(fd).at(-1), "-u"), "agent");
    // The group kill of a root start runs as root.
    const t = gate(o.location, "gate-4");
    const marker = path.join(o.location, "running-4");
    const ac = new AbortController();
    const run = commandRun(inst, o.location, "sh", ["-c", `echo da > '${marker}'; read x < '${t.path}'`], { signal: ac.signal, asUser: "root", timeout: RIPCORD_MS });
    await waitForTruthy(() => fs.existsSync(marker), "the root command runs");
    const killsPrior = killCalls(fd).length;
    ac.abort();
    const r2 = await run;
    assert.equal(r2.aborted, true, JSON.stringify(r2));
    await waitForTruthy(() => killCalls(fd).length > killsPrior, "Gruppen-Kill");
    assert.equal(argValue(killCalls(fd)[killsPrior], "-u"), "root", "the group kill of a root start did not go as root");
  });
});

// ── (5) access per host including port ────────────────────────────────────────────────────────────────────────────────────────────
test("(5) accessAsEnvironment: a key of its own per host with port — only the right host (with port) gets its token, no value in the argv; counter-test: without port the helper does not answer for :8443", async () => {
  await unit(async ({ fd, o, inst }) => {
    const dir = path.join(o.location, "empty-5");
    fs.mkdirSync(dir);
    const G1 = `${SECRET}-eins`;
    const G2 = `${SECRET}-two`;
    const env = accessAsEnvironment([
      { host: "Git.Example.invalid:8443", access: { username: "one", secret: G1 } },
      { host: "other.invalid", access: { username: "two", secret: G2 } },
      { host: "other.invalid", access: { username: "duplicate", secret: "x" } }, // the same host: the first one counts
      { host: "no host/with path", access: { username: "broken", secret: "y" } }, // no valid host: no helper
      { host: "without-user.invalid", access: { secret: "z" } },
    ]);
    assert.equal(env.GIT_CONFIG_COUNT, "5");
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => env[`GIT_CONFIG_KEY_${i}`]), [
      "credential.helper", "credential.useHttpPath", "http.followRedirects",
      "credential.https://git.example.invalid:8443.helper", "credential.https://other.invalid.helper",
    ]);
    assert.equal(env.GIT_CONFIG_VALUE_0, "");
    for (const i of [3, 4]) assert.ok(!env[`GIT_CONFIG_VALUE_${i}`].includes(G1) && !env[`GIT_CONFIG_VALUE_${i}`].includes(G2), "a value in the helper text");
    const fill = async (host, e = env) => {
      const r = await gitRun(inst, dir, ["credential", "fill"], { stdin: `protocol=https\nhost=${host}\npath=group/repo.git\n\n`, env: e });
      const rows = r.stdout.split("\n");
      return { code: r.code, user: rows.find((z) => z.startsWith("username="))?.slice(9) ?? null, pw: rows.find((z) => z.startsWith("password="))?.slice(9) ?? null };
    };
    assert.deepEqual(await fill("git.example.invalid:8443"), { code: 0, user: "one", pw: G1 });
    assert.deepEqual(await fill("other.invalid"), { code: 0, user: "two", pw: G2 });
    for (const host of ["git.example.invalid", "foreign.invalid", "andere.invalid:8443"]) {
      const r = await fill(host);
      assert.notEqual(r.code, 0, `${host}: git got an answer (${JSON.stringify(r)})`);
      assert.equal(r.pw, null, `${host}: a token (or the inherited helper) answered`);
    }
    // Built-in counter-test: the same helper WITHOUT port in the key does not answer for `:8443` — the port must be in the key.
    const withoutPort = { ...env, GIT_CONFIG_KEY_3: "credential.https://git.example.invalid.helper" };
    assert.equal((await fill("git.example.invalid:8443", withoutPort)).pw, null, "a helper without port applied at :8443 — the port in the key proves nothing");
    assert.equal((await fill("git.example.invalid", withoutPort)).pw, G1, "the counter-test itself is broken");
    for (const a of fd.calls()) assert.ok(!JSON.stringify(a.args).includes(SECRET), `secret in the argv: ${JSON.stringify(a.args).slice(0, 300)}`);
    assert.deepEqual(accessAsEnvironment([]), {});
    assert.throws(() => accessAsEnvironment({ username: "one", secret: G1 }), /list form/);
  });
});

// ── (6) pull/fetch/push with access ──────────────────────────────────────────────────────────────────────────────────────────
// A wrapper `git` on the PATH of the container writes per top-level call the configuration from the environment (key=value — the
// values are helper texts made of variable names, never a token) and then starts the real git.
function configWrapper(location) {
  const bin = path.join(location, "config-bin");
  fs.mkdirSync(bin);
  const log = path.join(location, "config.log");
  fs.writeFileSync(log, "");
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
if [ -z "$CONFIG_WRAPPER_IN" ]; then
  CONFIG_WRAPPER_IN=1; export CONFIG_WRAPPER_IN
  z="AUFRUF	$1"
  i=0
  while [ "$i" -lt "\${GIT_CONFIG_COUNT:-0}" ]; do
    eval "k=\\\${GIT_CONFIG_KEY_$i-}; v=\\\${GIT_CONFIG_VALUE_$i-}"
    z="$z
KONFIG	$k	$v"
    i=$((i+1))
  done
  printf '%s\\n' "$z" >> '${log}'
fi
exec '${REAL_GIT}' "$@"
`, { mode: 0o755 });
  const read = () => {
    const out = [];
    for (const z of fs.readFileSync(log, "utf8").split("\n")) {
      if (z.startsWith("AUFRUF\t")) out.push({ command: z.slice(7), config: [] });
      else if (z.startsWith("KONFIG\t") && out.length) { const [, k, ...v] = z.split("\t"); out.at(-1).config.push([k, v.join("\t")]); }
    }
    return out;
  };
  return { bin, read };
}

test("(6) pull/fetch/push with access carry no hostless credential.helper with a value — only the clearing and the helper of the remote host; without auth.host no access", async () => {
  let wrapper = null;
  await unit(async ({ o, inst }) => {
    const P = path.join(o.location, "proj6");
    const A = path.join(P, "app");
    createRepo(A, o.env, { remote: path.join(o.location, "remote6.git") });
    const auth = { askpass: path.join(o.location, "askpass"), username: "user", secret: SECRET, host: "git.example.invalid:8443" };
    const including = { instance: inst };
    await gitModule.gitFetch(P, "app", auth, including);
    await gitModule.gitPull(P, "app", auth, including);
    fs.writeFileSync(path.join(A, "fresh.txt"), "n\n");
    await gitModule.gitCommit(P, "app", "fresh", { all: true, push: true, auth, ...including });
    await gitModule.gitPush(P, "app", auth, including);
    const network = wrapper.read().filter((a) => ["fetch", "pull", "push"].includes(a.command));
    assert.deepEqual([...new Set(network.map((a) => a.command))].sort(), ["fetch", "pull", "push"], JSON.stringify(network.map((a) => a.command)));
    for (const a of network) {
      const helper = a.config.filter(([k]) => k === "credential.helper");
      assert.deepEqual(helper, [["credential.helper", ""]], `${a.command}: hostless helper with a value — ${JSON.stringify(a.config)}`);
      const perHost = a.config.filter(([k]) => /^credential\..+\.helper$/.test(k));
      assert.deepEqual(perHost.map(([k]) => k), ["credential.https://git.example.invalid:8443.helper"], `${a.command}: ${JSON.stringify(a.config)}`);
      assert.ok(!JSON.stringify(a.config).includes(SECRET), "a value in the configuration");
    }
    // Without auth.host (no remote host known): no access in the container — never a helper for every host.
    const prior = wrapper.read().length;
    await gitModule.gitFetch(P, "app", { ...auth, host: undefined }, including);
    const without = wrapper.read().slice(prior).filter((a) => a.command === "fetch");
    assert.equal(without.length, 1);
    assert.deepEqual(without[0].config, [], `without a host an access anyway: ${JSON.stringify(without[0].config)}`);
    // gitRemoteTarget: the host lowercase and with port (the helper's key), `host` lowercase too (the lookup of the access).
    execFileSync(REAL_GIT, ["remote", "set-url", "origin", "https://Git.Example.invalid:8443/gruppe/app.git"], { cwd: A, env: { ...process.env, ...o.env } });
    assert.deepEqual(await gitModule.gitRemoteTarget(P, "app"), { host: "git.example.invalid", hostWithPort: "git.example.invalid:8443" });
    execFileSync(REAL_GIT, ["remote", "set-url", "origin", "git@gitlab.example.invalid:group/app.git"], { cwd: A, env: { ...process.env, ...o.env } });
    assert.deepEqual(await gitModule.gitRemoteTarget(P, "app"), { host: "gitlab.example.invalid", hostWithPort: "gitlab.example.invalid" });
  }, { containerEnv: (o) => { wrapper = configWrapper(o.location); return { PATH: `${wrapper.bin}${path.delimiter}${process.env.PATH}` }; } });
});

// ── (7) gitSubmoduleUpdate with an instance ──────────────────────────────────────────────────────────────────────────────
test("(7) gitSubmoduleUpdate with an instance: in the container, without deadline, with the access of the submodule host — per host its helper, no value in the argv", async () => {
  let wrapper = null;
  await unit(async ({ fd, o, inst }) => {
    const S = path.join(o.location, "sub7");
    createRepo(S, o.env, { remote: path.join(o.location, "sub7.git") });
    const P = path.join(o.location, "proj7");
    const A = path.join(P, "app");
    createRepo(A, o.env, { remote: path.join(o.location, "remote7.git") });
    fs.writeFileSync(path.join(A, ".gitmodules"), "[submodule \"lib\"]\n\tpath = lib\n\turl = https://sub.example.invalid/o/sub.git\n");
    realGit(A, ["update-index", "--add", "--cacheinfo", `160000,${realGit(S, ["rev-parse", "HEAD"], o.env).trim()},lib`], o.env);
    realGit(A, ["add", ".gitmodules"], o.env);
    realGit(A, ["commit", "-q", "-m", "submodule"], o.env);
    // In the container the https address points to the bare repo (insteadOf), the file protocol is allowed there.
    fs.appendFileSync(path.join(o.location, "c.gitconfig"), `[url "file://${path.join(o.location, "sub7.git")}"]\n\tinsteadOf = https://sub.example.invalid/o/sub.git\n[protocol "file"]\n\tallow = always\n`);
    const asked = [];
    const accessesFor = (hosts) => { asked.push(hosts); return [{ host: "sub.example.invalid", access: { username: "subuser", secret: SECRET } }]; };
    const { result, values } = await deadlinesDuring(() => gitModule.gitSubmoduleUpdate(P, "app", { instance: inst, accessesFor }));
    assert.deepEqual(result, { ok: true });
    assert.equal(fs.readFileSync(path.join(A, "lib", "a.txt"), "utf8"), "a\n", "the submodule is there");
    assert.equal(asked.length, 1);
    assert.ok(asked[0].includes("sub.example.invalid"), `the hosts from .gitmodules are missing: ${JSON.stringify(asked)}`);
    const sub = wrapper.read().filter((a) => a.command === "submodule");
    assert.equal(sub.length, 1, JSON.stringify(wrapper.read().map((a) => a.command)));
    assert.deepEqual(sub[0].config.filter(([k]) => /^credential\..+\.helper$/.test(k)).map(([k]) => k), ["credential.https://sub.example.invalid.helper"], JSON.stringify(sub[0].config));
    assert.ok(!values.includes(120000) && !values.includes(GIT_RUN_CAP_MS), `the submodule update ran with a deadline: ${JSON.stringify(values)}`);
    assert.ok(execCalls(fd).some((a) => a.args.includes("submodule") && a.args.includes("update")), "not via docker exec");
    for (const a of fd.calls()) assert.ok(!JSON.stringify(a.args).includes(SECRET) && !JSON.stringify(a.args).includes("subuser"), `a value in the argv: ${JSON.stringify(a.args).slice(0, 300)}`);
  }, { containerEnv: (o) => { wrapper = configWrapper(o.location); return { PATH: `${wrapper.bin}${path.delimiter}${process.env.PATH}` }; } });
});

// ── (8) gitPull holt LFS (AN-23) ────────────────────────────────────────────────────────────────────────────────────────────
test("(8) gitPull with an instance: afterwards LFS with the same access (helper of the remote host, SKIP_SMUDGE=0, in the container); if LFS fails, the pull raises named; a repo without an LFS file asks no lfs pull, one with an LFS file after every pull", async () => {
  let lfs = null;
  await unit(async ({ o, inst }) => {
    const P = path.join(o.location, "proj8");
    const A = path.join(P, "app");
    const R = path.join(o.location, "remote8.git");
    createRepo(A, o.env, { remote: R });
    const Z = path.join(o.location, "second8");
    realGit(o.location, ["clone", "-q", R, Z], o.env);
    const shift = (file, content) => {
      fs.writeFileSync(path.join(Z, file), content);
      realGit(Z, ["add", "-A"], o.env);
      realGit(Z, ["commit", "-q", "-m", file], o.env);
      realGit(Z, ["push", "-q"], o.env);
    };
    const auth = { askpass: path.join(o.location, "askpass"), username: "user", secret: SECRET, host: "git.example.invalid:8443" };
    const pulls = () => lfsCalls(lfs.log).filter((a) => a.command === "pull");
    // A repo without an LFS file: ls-files (in the container), but no lfs pull.
    shift("small.txt", "klein\n");
    await gitModule.gitPull(P, "app", auth, { instance: inst });
    assert.deepEqual(lfsCalls(lfs.log).map((a) => `${a.where} ${a.command}`), ["container ls-files"], "a repo without an LFS file fetched LFS");
    fs.writeFileSync(path.join(Z, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    shift("large.bin", pointer("c".repeat(64)));
    assert.deepEqual(await gitModule.gitPull(P, "app", auth, { instance: inst }), { ok: true });
    assert.equal(fs.readFileSync(path.join(A, "large.bin"), "utf8"), `LFS-CONTENT ${"c".repeat(64)}\n`, "the pull left a pointer behind");
    assert.equal(pulls().length, 1);
    const p = pulls()[0];
    assert.equal(p.cwd, fs.realpathSync(A));
    assert.equal(p.where, "container");
    assert.ok(p.key.includes("credential.https://git.example.invalid:8443.helper"), JSON.stringify(p));
    assert.deepEqual(p.user, ["user"]);
    assert.equal(p.skip, "0");
    // A pull without a NEW LFS file in a repo WITH an LFS file: ls-files names the file (fetched or not, like the real git-lfs), so
    // again an lfs pull — without effect (the file stays as it is).
    shift("small2.txt", "klein\n");
    await gitModule.gitPull(P, "app", auth, { instance: inst });
    assert.equal(pulls().length, 2, "ls-files no longer names a fetched LFS file — the real git-lfs does");
    assert.equal(fs.readFileSync(path.join(A, "large.bin"), "utf8"), `LFS-CONTENT ${"c".repeat(64)}\n`);
    // If the fetch fails: the pull throws named (the changes are already there).
    lfsFails(lfs.log, "batch response: broken\n");
    shift("still.bin", pointer("e".repeat(64)));
    await assert.rejects(gitModule.gitPull(P, "app", auth, { instance: inst }), /LFS-Dateien kamen nicht: batch response: broken/);
    assert.ok(fs.existsSync(path.join(A, "still.bin")), "the pull itself ran");
  }, { containerEnv: (o) => { lfs = { bin: path.join(o.location, "lfs-bin"), log: path.join(o.location, "lfs.jsonl") }; fakeLfs(lfs.bin, lfs.log); return { PATH: `${lfs.bin}${path.delimiter}${process.env.PATH}` }; } });
});

// ── (9) pull/fetch with the accesses of all hosts ───────────────────────────────────────────────────────────────
test("(9) gitPull/gitFetch with an instance and accessesFor: helpers for remote and submodule hosts, the LFS fetch afterwards for remote and .lfsconfig (lfs.url, lfs.pushurl) — push only the remote host; without accessesFor only the remote host (counter-test); gitErrPayload names the host from the message", async () => {
  let wrapper = null;
  let lfs = null;
  await unit(async ({ fd, o, inst }) => {
    const P = path.join(o.location, "proj9");
    const A = path.join(P, "app");
    const R = path.join(o.location, "remote9.git");
    createRepo(A, o.env, { remote: R });
    const Z = path.join(o.location, "second9");
    realGit(o.location, ["clone", "-q", R, Z], o.env);
    const shift = (files) => {
      realGit(Z, ["pull", "-q", "--ff-only"], o.env); // A pushes by itself in between (gitPush below)
      for (const [d, content] of Object.entries(files)) fs.writeFileSync(path.join(Z, d), content);
      realGit(Z, ["add", "-A"], o.env);
      realGit(Z, ["commit", "-q", "-m", Object.keys(files).join(" ")], o.env);
      realGit(Z, ["push", "-q"], o.env);
    };
    const auth = { askpass: path.join(o.location, "askpass"), username: "user", secret: SECRET, host: "git.example.invalid:8443" };
    const asked = [];
    const accessesFor = (hosts) => { asked.push([...hosts]); return hosts.map((h) => ({ host: h, access: { username: `u-${h}`, secret: `${SECRET}-${h}` } })); };
    const including = { instance: inst, accessesFor };
    const helper = (config) => config.filter(([k]) => /^credential\..+\.helper$/.test(k)).map(([k]) => k);
    const lfsPulls = () => lfsCalls(lfs.log).filter((a) => a.command === "pull");
    const REMOTE = "credential.https://git.example.invalid:8443.helper";
    const SUB = "credential.https://sub.example.invalid.helper";
    const LFS_URL = "credential.https://lfs.example.invalid.helper";
    const LFS_PUSH = "credential.https://push.example.invalid:8443.helper";

    // Round 1: the pull brings .gitmodules, .lfsconfig and an LFS file. gitPull reads the hosts of the LFS fetch AFTER the pull.
    shift({
      ".gitmodules": "[submodule \"lib\"]\n\tpath = lib\n\turl = https://sub.example.invalid/o/sub.git\n",
      ".lfsconfig": "[lfs]\n\turl = https://lfs.example.invalid/o/r.git/info/lfs\n\tpushurl = https://push.example.invalid:8443/o/r.git/info/lfs\n",
      ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      "large.bin": pointer("9".repeat(64)),
    });
    assert.deepEqual(await gitModule.gitPull(P, "app", auth, including), { ok: true });
    assert.equal(fs.readFileSync(path.join(A, "large.bin"), "utf8"), `LFS-CONTENT ${"9".repeat(64)}\n`);
    const l1 = lfsPulls().at(-1);
    for (const k of [REMOTE, LFS_URL, LFS_PUSH]) assert.ok(l1.key.includes(k), `LFS fetch without ${k} (.lfsconfig not read after the pull?): ${JSON.stringify(l1.key)}`);
    assert.ok(!l1.key.includes(SUB), "the LFS fetch carries the submodule host — it does not need it");
    assert.deepEqual(l1.user, ["user", "u-lfs.example.invalid", "u-push.example.invalid:8443"]);

    // Round 2: now .gitmodules is in the repo — pull and fetch carry the submodule host (git fetches submodules on demand at fetch).
    shift({ "small.txt": "klein\n" });
    await gitModule.gitPull(P, "app", auth, including);
    await gitModule.gitFetch(P, "app", auth, including);
    fs.writeFileSync(path.join(A, "own.txt"), "e\n");
    realGit(A, ["add", "own.txt"], o.env);
    realGit(A, ["commit", "-q", "-m", "own"], o.env);
    await gitModule.gitPush(P, "app", auth, including);
    const network = (command) => wrapper.read().filter((a) => a.command === command);
    assert.deepEqual(helper(network("pull").at(-1).config), [REMOTE, SUB], JSON.stringify(network("pull").at(-1).config));
    assert.deepEqual(helper(network("fetch").at(-1).config), [REMOTE, SUB], JSON.stringify(network("fetch").at(-1).config));
    assert.deepEqual(helper(network("push").at(-1).config), [REMOTE], "push carries more than the host of the remote");
    assert.ok(asked.some((h) => h.includes("sub.example.invalid")), JSON.stringify(asked));
    for (const a of [...network("pull"), ...network("fetch"), ...network("push")]) assert.ok(!JSON.stringify(a.config).includes(SECRET), "a value in the configuration");
    for (const a of fd.calls()) assert.ok(!JSON.stringify(a.args).includes(SECRET) && !JSON.stringify(a.args).includes("u-sub"), `a value in the argv: ${JSON.stringify(a.args).slice(0, 300)}`);

    // Built-in counter-test: without accessesFor only the remote host — in the pull, in the fetch and in the LFS fetch.
    shift({ "still.txt": "n\n" });
    await gitModule.gitPull(P, "app", auth, { instance: inst });
    await gitModule.gitFetch(P, "app", auth, { instance: inst });
    assert.deepEqual(helper(network("pull").at(-1).config), [REMOTE]);
    assert.deepEqual(helper(network("fetch").at(-1).config), [REMOTE]);
    const l3 = lfsPulls().at(-1);
    assert.ok(l3.key.includes(REMOTE) && !l3.key.includes(LFS_URL), `the counter-test does not apply: ${JSON.stringify(l3.key)}`);
  }, { containerEnv: (o) => {
    wrapper = configWrapper(o.location);
    lfs = { bin: path.join(o.location, "lfs-bin"), log: path.join(o.location, "lfs.jsonl") };
    fakeLfs(lfs.bin, lfs.log);
    return { PATH: [wrapper.bin, lfs.bin, process.env.PATH].join(path.delimiter) };
  } });

  // gitErrPayload (workspaces/git-auth.js): the host git NAMES — lowercase, without port; else that of the remote.
  const auth = (text, host = "remote.invalid") => gitErrPayload(new Error(text), host);
  assert.deepEqual(auth("fatal: could not read Username for 'https://Sub.Example.invalid:8443': terminal prompts disabled"),
    { error: "fatal: could not read Username for 'https://Sub.Example.invalid:8443': terminal prompts disabled", authRequired: true, host: "sub.example.invalid", ssh: false });
  assert.equal(auth("remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitlab.com/g/r.git/'").host, "gitlab.com");
  assert.equal(auth("fatal: could not read Password for 'https://user@git.x.invalid': terminal prompts disabled").host, "git.x.invalid");
  assert.equal(auth("git@h: Permission denied (publickey).").host, "remote.invalid", "without an address in the message: the host of the remote");
  assert.equal(auth("fatal: could not read Username for 'http://h.invalid': terminal prompts disabled").host, "remote.invalid", "http is no host of an access");
  assert.equal(auth("fatal: Authentication failed for 'https://h_under.invalid/x'").host, "remote.invalid", "a host outside HOST_WITH_PORT");
  assert.equal(auth("fatal: Authentication failed for 'https://h_under.invalid/x'", "").host, "");
  assert.deepEqual(auth("fatal: not a git repository"), { error: "fatal: not a git repository" });
  // Counter-test against the old body (always the host of the remote): it does not name the rejected submodule host.
  const prior = (e, host) => ({ error: String(e?.message || e), authRequired: true, host: host || "", ssh: false });
  assert.notEqual(prior(new Error("fatal: could not read Username for 'https://sub.example.invalid': x"), "remote.invalid").host,
    auth("fatal: could not read Username for 'https://sub.example.invalid': x").host);
});

// ── (10) the helper of the management git is silent after a rejection ─────────────────────────────────────────
// The old helper: `printf` on EVERY action — the counter-test.
const HELPER_PRIOR = (i) => `!f() { printf 'username=%s\\npassword=%s\\n' "$CBASE_GIT_USERNAME_${i}" "$CBASE_GIT_PASSWORD_${i}"; }; f`;
// The same environment, only the helper of the host exchanged.
function withHelper(env, host, text) {
  const i = Object.keys(env).find((k) => /^GIT_CONFIG_KEY_\d+$/.test(k) && env[k] === `credential.https://${host}.helper`).slice("GIT_CONFIG_KEY_".length);
  return { ...env, [`GIT_CONFIG_VALUE_${i}`]: text };
}
test("(10) gitHelper: get, erase, get with real git — the second get stays without answer, the marker is a path under /tmp, a failed run clears it in the container; counter-test: the old helper answers again", async () => {
  await unit(async ({ fd, o, inst }) => {
    const dir = path.join(o.location, "empty-10");
    fs.mkdirSync(dir);
    const G = `${SECRET}-zehn`;
    const H = "git.example.invalid";
    const question = `protocol=https\nhost=${H}\npath=o/r.git\n\n`;
    const rejected = `protocol=https\nhost=${H}\npath=o/r.git\nusername=ten\npassword=${G}\n\n`;
    const fill = async (env) => {
      const r = await gitRun(inst, dir, ["credential", "fill"], { stdin: question, env });
      return { code: r.code, pw: r.stdout.split("\n").find((z) => z.startsWith("password="))?.slice(9) ?? null };
    };
    const fresh = () => accessAsEnvironment([{ host: H, access: { username: "ten", secret: G } }]);
    const env = fresh();
    const [marker] = accessMarkers(env);
    assert.match(marker, /^\/tmp\/cbase-git-rejected-[0-9a-f]{24}-0$/, "the marker is no fresh path under /tmp");
    assert.ok(!marker.includes(G) && !marker.includes("ten"), "a value in the path of the marker");
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(await fill(env), { code: 0, pw: G }, "the first get got no access");
    const rej = await gitRun(inst, dir, ["credential", "reject"], { stdin: rejected, env });
    assert.equal(rej.code, 0, rej.stderr);
    assert.equal(fs.existsSync(marker), true, "erase did not create the marker");
    const second = await fill(env);
    assert.equal(second.pw, null, "after erase the helper answered again — git-lfs circled endlessly");
    assert.notEqual(second.code, 0);
    // The run failed: gitRun clears the marker IN the container (via docker exec, `rm -f --`).
    assert.equal(fs.existsSync(marker), false, "the marker stayed after the failed run");
    assert.ok(execCalls(fd).some((a) => a.args.includes("rm") && a.args.includes("-f") && a.args.includes("--") && a.args.includes(marker)), "no rm of the marker in the container");
    // store does nothing (no marker), and a fresh access (new marker) answers.
    const env2 = fresh();
    assert.notEqual(accessMarkers(env2)[0], marker, "the marker is not fresh per call");
    assert.equal((await gitRun(inst, dir, ["credential", "approve"], { stdin: rejected, env: env2 })).code, 0);
    assert.equal(fs.existsSync(accessMarkers(env2)[0]), false, "store created a marker");
    assert.equal((await fill(env2)).pw, G);
    // Without a marker in the environment (a caller that sets the helper itself) it answers as before — also after an erase.
    const withoutMarker = Object.fromEntries(Object.entries(fresh()).filter(([k]) => !/^CBASE_GIT_REJECTED_/.test(k)));
    assert.ok(Object.values(withoutMarker).includes(gitHelper(0)), "the environment does not carry the helper");
    assert.equal((await fill(withoutMarker)).pw, G);
    assert.equal((await gitRun(inst, dir, ["credential", "reject"], { stdin: rejected, env: withoutMarker })).code, 0);
    assert.equal((await fill(withoutMarker)).pw, G, "without a marker the helper was silent");
    // Counter-test: the same sequence with the old helper — the second get answers again.
    const old = withHelper(fresh(), H, HELPER_PRIOR(0));
    assert.equal((await fill(old)).pw, G);
    assert.equal((await gitRun(inst, dir, ["credential", "reject"], { stdin: rejected, env: old })).code, 0);
    assert.equal((await fill(old)).pw, G, "the counter-test does not apply: the old helper was silent after erase");
    for (const a of fd.calls()) assert.ok(!JSON.stringify(a.args).includes(G), `a value in the argv: ${JSON.stringify(a.args).slice(0, 300)}`);
  });
});

// ── (11) networkHosts with .lfsconfig, hostFromAddress, store.gitAccessesFor ──────────────────────────────────────────
test("(11) networkHosts { lfs: true } reads lfs.url, lfs.pushurl and remote.<n>.lfsurl from .lfsconfig (additional hosts); hostFromAddress and store.gitAccessesFor as units", async () => {
  await unit(async ({ o, inst }) => {
    const A = path.join(o.location, "proj11", "app");
    createRepo(A, o.env);
    realGit(A, ["remote", "add", "origin", "https://Git.Example.invalid/o/r.git"], o.env);
    fs.writeFileSync(path.join(A, ".lfsconfig"), "[lfs]\n\turl = https://lfs.example.invalid/o/r.git/info/lfs\n\tpushurl = https://push.example.invalid:8443/x\n[remote \"origin\"]\n\tlfsurl = https://rl.example.invalid/y\n");
    assert.deepEqual(await networkHosts(inst, A), ["git.example.invalid"], "without lfs networkHosts reads .lfsconfig");
    assert.deepEqual((await networkHosts(inst, A, { lfs: true })).sort(),
      ["git.example.invalid", "lfs.example.invalid", "push.example.invalid:8443", "rl.example.invalid"]);
  });
  // hostFromAddress: https with port (lowercase, without 443), ssh and scp only the name, everything else null.
  for (const [url, host] of [
    ["https://Git.Example.invalid:8443/o/r.git", "git.example.invalid:8443"],
    ["https://h.invalid:443/x", "h.invalid"],
    ["https://user:pw@h.invalid/x", "h.invalid"],
    ["ssh://git@H.invalid:2222/o/r.git", "h.invalid"],
    ["git@H.invalid:o/r.git", "h.invalid"],
    ["http://h.invalid/x", null],
    ["file:///tmp/x.git", null],
    ["ext::sh -c x", null],
    ["../x.git", null],
    ["/abs/x.git", null],
    ["C:/x", null],
    ["https://[fd00::1]/x", null],
    ["", null],
    [null, null],
  ]) assert.equal(hostFromAddress(url), host, JSON.stringify(url));
  // store.gitAccessesFor: looked up under the host name (lowercase, without port), key stays host[:port]; a host without access is missing;
  // duplicates once; without a workspace nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-accesses-"));
  try {
    store.initStore(dir);
    store.createWorkspace({ id: "ws11", name: "W", path: path.join(dir, "ws"), createdAt: 1 });
    store.setGitCred("ws11", "git.example.invalid", "one", "g1");
    store.setGitCred("ws11", "sub.example.invalid", "two", "");
    assert.deepEqual(store.gitAccessesFor("ws11", ["Git.Example.invalid:8443", "git.example.invalid:8443", "foreign.invalid", "sub.example.invalid"]), [
      { host: "git.example.invalid:8443", access: { username: "one", secret: "g1" } },
      { host: "sub.example.invalid", access: { username: "two", secret: "" } },
    ]);
    assert.deepEqual(store.gitAccessesFor("", ["git.example.invalid"]), []);
    assert.deepEqual(store.gitAccessesFor("ws11", null), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
