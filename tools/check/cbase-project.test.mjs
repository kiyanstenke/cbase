// The command `cbase-project` (server/backend/cbase-project). server/backend/ lies in no glob of the gate, so the guard lives here
// (like wrapper.test.mjs). The REAL file runs as a child process against the fake docker (server/backend/test/fake-docker.mjs, via
// CBASE_DOCKER_BIN) and a fake API (port 0, base via CBASE_PROJECT_API).
//
// Contract: the command never starts with `-t` without a TTY and passes the exit code through. Held:
//   - pure resolution: id (no prefix), name, `<slug>.cbase` with and without suffix; ambiguous => the workspace or project of
//     the current folder, else exit 2 with a candidate list; unknown, not switched over => exit 2; `/<copy>` only with an entry
//     in `instance.copies`, else exit 2 with the list of copies, a name outside the form likewise; the call hits the container
//     via `cbase.instance=copy-<name>` (with and without backend);
//   - the arguments: `--` mandatory, without a command `bash -l`; `-t` exactly when stdin and stdout are a TTY (pure, both
//     cases); `-u agent` always; `-e TERM` without `=`;
//   - the call against fake docker and fake API without a TTY: no `-t`, `-w` = $PWD inside or the project folder outside,
//     TERM arrives, stdin passes through (`-i`), exit codes 7 and 143 passed on; ambiguous/not switched over => no docker call;
//   - backend unreachable => only via the id, `docker ps` with both labels, `-w` only in a bind mount of the same path;
//   - the address of the backend: fixed 127.0.0.1:7718, only `CBASE_PROJECT_API` changes it — never the user's `PORT`
//     (counter-proof: a copy with the old `env.PORT || 7718` is red);
//   - in the backend image under /usr/bin (not /usr/local/bin, not in the projectbox), `node --check` in the build; build context
//     (build.sh) and build-context-files.json (the deploy uploads that list).
//   - the working folder: compared PHYSICALLY (the wrapper cbase-git changes with `pwd -P`) and converted to the form of the root
//     it hangs on in the container (the store form, not the physical one); roots are the project folder and the project's lines
//     from the list of cbase-git (the worktree folder of the runtime folder); with `--git-access` outside every root exit 128
//     without a docker call, without the option the project folder as before.
// Counter-proof (in the test): a copy with a fixed `-t` (like "docker exec -it") is red without a TTY.
// COUNTER-PROOFS by hand (each shown red, then reverted):
//   cbase-project: exit code 0 instead of docker's code   => "call without TTY …" and "backend unreachable …" red
//   cbase-project: `-w` always the project folder          => "arguments …" and "call without TTY …" red
//
// Run:  node --test --test-reporter=tap tools/check/cbase-project.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fakeDocker } from "../../server/backend/test/fake-docker.mjs";
import { dockerfileStages } from "./lib/projectbox.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SCRIPT = path.join(REPO, "server/backend/cbase-project");
const { Abort, apiBase, workingFolder, dockerArgs, inContainer, readArgs, resolve: resolveValue, folderFromMounts } = await import(pathToFileURL(SCRIPT).href);

// ── data like `GET /api/projects` / `GET /api/workspaces` ─────────────────────────────────────────────────────────────
const ID_A = "0a3c5e1e-1111-4a4a-8b8b-000000000001";
const ID_B = "0a3c5e1e-2222-4a4a-8b8b-000000000002";
const ID_L = "0a3c5e1e-3333-4a4a-8b8b-000000000003";
const ID_N = "0a3c5e1e-4444-4a4a-8b8b-000000000004";
const instance = (id, name, converted = true, state = "ready") => ({ identifier: `${id}/main`, state, converted, name, container: `cbase-p-${id}` });
function data(root) {
  const ws1 = { id: "w1", name: "Load", path: path.join(root, "load") };
  const ws2 = { id: "w2", name: "Stock", path: path.join(root, "stock") };
  const projects = [
    { id: ID_A, name: "Register", path: path.join(ws1.path, "till"), workspaceId: "w1", workspaceName: "Load",
      instance: { ...instance(ID_A, "till.cbase"), copies: [{ identifier: `${ID_A}/copy-k1`, name: "k1.till.cbase", chatId: "c1", state: "ready" }] } },
    { id: ID_B, name: "Register", path: path.join(ws2.path, "till"), workspaceId: "w2", workspaceName: "Stock", instance: instance(ID_B, "till-2.cbase") },
    { id: ID_L, name: "Stockkeeping", path: path.join(ws2.path, "lv"), workspaceId: "w2", workspaceName: "Stock", instance: instance(ID_L, "stockkeeping.cbase") },
    { id: ID_N, name: "Notes", path: path.join(ws1.path, "notes"), workspaceId: "w1", workspaceName: "Load" },
  ];
  for (const p of projects) fs.mkdirSync(path.join(p.path, "sub"), { recursive: true });
  return { projects, workspaces: [ws1, ws2] };
}
const throwsAbort = (fn, pattern) => assert.throws(fn, (e) => e instanceof Abort && e.code === 2 && pattern.test(e.message));

test("resolution: id, name, .cbase name — unique, ambiguous (folder decides), unknown, copy, not switched over", () => {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-project-rein-"));
  try {
    const d = data(w);
    const [a, b, l] = d.projects;
    const including = (target, pwd = "/") => resolveValue({ ...d, target, pwd }).project.id;
    assert.equal(including(ID_B), ID_B, "the id");
    assert.equal(including("Stockkeeping"), ID_L, "the name");
    assert.equal(including("stockkeeping"), ID_L, "the name regardless of case");
    assert.equal(including("till-2.cbase"), ID_B, "the .cbase name");
    assert.equal(including("till-2"), ID_B, "the .cbase name without suffix");
    assert.equal(including("TILL-2.CBASE"), ID_B);
    throwsAbort(() => including(ID_A.slice(0, 8)), /no project/); // no prefix: half an id would eventually hit another
    // ambiguous: "Register" exists in both workspaces
    throwsAbort(() => including("Register", w), /ambiguous[\s\S]*workspace Load[\s\S]*till\.cbase[\s\S]*workspace Stock[\s\S]*till-2\.cbase/);
    assert.equal(including("Register", path.join(b.path, "sub")), ID_B, "from the project folder");
    assert.equal(including("Register", path.join(d.workspaces[0].path)), ID_A, "from the workspace folder");
    assert.equal(including("Register", path.join(l.path, "sub")), ID_B, "from another project of the same workspace");
    throwsAbort(() => resolveValue({ projects: d.projects, target: "Register", pwd: d.workspaces[0].path }), /ambiguous/); // without workspaces only the project folder
    // unknown: with the list of those switched over
    throwsAbort(() => including("Accounting"), /no project “Accounting”[\s\S]*Converted projects:[\s\S]*stockkeeping\.cbase/);
    throwsAbort(() => resolveValue({ projects: [], target: "x", pwd: "/" }), /No project is converted yet/);
    // Copy: `<project>/<copy>` — only one the project names in `instance.copies`.
    const copy = (target, pwd = "/") => { const r = resolveValue({ ...d, target, pwd }); return [r.project.id, r.copy?.identifier, r.copy?.short]; };
    assert.deepEqual(copy("till.cbase/k1"), [ID_A, `${ID_A}/copy-k1`, "k1"]);
    assert.deepEqual(copy(`${ID_A}/k1`), [ID_A, `${ID_A}/copy-k1`, "k1"], "via the id");
    assert.deepEqual(copy("Register/k1", a.path), [ID_A, `${ID_A}/copy-k1`, "k1"], "ambiguous => the folder decides, also with a copy");
    assert.equal(resolveValue({ ...d, target: "till.cbase", pwd: "/" }).copy, undefined, "without a slash no copy");
    throwsAbort(() => including("till.cbase/k9"), /Register has no copy “k9”\.\nCopies:\n {2}k1 — k1\.till\.cbase \(ready\)/);
    throwsAbort(() => including("till-2/k1"), /Register has no copy “k1” — it has no copies/);
    throwsAbort(() => including("till.cbase/K1"), /“K1” is not a copy name/);
    throwsAbort(() => including("/k1"), /the project is missing before the slash/);
    throwsAbort(() => including("Register/k1", w), /ambiguous/);
    throwsAbort(() => including("Notes/k1"), /is not converted/);
    // not switched over — without a row and with a row before the relocation
    throwsAbort(() => including("Notes"), /is not converted.*does not exist/);
    const beforeRelocation = d.projects.map((p) => (p.id === ID_L ? { ...p, instance: instance(ID_L, "stockkeeping.cbase", false, "relocation") } : p));
    throwsAbort(() => resolveValue({ projects: beforeRelocation, target: "Stockkeeping", pwd: "/" }), /is not converted.*does not exist yet \(state “relocation”\)/);
    assert.equal(a.instance.container, `cbase-p-${ID_A}`);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test("arguments: `--` mandatory, without a command bash -l; -t only with a TTY, -u agent always, -e TERM without =", () => {
  assert.deepEqual(readArgs(["till"]), { target: "till", command: ["bash", "-l"] });
  assert.deepEqual(readArgs(["till", "--"]), { target: "till", command: ["bash", "-l"] });
  assert.deepEqual(readArgs(["till", "--", "docker", "compose", "ps"]), { target: "till", command: ["docker", "compose", "ps"] });
  assert.deepEqual(readArgs(["till", "--", "sh", "--", "-c"]).command, ["sh", "--", "-c"], "a second -- belongs to the command");
  assert.throws(() => readArgs(["till", "ls"]), (e) => e instanceof Abort && e.code === 2 && /“--”/.test(e.message));
  assert.throws(() => readArgs(["--", "ls"]), Abort);
  assert.equal(readArgs(["-h"]).help, true);
  assert.equal(readArgs([]).empty, true);

  const without = dockerArgs({ container: "c", cwd: "/p", command: ["ls"], tty: false });
  const withTty = dockerArgs({ container: "c", cwd: "/p", command: ["ls"], tty: true });
  assert.deepEqual(without, ["exec", "-i", "-u", "agent", "-w", "/p", "-e", "TERM", "c", "ls"]);
  assert.deepEqual(withTty, ["exec", "-i", "-t", "-u", "agent", "-w", "/p", "-e", "TERM", "c", "ls"]);
  assert.deepEqual(dockerArgs({ container: "c", cwd: null, command: ["ls"], tty: false }), ["exec", "-i", "-u", "agent", "-e", "TERM", "c", "ls"]);

  assert.equal(workingFolder("/ws/till/sub", "/ws/till"), "/ws/till/sub");
  assert.equal(workingFolder("/ws/till", "/ws/till"), "/ws/till");
  assert.equal(workingFolder("/ws/till-alt", "/ws/till"), "/ws/till", "a neighbor with the same prefix is outside");
  assert.equal(workingFolder("/ws", "/ws/till"), "/ws/till");
  const binds = [{ Type: "bind", Source: "/ws/till", Destination: "/ws/till" }, { Type: "bind", Source: "/data/x/home/.claude", Destination: "/home/agent/.claude" }, { Type: "volume", Source: "v", Destination: "/var/lib/docker" }];
  assert.equal(folderFromMounts("/ws/till/sub", binds), "/ws/till/sub");
  assert.equal(folderFromMounts("/home/agent/.claude", binds), null, "source ≠ target: it is another folder there");
  assert.equal(folderFromMounts("/ws", binds), null);
});

// The address of the backend used to come from the general `PORT` — a user who sets it in their B shell for their own dev
// server sent the command to the foreign service ("backend unreachable", then only the id). Checked purely: a run without
// CBASE_PROJECT_API asked 127.0.0.1:7718 — on a developer machine the real app.
test("backend address: fixed 7718, only CBASE_PROJECT_API changes it — never the user's PORT", () => {
  assert.equal(apiBase({}), "http://127.0.0.1:7718");
  assert.equal(apiBase({ PORT: "3000" }), "http://127.0.0.1:7718", "the PORT of a dev server steers the command to the foreign service");
  assert.equal(apiBase({ PORT: "3000", CBASE_PROJECT_API: "http://127.0.0.1:9/" }), "http://127.0.0.1:9", "CBASE_PROJECT_API wins");
});

// ── the call: real file, fake docker, fake API ──────────────────────────────────────────────────────────────

async function fakeApi(d, { status = 200 } = {}) {
  const server = http.createServer((req, res) => {
    const body = req.url === "/api/projects" ? d.projects : req.url === "/api/workspaces" ? d.workspaces : null;
    res.writeHead(body ? status : 404, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify(body ?? { error: "not found" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

async function freeDeadPort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

const running = new Set();
function start(script, args, { pwd, env, stdin = "" }) {
  const subprocess = spawn(process.execPath, [script, ...args], {
    cwd: pwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, PWD: pwd, TERM: "cbase-test-term", ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  running.add(subprocess);
  let out = "";
  let err = "";
  subprocess.stdout.on("data", (b) => { out += b; });
  subprocess.stderr.on("data", (b) => { err += b; });
  subprocess.stdin.end(stdin);
  return new Promise((resolve) => subprocess.once("close", (code, signal) => { running.delete(subprocess); resolve({ code, signal, out, err }); }));
}
after(() => { for (const k of running) { try { k.kill("SIGKILL"); } catch { /* already gone */ } } });

// The calls of `cbase-project` to docker (without the test's own): everything from `from`.
const execCalls = (fd, from) => fd.calls({ daemon: "host" }).slice(from).map((a) => a.args);
// The promises about ONE exec call without a TTY — as a function, so the same check turns red on the copy.
function checkWithoutTty(args) {
  const error = [];
  const beforeContainer = args.slice(0, args.findIndex((x) => x.startsWith("cbase-p-") || /^[0-9a-f]{64}$/.test(x)));
  if (beforeContainer.some((x) => x === "-t" || x === "--tty" || /^-[a-z]*t[a-z]*$/.test(x))) error.push(`-t without TTY: ${args.join(" ")}`);
  if (!beforeContainer.includes("-i")) error.push("without -i");
  const u = beforeContainer.indexOf("-u");
  if (u < 0 || beforeContainer[u + 1] !== "agent") error.push("not -u agent");
  beforeContainer.forEach((x, i) => { if (x === "-e" && String(beforeContainer[i + 1]).includes("=")) error.push(`-e with value: ${beforeContainer[i + 1]}`); });
  return error;
}

async function withBuild(fn) {
  const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-project-run-")));
  const d = data(w);
  const fd = await fakeDocker({ images: { "cbase-projectbox:latest": "4f".repeat(32) } });
  const api = await fakeApi(d);
  try {
    for (const p of d.projects.filter((x) => x.instance)) {
      const r = spawnSync(fd.bin, ["run", "-d", "--name", `cbase-p-${p.id}`, "--label", `cbase.project=${p.id}`, "--label", "cbase.instance=main",
        "--mount", `type=bind,source=${p.path},target=${p.path}`, "cbase-projectbox:latest"], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
    // HOME to the throwaway folder: `bash -l` in the fake docker runs locally and would otherwise read the machine's profile.
    const env = { CBASE_DOCKER_BIN: fd.bin, CBASE_PROJECT_API: api.base, HOME: w };
    await fn({ w, d, fd, api, env });
  } finally {
    await api.close();
    fd.cleanUp();
    fs.rmSync(w, { recursive: true, force: true });
  }
}

test("call without TTY: no -t, -u agent, -w inside/outside, TERM and stdin arrive, exit code passed on", async () => {
  await withBuild(async ({ d, fd, env }) => {
    const [tillA, tillB] = d.projects;
    const inside = path.join(tillB.path, "sub");
    let from = fd.calls().length;
    const r = await start(SCRIPT, ["till-2.cbase", "--", "sh", "-c", "pwd -P; echo \"TERM=$TERM\"; cat; exit 7"], { pwd: inside, env, stdin: "through stdin\n" });
    assert.equal(r.code, 7, `exit code not passed on: ${JSON.stringify(r)}`);
    assert.deepEqual(r.out.split("\n"), [inside, "TERM=cbase-test-term", "through stdin", ""], r.err);
    const [a] = execCalls(fd, from);
    assert.deepEqual(a, ["exec", "-i", "-u", "agent", "-w", inside, "-e", "TERM", `cbase-p-${ID_B}`, "sh", "-c", "pwd -P; echo \"TERM=$TERM\"; cat; exit 7"]);
    assert.deepEqual(checkWithoutTty(a), []);

    // outside (in the workspace, not in the project): the project folder; resolved via the workspace of the folder
    from = fd.calls().length;
    const r2 = await start(SCRIPT, ["Register", "--", "sh", "-c", "pwd -P"], { pwd: d.workspaces[0].path, env });
    assert.equal(r2.code, 0, r2.err);
    assert.equal(r2.out.trim(), tillA.path);
    const [a2] = execCalls(fd, from);
    assert.deepEqual(a2.slice(0, 9), ["exec", "-i", "-u", "agent", "-w", tillA.path, "-e", "TERM", `cbase-p-${ID_A}`]);

    // without a command: bash -l (only the call here — bash reads the empty stdin and ends)
    from = fd.calls().length;
    const r3 = await start(SCRIPT, ["stockkeeping"], { pwd: d.workspaces[1].path, env });
    assert.equal(r3.code, 0, r3.err);
    assert.deepEqual(execCalls(fd, from)[0].slice(-2), ["bash", "-l"]);

    // a command that dies on a signal: 128 + 15
    const r4 = await start(SCRIPT, [ID_L, "--", "sh", "-c", "kill -TERM $$"], { pwd: inside, env });
    assert.equal(r4.code, 143, r4.err);
  });
});

test("no docker call: ambiguous, unknown, copy, not switched over, `--` missing — exit 2 with a message", async () => {
  await withBuild(async ({ w, fd, env }) => {
    const from = fd.calls().length;
    for (const [args, pattern] of [
      [["Register", "--", "true"], /ambiguous[\s\S]*till\.cbase[\s\S]*till-2\.cbase/],
      [["Accounting"], /no project “Accounting”/],
      [["till-2/k1"], /no copy “k1”/],
      [["till.cbase/k9"], /no copy “k9”/],
      [["Notes"], /is not converted/],
      [["till-2", "true"], /“--”/],
    ]) {
      const r = await start(SCRIPT, args, { pwd: w, env });
      assert.equal(r.code, 2, `${args.join(" ")}: ${JSON.stringify(r)}`);
      assert.match(r.err, pattern, args.join(" "));
    }
    assert.deepEqual(execCalls(fd, from), [], "docker ran");
  });
});

test("backend unreachable: only via the id, docker ps with both labels, -w only in a bind mount of the same path", async () => {
  await withBuild(async ({ w, d, fd, env }) => {
    const tot = { ...env, CBASE_PROJECT_API: `http://127.0.0.1:${await freeDeadPort()}` };
    const tillB = d.projects[1];
    const inside = path.join(tillB.path, "sub");
    let from = fd.calls().length;
    const r = await start(SCRIPT, [ID_B, "--", "sh", "-c", "pwd -P; exit 3"], { pwd: inside, env: tot });
    assert.equal(r.code, 3, JSON.stringify(r));
    assert.match(r.err, /backend at .* not reachable .* only by project id/);
    assert.equal(r.out.trim(), inside);
    const a = execCalls(fd, from);
    assert.deepEqual(a[0], ["ps", "-a", "-q", "--no-trunc", "--filter", `label=cbase.project=${ID_B}`, "--filter", "label=cbase.instance=main"]);
    const ex = a.find((x) => x[0] === "exec");
    assert.deepEqual(ex.slice(0, 7), ["exec", "-i", "-u", "agent", "-w", inside, "-e"]);
    assert.match(ex[8], /^[0-9a-f]{64}$/, "not after the id of the found container");
    assert.deepEqual(checkWithoutTty(ex), []);

    // outside: no -w, a message
    from = fd.calls().length;
    const r2 = await start(SCRIPT, [ID_B, "--", "true"], { pwd: w, env: tot });
    assert.equal(r2.code, 0, r2.err);
    assert.match(r2.err, /not mounted/);
    assert.ok(!execCalls(fd, from).find((x) => x[0] === "exec").includes("-w"));

    // a name does not work without a backend
    const r3 = await start(SCRIPT, ["till-2.cbase", "--", "true"], { pwd: w, env: tot });
    assert.equal(r3.code, 2);
    assert.match(r3.err, /only by project id/);
  });
});

// `<project>/<copy>` hits the container of the copy — via the labels `cbase.project` and `cbase.instance=copy-<name>`, never the
// main; with a backend via the name, without a backend via `<id>/<copy>`. A copy without a container: exit 2, no exec.
// COUNTER-PROOF: cbase-project at a state before copies existed => red (exit 2, "only with stage 2").
test("<project>/<copy> hits the copy container — with a backend via the name, without via the id; without a container exit 2", async () => {
  await withBuild(async ({ w, d, fd, env }) => {
    const tillA = d.projects[0];
    const r0 = spawnSync(fd.bin, ["run", "-d", "--name", `cbase-k-${ID_A}-k1`, "--label", `cbase.project=${ID_A}`, "--label", "cbase.instance=copy-k1",
      "--label", "cbase.chat=c1", "--mount", `type=bind,source=${tillA.path},target=${tillA.path}`, "cbase-projectbox:latest"], { encoding: "utf8" });
    assert.equal(r0.status, 0, r0.stderr);
    const kid = r0.stdout.trim();
    const inside = path.join(tillA.path, "sub");
    let from = fd.calls().length;
    const r = await start(SCRIPT, ["till.cbase/k1", "--", "sh", "-c", "pwd -P; exit 5"], { pwd: inside, env });
    assert.equal(r.code, 5, `the copy was not hit: ${JSON.stringify(r)}`);
    assert.equal(r.out.trim(), inside);
    const a = execCalls(fd, from);
    assert.deepEqual(a[0], ["ps", "-a", "-q", "--no-trunc", "--filter", `label=cbase.project=${ID_A}`, "--filter", "label=cbase.instance=copy-k1"]);
    const ex = a.find((x) => x[0] === "exec");
    assert.deepEqual(ex.slice(0, 9), ["exec", "-i", "-u", "agent", "-w", inside, "-e", "TERM", kid], "not the container of the copy");
    assert.deepEqual(checkWithoutTty(ex), []);

    // Without a backend: `<id>/<copy>`.
    const tot = { ...env, CBASE_PROJECT_API: `http://127.0.0.1:${await freeDeadPort()}` };
    from = fd.calls().length;
    const r2 = await start(SCRIPT, [`${ID_A}/k1`, "--", "true"], { pwd: inside, env: tot });
    assert.equal(r2.code, 0, r2.err);
    const a2 = execCalls(fd, from);
    assert.deepEqual(a2[0], ["ps", "-a", "-q", "--no-trunc", "--filter", `label=cbase.project=${ID_A}`, "--filter", "label=cbase.instance=copy-k1"]);
    assert.equal(a2.find((x) => x[0] === "exec")[8], kid);

    // A copy without a container (gone, or never created): exit 2, no exec.
    spawnSync(fd.bin, ["rm", "-f", kid], { encoding: "utf8" });
    from = fd.calls().length;
    const r3 = await start(SCRIPT, ["till.cbase/k1", "--", "true"], { pwd: w, env });
    assert.equal(r3.code, 2, JSON.stringify(r3));
    assert.match(r3.err, /the copy k1 of Register has no container/);
    assert.ok(!execCalls(fd, from).some((x) => x[0] === "exec"), "exec without a container");
  });
});

test("counter-proof: a copy with a fixed -t (docker exec -it) is red without a TTY", async () => {
  // The copy lies outside every package.json (like /usr/bin in the image) — the same syntax detection as there.
  const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-project-copy-"));
  try {
    const copy = path.join(copyDir, "cbase-project");
    const source = fs.readFileSync(SCRIPT, "utf8");
    const search = '...(tty ? ["-t"] : [])';
    assert.equal(source.split(search).length, 2, "the sabotage spot is missing");
    fs.writeFileSync(copy, source.replace(search, '"-t"'));
    await withBuild(async ({ d, fd, env }) => {
      const from = fd.calls().length;
      const r = await start(copy, ["till-2", "--", "true"], { pwd: d.projects[1].path, env });
      assert.equal(r.code, 0, r.err); // the fake docker does not refuse -t — the check on the call must catch it
      const [a] = execCalls(fd, from);
      assert.match(checkWithoutTty(a).join("\n"), /-t without TTY/);
    });
  } finally { fs.rmSync(copyDir, { recursive: true, force: true }); }
});

test("location: in the backend image under /usr/bin with node --check, in the build context and in the deploy — not in the projectbox", () => {
  assert.equal(fs.statSync(SCRIPT).mode & 0o111, 0o111, "not executable");
  assert.match(fs.readFileSync(SCRIPT, "utf8"), /^#!\/usr\/bin\/env node\n/);
  const notNode = fs.readFileSync(SCRIPT, "utf8").match(/from "(?!node:)[^"]+"|require\(/g);
  assert.equal(notNode, null, "cbase-project needs more than node:*");
  const st = dockerfileStages(fs.readFileSync(path.join(REPO, "server/backend/Dockerfile"), "utf8"));
  const location = st.flatMap((s) => s.instructions.filter((a) => /cbase-project(\s|$)/.test(a.arg)).map((a) => [s.name, a.op, a.arg]));
  assert.deepEqual(location, [
    ["backend", "COPY", "cbase-project /usr/bin/cbase-project"],
    ["backend", "RUN", "chmod 755 /usr/bin/cbase-project && node --check /usr/bin/cbase-project"],
  ]);
  assert.ok(!/\/usr\/local\/bin\/cbase-project/.test(fs.readFileSync(path.join(REPO, "server/backend/Dockerfile"), "utf8")));
  assert.match(fs.readFileSync(path.join(REPO, "server/backend/build.sh"), "utf8"), /^cp [^\n]*\bcbase-project\b[^\n]*"\$CTX\/"$/m, "build.sh does not stage cbase-project");
  assert.ok(JSON.parse(fs.readFileSync(path.join(HERE, "../../server/backend/build-context-files.json"), "utf8")).files.includes("cbase-project"), "the build context list does not name cbase-project (the deploy uploads that list)");
});

// ── the working folder in the container ─────────────────────────────────────────────────────────────────────────────────
// The project folder stands in the store behind a link (`link → real`); the wrapper cbase-git changes with `pwd -P`, so $PWD is
// physical. `workingFolder` used to compare logically and silently set `-w` to the project folder (git in the wrong repo).
test("working folder: compared physically, converted to the store form; worktree folder from the list; with --git-access outside exit 128 without docker", async () => {
  const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-project-folder-")));
  try {
    const real = path.join(w, "real");
    const link = path.join(w, "link");
    fs.mkdirSync(path.join(real, "ws", "till", "sub"), { recursive: true });
    fs.mkdirSync(path.join(real, "data", "projects", "p1", "worktrees", "agent-x", "src"), { recursive: true });
    fs.symlinkSync(real, link);
    const store = path.join(link, "ws", "till");
    const wt = path.join(link, "data", "projects", "p1", "worktrees");
    // pure
    assert.equal(workingFolder(path.join(real, "ws", "till", "sub"), store), path.join(store, "sub"), "physically in the project => store form, not the project folder");
    assert.equal(workingFolder(path.join(store, "sub"), store), path.join(store, "sub"), "logical still works");
    assert.equal(workingFolder(path.join(real, "data", "projects", "p1", "worktrees", "agent-x", "src"), store, [wt]), path.join(wt, "agent-x", "src"), "worktree folder as root");
    assert.equal(workingFolder(path.join(real, "data", "projects", "p1", "worktrees", "agent-x"), store), store, "without the root: the project folder as before");
    // The list carries both forms: the store form is chosen, whatever the order.
    const wtReal = path.join(real, "data", "projects", "p1", "worktrees");
    for (const roots of [[wtReal, wt], [wt, wtReal]]) assert.equal(inContainer(path.join(wtReal, "agent-x"), roots), path.join(wt, "agent-x"), JSON.stringify(roots));
    assert.equal(inContainer(path.join(real, "ws", "till2"), [store]), null, "register2 is not inside register");
    assert.equal(folderFromMounts(path.join(real, "ws", "till", "sub"), [{ Type: "bind", Source: store, Destination: store }]), path.join(store, "sub"), "without a backend likewise physical");
  } finally { fs.rmSync(w, { recursive: true, force: true }); }

  await withBuild(async ({ w: root, d, fd, env }) => {
    const tillB = d.projects[1];
    const wt = path.join(root, "data", "projects", ID_B, "worktrees");
    const agent = path.join(wt, "agent-x");
    fs.mkdirSync(agent, { recursive: true });
    const list = path.join(root, "git-projects");
    fs.writeFileSync(list, `${ID_B}\t${tillB.path}\n${ID_B}\t${wt}\n${ID_A}\t${path.join(root, "foreign")}\n`);
    const e = { ...env, CBASE_GIT_PROJECTS: list };
    // from the worktree of the runtime folder => -w there (not the project folder).
    let from = fd.calls().length;
    const r = await start(SCRIPT, [ID_B, "--git-access", "--", "sh", "-c", "pwd -P"], { pwd: agent, env: e });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), agent);
    assert.deepEqual(execCalls(fd, from)[0].slice(0, 6), ["exec", "-i", "-u", "agent", "-w", agent]);
    // with --git-access outside every root => exit 128, message, NO docker call (never silently the project folder).
    from = fd.calls().length;
    const r2 = await start(SCRIPT, [ID_B, "--git-access", "--", "git", "status"], { pwd: d.workspaces[0].path, env: e });
    assert.equal(r2.code, 128, JSON.stringify(r2));
    assert.match(r2.err, /is not in the project container of Register/);
    assert.deepEqual(execCalls(fd, from), [], "docker ran");
    // The row of ANOTHER project is no root of this project.
    fs.mkdirSync(path.join(root, "foreign"));
    const r3 = await start(SCRIPT, [ID_B, "--git-access", "--", "git", "status"], { pwd: path.join(root, "foreign"), env: e });
    assert.equal(r3.code, 128, JSON.stringify(r3));
    // Without --git-access (the terminal): the project folder as before.
    from = fd.calls().length;
    const r4 = await start(SCRIPT, [ID_B, "--", "sh", "-c", "pwd -P"], { pwd: d.workspaces[0].path, env: e });
    assert.equal(r4.code, 0, r4.err);
    assert.equal(r4.out.trim(), tillB.path);
  });
});
