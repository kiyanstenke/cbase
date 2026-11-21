// Guard for the actions on an instance — projectbox/instance-actions.js through the real routes of a real server
// (agent-harness.mjs), the fake docker (fake-docker.mjs, its `exec` runs LOCALLY) and real git in throwaway repos; a `git` on the PATH
// logs every call with its place (projectbox-git-scenario.mjs gitLocation: in the wrong container the environment carries
// `IN_CONTAINER=container`).
//
// The promises, each with the way that breaks it:
//   (1) Repos, dismiss, branch switch in main: GET …/repos names branch, open files (count), local and remote branches; a branch
//       switch with open files is 409 OPEN_CHANGES with list and count (and does not switch); dismiss takes ONLY the named files —
//       a foreign path is 400 and nothing is touched, `u*.txt` is no pattern (uv.txt stays); a branch that exists only remotely
//       creates the local one with upstream (`--track`); one that already exists locally is 409; the field check (missing/unknown
//       field, option as branch) is 400. Every git runs in the container, none in B.
//   (2) The work lock per action: a running turn of a chat of the instance => 409 INSTANCE_WORKING with the chat (id and title) —
//       for branch, dismiss and stack restart, and nothing happens before (no checkout, no file gone, no compose on the wire).
//       Without the turn the same calls go through.
//   (2b) The same lock applies to the INSTANCE of the chat — a turn of a chat in copy-k1 locks every action on copy-k1 (409 with
//       exactly this chat, nothing on the wire), main goes through beside it; a turn in main does not hold copy-k1 (cross-check).
//   (3) Stack restart: per compose project of the instance ONE `docker compose -p … --project-directory … -f … up -d --build` IN the
//       project container (on the wire of the fake docker: daemon = the container, as `-u agent`), a failed stack does not drag the
//       other along (`ok: false` with reason), `compose run` containers and non-compose containers do not count. ASYNCHRONOUS: 202
//       with the running action at once, the result stands afterwards in the tree (`action`) and in the event `project/instance`
//       (field `action`, the same `since` — that is how the web dialog recognizes ITS restart). It holds the instance occupancy
//       "stack-restart": a second restart, branch, dismiss and stop are 409 OCCUPIED, and /api/runs/active counts it as project work
//       (`state: "action"`, busy) until it ends.
//   (4) Without the operating mark 404, a not converted project 409 NOT_CONVERTED, an unknown instance 404 UNKNOWN_INSTANCE, a copy
//       without snapshot returns `loaded: false` with reason — never an empty list.
//   (5) An IGNORED file (`.env`) that the target branch carries — local as well as only remote — is 409 IGNORED_FILES with list and
//       count; nothing switched, no local branch created, its content stays. Cleared away it works.
//
// Counter-test map (one sabotage each on the real tree, the whole file run): `checkAction` without the line
// `if (!work.quiet) throw …` => (2) red (409 OPEN_CHANGES instead of INSTANCE_WORKING — the action ran past the lock);
// `filesDismiss` without the `foreign.length` check => (1) red (200 instead of 400, a.txt dismissed); without `--literal-pathspecs` at
// `clean` => (1) red (uv.txt fell with `u*.txt`); the four fence lines gone => fence.test.js red; both checkouts without
// `--no-overwrite-ignore` => (5) red; `stackRestartNudge` without `withInstanceOccupancy` => (3) red (the second restart and the
// stop went through); /api/runs/active without the loop over `runningActions()` => (3) red (busy false); the route waits for the
// restart again (200 `{ stacks }`) => (3) and (2b) red; `checkAction` with `instanceWork(inst.projectId)` without the instance name
// => (2b) red; `reportAction` without the field `action` in the event => (3) red ("no event `project/instance` carries the action
// of the restart", over the stream barrier — no hang).
// NOT distinguishable (measured): `checkout <x>` instead of `checkout --track -b <x> refs/remotes/<r>/<x>` — git's DWIM creates the
// branch with upstream just the same; `--track` is the explicit form, the guard holds the result (upstream origin/feat). No time
// limit: answers are awaited, never a duration.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { running } from "../electron/server/runs/state.js";
import { instanceWork, instanceWorkingError } from "../electron/server/projectbox/idle.js";
import { ignoredFromCheckout, openFrom, stacksFrom } from "../electron/server/projectbox/instance-actions.js";
import { actionStatus } from "../electron/server/projectbox/instance-action-status.js";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { setUiLang } from "../electron/server/i18n.js";
import { GLOBAL } from "./quiet.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { realGit, gitLocation, readLog } from "./projectbox-git-scenario.mjs";

async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
// Operating mark and fake docker (as in projectbox-git.test.js). GIT_TERMINAL_PROMPT drops out of B (see there).
const ops = (fd, o) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200", GIT_TERMINAL_PROMPT: undefined, CBASE_GIT_PROJECTS: path.join(o.location, "git-projects") });
function containerStart(fd, name, env = {}) {
  execFileSync(fd.bin, ["run", "-d", "--name", name, ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
}
async function response(url, init) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init?.headers || {}) } });
  return { status: r.status, body: await r.json() };
}
const post = (url, body) => response(url, { method: "POST", body: JSON.stringify(body) });
// A reader of the global stream (/api/events) — the same form as in project-instances.test.js. The web dialog recognizes ITS
// stack restart in the event `project/instance` by the field `action` (lib/instances-tree.ts actionFrom, `since`).
async function globalReaderFor(base) {
  const events = [];
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal, headers: { Accept: "text/event-stream", Connection: "close" } });
  assert.equal(res.status, 200);
  const pump = (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))); } catch { /* partial line */ } }
        }
      }
    } catch { /* abort on close */ }
  })();
  return { events, async shutdown() { ac.abort(); await pump; } };
}
const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8", env: { ...process.env, ...fd.env } }).trim();

// A converted project with a running main container (pattern of projectbox-git.test.js).
async function convertedProject(ctx, fd, o, name, filePath) {
  const p = await ctx.projectWithoutInstance({ name, path: filePath });
  containerStart(fd, `cbase-p-${p.id}`, o.containerEnv);
  store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: `cbase-p-${p.id}` });
  return p;
}

// The code repo `app` under the project folder, with remote: `main` (a.txt) and `feat` (f.txt) are in the remote, locally only `main`.
function appWithRemote(o, P) {
  const A = path.join(P, "app");
  const remote = path.join(o.location, "remote-app.git");
  fs.mkdirSync(A, { recursive: true });
  realGit(o.location, ["init", "-q", "--bare", "-b", "main", remote], o.env);
  realGit(A, ["init", "-q", "-b", "main"], o.env);
  fs.writeFileSync(path.join(A, "a.txt"), "a\n");
  realGit(A, ["add", "-A"], o.env);
  realGit(A, ["commit", "-q", "-m", "one"], o.env);
  realGit(A, ["remote", "add", "origin", remote], o.env);
  realGit(A, ["push", "-q", "-u", "origin", "main"], o.env);
  realGit(A, ["checkout", "-q", "-b", "feat"], o.env);
  fs.writeFileSync(path.join(A, "f.txt"), "f\n");
  realGit(A, ["add", "-A"], o.env);
  realGit(A, ["commit", "-q", "-m", "feat"], o.env);
  realGit(A, ["push", "-q", "origin", "feat"], o.env);
  realGit(A, ["checkout", "-q", "main"], o.env);
  realGit(A, ["branch", "-q", "-D", "feat"], o.env);
  return A;
}

test("unit: openFrom reads -z including renames, stacksFrom groups compose projects without `run` containers, instanceWorkingError names the titles", () => {
  assert.deepEqual(openFrom(" M a.txt\0R  new.txt\0old.txt\0?? u*.txt\0"), [
    { x: " ", y: "M", path: "a.txt" }, { x: "R", y: " ", path: "new.txt" }, { x: "R", y: " ", path: "old.txt", old: true }, { x: "?", y: "?", path: "u*.txt" }]);
  assert.deepEqual(openFrom(""), []);
  // The list from the wording of the aborted checkout (LC_ALL=C, measured on git 2.x), only the tab lines.
  assert.deepEqual(ignoredFromCheckout("error: The following untracked working tree files would be overwritten by checkout:\n\t.env\n\tconf/x.ini\nPlease move or remove them before you switch branches.\nAborting\n"), [".env", "conf/x.ini"]);
  assert.deepEqual(ignoredFromCheckout("error: pathspec 'x' did not match any file(s) known to git"), []);
  const c = (project, extra = {}) => ({ Config: { Labels: project ? { "com.docker.compose.project": project, "com.docker.compose.project.working_dir": "/p", "com.docker.compose.project.config_files": "/p/compose.yml", ...extra } : {} } });
  const s = stacksFrom([c("web"), c("web"), c("web", { "com.docker.compose.oneoff": "True" }), c(null), c("db"), c("broken", { "com.docker.compose.project.working_dir": "relative" })]);
  assert.deepEqual(s.map((x) => [x.project, Boolean(x.config), Boolean(x.error)]), [["broken", false, true], ["db", true, false], ["web", true, false]]);
  assert.deepEqual(s.find((x) => x.project === "web").config.args, ["-p", "web", "--project-directory", "/p", "-f", "/p/compose.yml"]);
  const e = instanceWorkingError({ chats: [{ id: "c1", title: "My chat", reason: "running", text: "running" }], open: [] }, "main");
  assert.equal(e.status, 409);
  assert.equal(e.code, "INSTANCE_WORKING");
  assert.match(e.message, /„My chat“/);
  // Unreadable => not quiet (better wait): an invalid instance.
  const u = instanceWork("p-x", "no-instance");
  assert.equal(u.quiet, false);
  assert.equal(u.open[0].reason, "unreadable");
});

test("(1)(2)(4) repos, dismiss and branch switch in main, the work lock per action, no operating mark and unknown instances", async () => {
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-in7-");
  let turnChat = null;
  try {
    await withAgentsServer(async (ctx) => {
      const { base } = ctx;
      const P = path.join(ctx.root, "workspace", "till-in7");
      fs.mkdirSync(P, { recursive: true });
      const A = appWithRemote(o, P);
      // (4) Without operating mark 404, before anything is read.
      const without = await ctx.projectWithoutInstance({ name: "Without", path: path.join(ctx.root, "workspace", "without-in7") });
      await withEnvironment({ CBASE_CONTAINER: undefined, CBASE_DIND: undefined }, async () => {
        const r = await response(`${base}/api/projects/${without.id}/instances/main/repos`);
        assert.equal(r.status, 404, JSON.stringify(r.body));
      });
      await withEnvironment({ ...o.env, ...ops(fd, o) }, async () => {
        // (4) Not converted => 409; unknown instance => 404.
        const nu = await response(`${base}/api/projects/${without.id}/instances/main/repos`);
        assert.deepEqual([nu.status, nu.body.code], [409, "NOT_CONVERTED"], JSON.stringify(nu.body));
        const p = await convertedProject(ctx, fd, o, "Checkout instance actions", P);
        const url = (rest) => `${base}/api/projects/${p.id}/instances/${rest}`;
        for (const i of ["copy-nonexistent", "nonsense", "MAIN"]) {
          const r = await response(url(`${i}/repos`));
          assert.deepEqual([r.status, r.body.code], [404, "UNKNOWN_INSTANCE"], `${i}: ${JSON.stringify(r.body)}`);
        }

        // (1) Repos: branch, no open files, local main, remote origin/feat + origin/main.
        fs.writeFileSync(o.log, "");
        const r0 = await json(url("main/repos"));
        assert.equal(r0.loaded, true, JSON.stringify(r0));
        assert.deepEqual(r0.repos, [{ rel: "app", name: "app", branch: "main", detached: false, open: [], openCount: 0, branches: ["main"], remotes: ["origin/feat", "origin/main"] }]);

        // Open files: changed, two untracked — one with a pattern character in the name.
        fs.writeFileSync(path.join(A, "a.txt"), "changed\n");
        fs.writeFileSync(path.join(A, "u*.txt"), "u\n");
        fs.writeFileSync(path.join(A, "uv.txt"), "v\n");
        const r1 = await json(url("main/repos"));
        assert.equal(r1.repos[0].openCount, 3);
        assert.deepEqual([...r1.repos[0].open].sort(), ["a.txt", "u*.txt", "uv.txt"]);

        // Branch switch with open files => 409 with list and count, no switch.
        const b1 = await post(url("main/branch"), { repo: "app", branch: "origin/feat" });
        assert.deepEqual([b1.status, b1.body.code, b1.body.count], [409, "OPEN_CHANGES", 3], JSON.stringify(b1.body));
        assert.deepEqual([...b1.body.files].sort(), ["a.txt", "u*.txt", "uv.txt"]);
        assert.equal(realGit(A, ["symbolic-ref", "--short", "HEAD"], o.env).trim(), "main");

        // Dismiss: a foreign path => 400, and NOTHING is touched (not even the known one beside it).
        const v1 = await post(url("main/dismiss"), { repo: "app", files: ["a.txt", "foreign.txt"] });
        assert.deepEqual([v1.status, v1.body.code, v1.body.files], [400, "UNKNOWN_FILES", ["foreign.txt"]], JSON.stringify(v1.body));
        assert.equal(fs.readFileSync(path.join(A, "a.txt"), "utf8"), "changed\n", "a.txt was dismissed despite the 400");

        // (2) The work lock: a running turn of a chat of the instance => 409 with the chat, for every action — nothing happens.
        await json(`${base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
        const title = store.getChat(ctx.chat.id).title;
        turnChat = ctx.chat.id;
        running.add(turnChat);
        // `finally` INSIDE the server: the harness waits for quiet after a failure — a chat that stayed in `running` would turn
        // the red test into an eternal hang.
        try {
          const prior = fd.calls().length;
          for (const [action, body] of [["branch", { repo: "app", branch: "main" }], ["dismiss", { repo: "app", files: ["a.txt"] }], ["stack-restart", {}]]) {
            const r = await post(url(`main/${action}`), body);
            assert.deepEqual([r.status, r.body.code], [409, "INSTANCE_WORKING"], `${action}: ${JSON.stringify(r.body)}`);
            assert.deepEqual(r.body.chats.map((c) => [c.id, c.title, c.reason]), [[turnChat, title, "running"]], action);
            assert.ok(r.body.error.includes(title), action);
          }
          assert.equal(fs.readFileSync(path.join(A, "a.txt"), "utf8"), "changed\n", "dismissed under the turn");
          assert.deepEqual(fd.calls().slice(prior), [], "no docker call ran under the lock");
          // The lock applies to the INSTANCE: GET …/repos keeps reading.
          assert.equal((await json(url("main/repos"))).repos[0].openCount, 3);
        } finally {
          running.delete(turnChat);
          turnChat = null;
        }

        // Dismiss takes ONLY the named: a.txt from HEAD, `u*.txt` gone — uv.txt stays (no pattern).
        const v2 = await post(url("main/dismiss"), { repo: "app", files: ["a.txt", "u*.txt"] });
        assert.equal(v2.status, 200, JSON.stringify(v2.body));
        assert.equal(fs.readFileSync(path.join(A, "a.txt"), "utf8"), "a\n");
        assert.equal(fs.existsSync(path.join(A, "u*.txt")), false);
        assert.equal(fs.readFileSync(path.join(A, "uv.txt"), "utf8"), "v\n", "uv.txt fell with `u*.txt` (pattern instead of path)");
        assert.deepEqual([v2.body.repo.openCount, v2.body.repo.open], [1, ["uv.txt"]]);
        // A file new only in the index disappears from index AND working tree.
        fs.writeFileSync(path.join(A, "fresh.txt"), "n\n");
        realGit(A, ["add", "fresh.txt"], o.env);
        const v3 = await post(url("main/dismiss"), { repo: "app", files: ["fresh.txt", "uv.txt"] });
        assert.equal(v3.status, 200, JSON.stringify(v3.body));
        assert.deepEqual([fs.existsSync(path.join(A, "fresh.txt")), fs.existsSync(path.join(A, "uv.txt")), v3.body.repo.openCount], [false, false, 0]);

        // Branch switch: present only remotely => local with upstream; then back to main.
        const b2 = await post(url("main/branch"), { repo: "app", branch: "origin/feat" });
        assert.equal(b2.status, 200, JSON.stringify(b2.body));
        assert.deepEqual([b2.body.repo.branch, b2.body.repo.branches], ["feat", ["feat", "main"]]);
        assert.equal(realGit(A, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], o.env).trim(), "origin/feat");
        assert.ok(fs.existsSync(path.join(A, "f.txt")));
        const b3 = await post(url("main/branch"), { repo: "app", branch: "main" });
        assert.deepEqual([b3.status, b3.body.repo?.branch], [200, "main"], JSON.stringify(b3.body));
        // The local one already exists => 409; unknown => 400; unknown repo => 400.
        const b4 = await post(url("main/branch"), { repo: "app", branch: "origin/main" });
        assert.deepEqual([b4.status, b4.body.code, b4.body.local], [409, "BRANCH_LOCAL_EXISTS", "main"], JSON.stringify(b4.body));
        const b5 = await post(url("main/branch"), { repo: "app", branch: "nonexistent" });
        assert.deepEqual([b5.status, b5.body.code], [400, "UNKNOWN_BRANCH"], JSON.stringify(b5.body));
        const b6 = await post(url("main/branch"), { repo: "foreign", branch: "main" });
        assert.deepEqual([b6.status, b6.body.code], [400, "UNKNOWN_REPO"], JSON.stringify(b6.body));

        // Field check (400 before any question to the container): missing, unknown, option as branch, empty list.
        const beforeField = fd.calls().length;
        for (const [action, body] of [["branch", { repo: "app" }], ["branch", { branch: "main" }], ["branch", { repo: "app", branch: "main", create: true }],
          ["branch", { repo: "app", branch: "-f" }], ["dismiss", { repo: "app" }], ["dismiss", { repo: "app", files: [] }],
          ["dismiss", { repo: "app", files: "a.txt" }], ["stack-restart", { all: true }]]) {
          const r = await post(url(`main/${action}`), body);
          assert.equal(r.status, 400, `${action} ${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
        }
        assert.deepEqual(fd.calls().slice(beforeField), [], "a 400 already asked the container");

        // Every git of these routes ran in the container, none in B.
        const calls = readLog(o.log).filter((e) => !e.step);
        assert.ok(calls.length > 10, `too few git calls logged: ${calls.length}`);
        const inB = calls.filter((a) => a.where !== "container" && a.cwd.startsWith(fs.realpathSync(A)));
        assert.deepEqual(inB.map((a) => a.argv.join(" ")), [], "git of the instance ran in B");

        // (4) A copy with an instance row but without snapshot: `loaded: false` with reason — never an empty list.
        store.createProjectInstance({ projectId: p.id, instance: "copy-k1", state: "ready", containerId: "" });
        const k = await json(url("copy-k1/repos"));
        assert.equal(k.loaded, false, JSON.stringify(k));
        assert.ok(k.error && !("repos" in k), JSON.stringify(k));
        store.deleteProjectInstance(p.id, "copy-k1");
      });
    });
  } finally {
    if (turnChat) running.delete(turnChat);
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

test("(3) stack restart: 202 with running action, one `compose … up -d --build` per compose project IN the project container, a failed one does not drag the other along; under the occupancy 409 OCCUPIED, the action is project work", async () => {
  const fd = await fakeDocker({ compose: { web: { app: { image: "web-img", build: { context: "." } } }, db: { pg: { image: "pg-img" } } }, upBroken: ["db"], inspectGate: "inspect" });
  fd.openGate("inspect"); // open until part B — a background reader would otherwise stand at the gate
  const o = gitLocation("cbase-git-in7s-");
  try {
    await withAgentsServer(async (ctx) => {
      setUiLang("en"); // after the server start: the occupancy sentence is the English source text
      await withEnvironment({ ...o.env, ...ops(fd, o) }, async () => {
        try {
          const P = path.join(ctx.root, "workspace", "stack-in7");
          fs.mkdirSync(P, { recursive: true });
          const file = path.join(P, "compose.yml");
          fs.writeFileSync(file, "services: {}\n");
          const p = await convertedProject(ctx, fd, o, "Stack instance actions", P);
          const c = `cbase-p-${p.id}`;
          const url = (action) => `${ctx.base}/api/projects/${p.id}/instances/main/${action}`;
          const mainInTree = async () => (await json(`${ctx.base}/api/projects/${p.id}/instances`)).instances.find((i) => i.name === "main");
          const compose = (project) => ["--label", `com.docker.compose.project=${project}`, "--label", `com.docker.compose.project.working_dir=${P}`, "--label", `com.docker.compose.project.config_files=${file}`];
          // In the inner daemon: two containers of "web", one of "db", a `compose run` of "web" and a container without compose.
          dx(fd, "exec", c, "docker", "run", "-d", "--name", "web-app-1", ...compose("web"), "--label", "com.docker.compose.service=app", "web-img");
          dx(fd, "exec", c, "docker", "run", "-d", "--name", "web-app-2", ...compose("web"), "--label", "com.docker.compose.service=app", "web-img");
          dx(fd, "exec", c, "docker", "run", "-d", "--name", "web-app-run-1", ...compose("web"), "--label", "com.docker.compose.oneoff=True", "web-img");
          dx(fd, "exec", c, "docker", "run", "-d", "--name", "db-pg-1", ...compose("db"), "--label", "com.docker.compose.service=pg", "pg-img");
          dx(fd, "exec", c, "docker", "run", "-d", "--name", "loose", "anything");

          // Part A: the answer comes AT ONCE with the running action (202) — the POST must not wait out the whole `up -d --build`
          // (up to 30 min behind a tunnel with a 100 s limit). The result stands afterwards in the tree (`action`).
          const prior = fd.calls({ daemon: "host" }).length;
          const reader = await globalReaderFor(ctx.base);
          let r;
          let end;
          try {
            await waitForTruthy(() => (reader.events.some((e) => e.type === "init") ? true : null), "init of the global stream");
            r = await post(url("stack-restart"), {});
            assert.equal(r.status, 202, JSON.stringify(r.body));
            assert.deepEqual([r.body.instance, r.body.action?.kind, r.body.action?.running], ["main", "stack-restart", true], JSON.stringify(r.body));
            end = await waitForTruthy(async () => { const a = (await mainInTree())?.action; return a && !a.running ? a : null; }, "the stack restart is through");
            // The event carries the same action (same `since`): start, one interim state per stack, the end with the stacks. The end was
            // sent BEFORE the tree showed it; the stream barrier afterwards means: everything before is at the reader (if the field is
            // missing, the case is red, no hang).
            const until = await ctx.barrier(reader, GLOBAL);
            const ev = reader.events.slice(0, until).filter((e) => e.type === "project/instance" && e.projectId === p.id && e.instance === "main" && e.action?.since === r.body.action.since);
            assert.ok(ev.length > 0, "no event `project/instance` carries the action of the restart");
            assert.equal(ev[0].action.running, true, "no event for the start");
            assert.ok(ev.length >= 3, `too few events (start, interim state per stack, end): ${ev.length}`);
            assert.deepEqual(ev.at(-1).action.stacks.map((s) => [s.project, s.ok]), [["db", false], ["web", true]], "the end in the event does not carry the stacks");
          } finally {
            await reader.shutdown();
          }
          assert.deepEqual(end.stacks.map((s) => [s.project, s.ok]), [["db", false], ["web", true]], JSON.stringify(end));
          assert.match(end.stacks[0].error, /failed to solve/);
          assert.equal(end.stacks[1].error, null);
          assert.equal(end.ok, false);
          assert.match(end.error, /^db: .*failed to solve/);
          // On the wire: exactly two `compose up` in the daemon OF the project container, each with the arguments from the labels.
          const ups = fd.calls({ daemon: c }).filter((a) => a.args[0] === "compose");
          assert.deepEqual(ups.map((a) => a.args), ["db", "web"].map((pr) => ["compose", "-p", pr, "--project-directory", P, "-f", file, "up", "-d", "--build"]));
          // … and on the host as `exec -u agent <container> docker …`.
          const execs = fd.calls({ daemon: "host" }).slice(prior).filter((a) => a.args[0] === "exec" && a.args.includes("compose"));
          assert.equal(execs.length, 2);
          for (const a of execs) assert.deepEqual(a.args.slice(0, 5), ["exec", "-u", "agent", c, "docker"]);
          // The `up` of the successful stack has its service running.
          const inside = fd.state(c);
          assert.equal(Object.values(inside.container).find((x) => x.name === "web-app-1")?.status, "running");

          // Part B: while the restart runs (held at the gate of the fake docker, BEFORE the first `up`), it holds the instance occupancy
          // "stack-restart" — a second restart, branch, dismiss and stop are 409 OCCUPIED with the sentence, and /api/runs/active
          // counts it as project work (busy). Otherwise each of these actions would run beside it and the deploy would see nothing.
          fd.closeGate("inspect");
          const two = await post(url("stack-restart"), {});
          assert.equal(two.status, 202, JSON.stringify(two.body));
          // No waiting for the gate needed: occupancy and state stand SYNCHRONOUSLY with the answer, and the restart does not end
          // before the closed gate (the `docker inspect` of the inner containers).
          for (const [action, body] of [["stack-restart", {}], ["branch", { repo: "app", branch: "main" }], ["dismiss", { repo: "app", files: ["a.txt"] }], ["stop", {}]]) {
            const b = await post(url(action), body);
            assert.deepEqual([b.status, b.body.code], [409, "OCCUPIED"], `${action}: ${JSON.stringify(b.body)}`);
            assert.match(b.body.error, /a restart of the stack is running on instance main/, action);
          }
          assert.equal(store.projectInstance(p.id, "main").state, "ready", "stopped under the occupancy");
          const active = await json(`${ctx.base}/api/runs/active`);
          assert.equal(active.busy, true, JSON.stringify(active));
          assert.deepEqual(active.projectWork.filter((a) => a.projectId === p.id).map((a) => [a.instance, a.state, a.phase]), [["main", "action", "stack-restart"]], JSON.stringify(active.projectWork));
          assert.equal((await mainInTree()).action.running, true);
          fd.openGate("inspect");
          await waitForTruthy(async () => { const a = (await mainInTree())?.action; return a && !a.running ? a : null; }, "the second stack restart is through");
          const afterwards = await json(`${ctx.base}/api/runs/active`);
          assert.deepEqual(afterwards.projectWork.filter((a) => a.projectId === p.id), [], "the action stayed project work");
        } finally {
          fd.openGate("inspect"); // a red case leaves no restart standing at the gate
        }
      });
    });
  } finally {
    setUiLang("de");
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

// ── (2b) The work lock applies to the INSTANCE of the chat — also in a copy ───────────────────────────────────────────────────────
// (2) checked it only for main; a check `instanceWork(inst.projectId)` without the instance name would have stayed green there (it
// then asks main) and would let every action through beside a running turn in a copy.
test("(2b) a turn of a chat in copy-k1 => 409 INSTANCE_WORKING on copy-k1, main goes through; a turn in main does not hold copy-k1", async () => {
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-in7k-");
  const isRunning = [];
  try {
    await withAgentsServer(async (ctx) => {
      const { base } = ctx;
      const P = path.join(ctx.root, "workspace", "till-in7k");
      fs.mkdirSync(P, { recursive: true });
      appWithRemote(o, P);
      try {
        await withEnvironment({ ...o.env, ...ops(fd, o) }, async () => {
          const p = await convertedProject(ctx, fd, o, "Checkout copy", P);
          const url = (rest) => `${base}/api/projects/${p.id}/instances/${rest}`;
          // The copy k1: alive, instance row ready (without container — the lock judges before any question to it).
          store.createStackCopy({ projectId: p.id, name: "k1", chatId: ctx.chat.id, state: "ready" });
          store.createProjectInstance({ projectId: p.id, instance: "copy-k1", state: "ready", containerId: "" });
          await json(`${base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
          const hChat = ctx.chat.id;
          const t = Date.now();
          const kChat = store.createChat({ id: randomUUID(), workspaceId: ctx.ws.id, projectId: p.id, createdAt: t, updatedAt: t }).id;
          await json(`${base}/api/chats/${kChat}`, { method: "PATCH", body: JSON.stringify({ instance: "copy-k1" }) });
          const kTitle = store.getChat(kChat).title;

          // A turn in copy-k1: every action on copy-k1 is 409 with THIS chat, and nothing on the wire.
          running.add(kChat); isRunning.push(kChat);
          const beforeK = fd.calls().length;
          for (const [action, body] of [["branch", { repo: "app", branch: "main" }], ["dismiss", { repo: "app", files: ["a.txt"] }], ["stack-restart", {}]]) {
            const r = await post(url(`copy-k1/${action}`), body);
            assert.deepEqual([r.status, r.body.code], [409, "INSTANCE_WORKING"], `copy-k1 ${action}: ${JSON.stringify(r.body)}`);
            assert.deepEqual(r.body.chats.map((c) => [c.id, c.title]), [[kChat, kTitle]], action);
          }
          assert.deepEqual(fd.calls().slice(beforeK), [], "a docker call ran under the lock of the copy");
          // It does not hold main: the switch to its own branch goes through.
          const h = await post(url("main/branch"), { repo: "app", branch: "main" });
          assert.deepEqual([h.status, h.body.repo?.branch], [200, "main"], `main beside the turn of the copy: ${JSON.stringify(h.body)}`);
          running.delete(kChat);

          // Conversely: a turn in main does not hold copy-k1 (the restart begins — 202 —, its result does not count here: the copy
          // has no container), main itself is 409.
          running.add(hChat); isRunning.push(hChat);
          const k = await post(url("copy-k1/stack-restart"), {});
          assert.equal(k.status, 202, `copy-k1 beside the turn in main: ${JSON.stringify(k.body)}`);
          await waitForTruthy(() => (actionStatus(p.id, "copy-k1")?.running === false ? true : null), "the restart of the copy is through");
          const hh = await post(url("main/branch"), { repo: "app", branch: "main" });
          assert.deepEqual([hh.status, hh.body.code], [409, "INSTANCE_WORKING"], JSON.stringify(hh.body));
          assert.deepEqual(hh.body.chats.map((c) => c.id), [hChat]);
          running.delete(hChat);
          store.deleteProjectInstance(p.id, "copy-k1");
        });
      } finally {
        for (const c of isRunning) running.delete(c);
      }
    });
  } finally {
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

// ── (5) An ignored file that the target branch carries ───────────────────────────────────────────────────────────────────────────
// `.env` is ignored on main, the branch `cfg` carries it. A `git checkout cfg` would silently overwrite it (and switching back would
// delete it) — the open check does not see ignored files. Now: `--no-overwrite-ignore` on both checkouts => 409 IGNORED_FILES with
// list and count, nothing switched, the content stays. Cleared away the switch works.
test("(5) an ignored file that the target branch carries => 409 IGNORED_FILES, nothing switched, the content stays — local and remote", async () => {
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-in7i-");
  try {
    await withAgentsServer(async (ctx) => {
      const P = path.join(ctx.root, "workspace", "till-in7i");
      fs.mkdirSync(P, { recursive: true });
      const A = appWithRemote(o, P);
      // main ignores .env; `cfg` (local) and `origin/cfg2` (only remote) carry it.
      fs.writeFileSync(path.join(A, ".gitignore"), ".env\n");
      realGit(A, ["add", ".gitignore"], o.env);
      realGit(A, ["commit", "-q", "-m", "ignore .env"], o.env);
      realGit(A, ["push", "-q", "origin", "main"], o.env);
      for (const b of ["cfg", "cfg2"]) {
        realGit(A, ["checkout", "-q", "-b", b], o.env);
        fs.writeFileSync(path.join(A, ".env"), `OUT=${b}\n`);
        realGit(A, ["add", "-f", ".env"], o.env);
        realGit(A, ["commit", "-q", "-m", `${b} carries .env`], o.env);
        realGit(A, ["checkout", "-q", "main"], o.env);
      }
      realGit(A, ["push", "-q", "origin", "cfg2"], o.env);
      realGit(A, ["branch", "-q", "-D", "cfg2"], o.env);
      fs.writeFileSync(path.join(A, ".env"), "SECRET=1\n"); // the ignored file of its own
      await withEnvironment({ ...o.env, ...ops(fd, o) }, async () => {
        const p = await convertedProject(ctx, fd, o, "Checkout ignored", P);
        const url = (rest) => `${ctx.base}/api/projects/${p.id}/instances/${rest}`;
        assert.equal((await json(url("main/repos"))).repos[0].openCount, 0, "the ignored file counts as open");
        for (const branch of ["cfg", "origin/cfg2"]) {
          const r = await post(url("main/branch"), { repo: "app", branch });
          assert.deepEqual([r.status, r.body.code, r.body.files, r.body.count], [409, "IGNORED_FILES", [".env"], 1], `${branch}: ${JSON.stringify(r.body)}`);
          assert.match(r.body.error, /ignorierte Datei\(en\), die der Branch .* mitbringt \(\.env\)/);
          assert.equal(fs.readFileSync(path.join(A, ".env"), "utf8"), "SECRET=1\n", `${branch}: the ignored file was overwritten`);
          assert.equal(realGit(A, ["symbolic-ref", "--short", "HEAD"], o.env).trim(), "main", `${branch}: switched`);
        }
        assert.equal(realGit(A, ["branch", "--list", "cfg2"], o.env).trim(), "", "the local branch cfg2 came into being despite the abort");
        // Cleared away: the switch works, `.env` is the branch's.
        fs.rmSync(path.join(A, ".env"));
        const ok = await post(url("main/branch"), { repo: "app", branch: "cfg" });
        assert.deepEqual([ok.status, ok.body.repo?.branch], [200, "cfg"], JSON.stringify(ok.body));
        assert.equal(fs.readFileSync(path.join(A, ".env"), "utf8"), "OUT=cfg\n");
      });
    });
  } finally {
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});
