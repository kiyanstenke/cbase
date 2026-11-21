// Guard for cloning a git repository during project setup: projectbox/setup/clone.js, the clone branches in ./procedure.js,
// ./sources.js, ./routes.js, plus the graph worktree with LFS (workflows/worktree.js → runs/git-post-work.js lfsInWorktree).
//
// THE TOOLING. The frame from ./setup-harness.mjs (withCreation: server in operation, fake docker — `exec` runs LOCALLY —,
// fake `df`, git and python gates). On top of it here:
//   - a git WRAPPER at the front of PATH (the harness's git gate sits behind it as `git-gates`): per TOP-LEVEL call it writes a
//     JSON row (argv, config from the environment, users of the accesses, WHETHER a password is present, GIT_LFS_SKIP_SMUDGE,
//     GIT_TERMINAL_PROMPT); a marker `antwort-<arg>` makes the first call with that argument end with its text on stderr and
//     exit 128 WITHOUT calling git (a server that refuses); and it prepends `-c url.file://<bare>.insteadOf=<https>` — so the
//     https addresses of the tests point at two local bare repos (via GIT_CONFIG_PARAMETERS also for the submodule clone git
//     itself starts) — with `-c protocol.file.allow=always`, ONLY while a redirect is set (the seam below applies only to the
//     clone of the main repo).
//   - the seam `setCloneLogs(["file"])` (clone.js): without it the hardening (`protocol.allow=never`) forbids the file log —
//     only for the `git clone` of the main repo; submodules and LFS run with the full hardening.
//   - the seam `setSubmoduleCap({ depth, count })` (clone.js): smaller caps for the submodules.
//   - a fake `git-lfs` (./fake-lfs.mjs): ls-files lists pointer files, pull replaces them — with a log.
// The repos: a main repo with `.gitattributes` (`*.bin filter=lfs`), a pointer file, a branch `branch-b` and a submodule `lib`
// whose `.gitmodules` carries an SSH address (`git@sub.example.invalid:o/sub.git`); the submodule with its own pointer file.
// The main host carries a port (`https://Git.Example.invalid:8443/…`, capitalized).
//
// The promises, each with the way that breaks it:
//   (P)  The check in the POST: http, scp-like and ssh (with the SSH set), file, ext::, a user part (its value is in no
//        answer), `?private_token=`, `#@`, a branch starting with `-` resp. with a space resp. over 200 characters, characters
//        outside RFC 3986, an encoded dot in the host, an address without path, a clone without `clone`, targets (empty, `.git`,
//        duplicate, another target INSIDE the clone) and a clone as repo in repo — each 400 with `code`, and NOTHING is created
//        (no folder, project, row, docker). The default target is the last address part without `.git`; the address arrives
//        normalized (host lowercase, port 443 gone). The seam: `file:` works only with it, and only `clone.js` names it
//        (server.js never calls it) — likewise `setSubmoduleCap`.
//   (K1) The whole path: cloned IN the container (docker exec, GIT_HARDENING, protocol.https, pack.threads=1,
//        GIT_LFS_SKIP_SMUDGE=1, no deadline), with the host's access under `host:port` (stored under the host name), with
//        `--branch`; the local `submodule.lib.url` is https, `.gitmodules` unchanged, the submodule comes with the access of ITS
//        host (without `--recursive`); the LFS files of both repos each come with their access; the clone is put in place with
//        ONE rename (same inode); the view carries `url`, `branch`, `host`, from `clone_fetched` on `fetched: true` and holds
//        `busy`; no value (token, user) in a docker argv, in the argv of a git, in an event, in the view or in the log. Also the
//        graph worktree of the cloned repo: its LFS files come with the host's access (lfsInWorktree), in the container; in the
//        code tab "Pull" fetches a new LFS file with the access of the remote host, and "update submodules" carries the access
//        of the sub host.
//   (K2) Clone errors: without access NO_ACCESS with `host` (without port); with a rejected access ACCESS_REJECTED; "Repository
//        not found" with access ACCESS_REJECTED, without CLONE with the last row; "take over as is" without a fetched clone 409;
//        "again" clones anew (state `clone`) — complete in the end.
//   (K3) SUBMODULE_ACCESS with the submodule's host, `error` EXACTLY the submodule name sentence (the clients build the
//        sentence) — the clone stays; "again" resumes at `submodule` (ONE clone); if LFS fails afterwards, "again" resumes at
//        `lfs` (no second submodule update).
//   (K4) TARGET_OCCUPIED BEFORE the clone (the target appears while the SETUP checks): nothing cloned, nothing deleted; "again"
//        after clearing ⇒ done. TARGET_OCCUPIED when PLACING (the target appears during LFS): nothing moved, the staging stays;
//        "again" with the target still occupied fails again; "continue without this source" ⇒ done, the staging falls, the
//        foreign stuff stays.
//   (K5) Abort in the middle of `submodule init`: the source `aborted`, the clone stays, "again" without a second clone.
//   (K6) Storage gate closed: the setup waits visibly (`waiting: "storage"`, `busy` false, no clone); open wakes the storage
//        queue, and it ends.
//   (K7) A remote with access in the address ⇒ `remoteHints: [{ repo, remote }]` in store and view, a hint in the bell — names
//        only, the value nowhere; cbase rewrites nothing.
//   (K8a) LFS fails, "take over as is", placing finds the target occupied, "again" after clearing ⇒ the clone stands at the
//        target (without the LFS files, as taken over) — "again" must not reset it to `lfs` so that placing skips it silently.
//   (K8b) a source that is not ready when placing (the earlier state, replayed) aborts stepPlace by name (PLACE, `source: 1`),
//        nothing moved; "again" ⇒ placed.
//   (K9) a restart between `clone` and `submodule` (the source stands on `submodule` with a foreign boot id, the view says
//        INTERRUPTED and `fetched`) — the resumption takes it over and resumes at `submodule`, without a second clone.
//   (K10a) a `.gitmodules` with `file://`, `ext::` or `-…` is blocked — WITHOUT the seam for submodules and without redirect
//        (SUBMODULE, nothing fetched, no command ran).
//   (K10b) a submodule path `../x` or `/x` ⇒ SUBMODULE "not a valid location" (git itself would never see it: the path gets
//        into the configuration here through a gate).
//   (K10c) depth and count via the seam `setSubmoduleCap` ⇒ SUBMODULE with "cap"; without cap ⇒ done.
//   (K11) "No space left on device" in the submodule update and in the LFS fetch ⇒ SLOT (instead of SUBMODULE resp. LFS).
//   (K12) a clone waiting for storage is aborted ⇒ `waiting` falls at once; "continue without this source" ⇒ done, the gate
//        stays closed. Likewise a row from the old state (aborted, `waiting: "storage"`): the resumption clears it.
//
// COUNTER-TESTS: see the section at the end of the file.
//
// No clock: waits are on gates (git, python), states of the row and the end of the procedure (waitUntil).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { resumeSetup, setSetupHint, setSetupSaveGate } from "../electron/server/projectbox/setup/procedure.js";
import { checkCloneDetail, setCloneLogs, setSubmoduleCap } from "../electron/server/projectbox/setup/clone.js";
import { GIT_HARDENING } from "../electron/server/projectbox/projectRepo.js";
import { locationFor } from "../electron/server/runs/runtime-location.js";
import { createGraphWorktree } from "../electron/server/workflows/worktree.js";
import { wakeStorageQueue } from "../electron/server/workflows/storage-queue.js";
import {
  REAL_GIT, active, request, create, staging, setupRoute, finished, gitHold, gitWaiting, gitContinue, read, withCreation,
  pyHold, pyWaiting, pyContinue, viewIn, waitUntil,
} from "./setup-harness.mjs";
import { waitForTruthy } from "./agent-harness.mjs";
import { fakeLfs, lfsCalls, lfsFails, pointer } from "./fake-lfs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "electron");

const URL_INPUT = "https://Git.Example.invalid:8443/o/r.git";
const URL_H = "https://git.example.invalid:8443/o/r.git";
const URL_S = "https://sub.example.invalid/o/sub.git";
const SSH_S = "git@sub.example.invalid:o/sub.git";
const SECRET_H = "SECRET-AN13-main-5e1d";
const SECRET_S = "SECRET-AN13-sub-a90c";
const SECRET_R = "SECRET-AN13-remote-77b0";
const OID_H = "a".repeat(64);
const OID_S = "b".repeat(64);
const GITMODULES = `[submodule "lib"]\n\tpath = lib\n\turl = ${SSH_S}\n`;
const LFS_ATTR = "*.bin filter=lfs diff=lfs merge=lfs -text\n";

// ── Tooling ────────────────────────────────────────────────────────────────────────────────────────────────────────

// The real git without the machine's configuration (building the repos, view from outside).
const EG_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const EG_FRONT = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always"];
const eg = (cwd, ...args) => execFileSync(REAL_GIT, ["-C", cwd, ...EG_FRONT, ...args], { encoding: "utf8", env: EG_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();

function buildRepos(dir) {
  const sub = path.join(dir, "sub-work");
  fs.mkdirSync(sub, { recursive: true });
  eg(sub, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(sub, ".gitattributes"), LFS_ATTR);
  fs.writeFileSync(path.join(sub, "data.bin"), pointer(OID_S));
  fs.writeFileSync(path.join(sub, "sub.txt"), "Sub\n");
  eg(sub, "add", "-A");
  eg(sub, "commit", "-q", "-m", "sub");
  const subSha = eg(sub, "rev-parse", "HEAD");
  const subBare = path.join(dir, "sub.git");
  execFileSync(REAL_GIT, ["clone", "-q", "--bare", sub, subBare], { env: EG_ENV });
  const main = path.join(dir, "main-work");
  fs.mkdirSync(main, { recursive: true });
  eg(main, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(main, ".gitattributes"), LFS_ATTR);
  fs.writeFileSync(path.join(main, "large.bin"), pointer(OID_H));
  fs.writeFileSync(path.join(main, "README.md"), "Main\n");
  fs.writeFileSync(path.join(main, ".gitmodules"), GITMODULES);
  eg(main, "add", "-A");
  eg(main, "update-index", "--add", "--cacheinfo", `160000,${subSha},lib`);
  eg(main, "commit", "-q", "-m", "main");
  eg(main, "checkout", "-q", "-b", "branch-b");
  fs.writeFileSync(path.join(main, "b.txt"), "branch only\n");
  eg(main, "add", "b.txt");
  eg(main, "commit", "-q", "-m", "branch");
  eg(main, "checkout", "-q", "main");
  const mainBare = path.join(dir, "main.git");
  execFileSync(REAL_GIT, ["clone", "-q", "--bare", main, mainBare], { env: EG_ENV });
  return { main: mainBare, sub: subBare, mainWork: main };
}

// A bare repo with this `.gitmodules` and a gitlink `lib` on `subSha` ((K10a): a malicious address of a submodule).
function repoWithGitmodules(dir, name, gitmodules, subSha) {
  const work = path.join(dir, `${name}-work`);
  fs.mkdirSync(work, { recursive: true });
  eg(work, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(work, "README.md"), `${name}\n`);
  fs.writeFileSync(path.join(work, ".gitmodules"), gitmodules);
  eg(work, "add", "-A");
  eg(work, "update-index", "--add", "--cacheinfo", `160000,${subSha},lib`);
  eg(work, "commit", "-q", "-m", name);
  const bare = path.join(dir, `${name}.git`);
  execFileSync(REAL_GIT, ["clone", "-q", "--bare", work, bare], { env: EG_ENV });
  return bare;
}

// The git wrapper (header "THE TOOLING"). The harness gate is called `git-gates` afterwards.
function cloneGit(bin, gates, root) {
  const log = path.join(root, "git-calls.jsonl");
  const redirect = path.join(root, "git-redirect.json");
  fs.writeFileSync(log, "");
  fs.renameSync(path.join(bin, "git"), path.join(bin, "git-gates"));
  fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const n = Number(process.env.GIT_CONFIG_COUNT || 0);
const config = [];
for (let i = 0; i < n; i++) config.push([process.env["GIT_CONFIG_KEY_" + i], process.env["GIT_CONFIG_VALUE_" + i]]);
const user = Object.keys(process.env).filter((k) => /^CBASE_GIT_USERNAME_\\d+$/.test(k)).sort().map((k) => process.env[k]);
const password = Object.keys(process.env).some((k) => /^CBASE_GIT_PASSWORD_\\d+$/.test(k) && process.env[k]);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), config, user, password, skip: process.env.GIT_LFS_SKIP_SMUDGE ?? null, prompt: process.env.GIT_TERMINAL_PROMPT ?? null }) + "\\n");
for (const a of args) {
  const marker = path.join(${JSON.stringify(gates)}, "antwort-" + a);
  const taken = marker + ".genommen." + process.pid;
  try { fs.renameSync(marker, taken); } catch { continue; }
  process.stderr.write(fs.readFileSync(taken, "utf8"));
  process.exit(128);
}
// The redirect only for commands that touch the network: \`remote get-url\` applies insteadOf and would otherwise report the file address (the
// access lookup of the code tab reads the host there).
let under = null;
for (let i = 0; i < args.length; i++) { if (args[i] === "-c" || args[i] === "-C") { i++; continue; } if (!args[i].startsWith("-")) { under = args[i]; break; } }
let front = [];
if (["clone", "fetch", "pull", "push", "submodule", "ls-remote"].includes(under)) {
  try { front = JSON.parse(fs.readFileSync(${JSON.stringify(redirect)}, "utf8")).flatMap(([nach, from]) => ["-c", "url." + nach + ".insteadOf=" + from]); } catch { front = []; }
  // The redirect leads to file:// — allowed only while it stands (the "server" of the https address is reachable). The test seam
  // setCloneLogs applies only to the clone of the main repo; (K10) runs without a redirect.
  if (front.length) front.push("-c", "protocol.file.allow=always");
}
const r = spawnSync(${JSON.stringify(path.join(bin, "git-gates"))}, [...front, ...args], { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
`, { mode: 0o755 });
  const calls = () => read(log).split("\n").filter(Boolean).map((z) => JSON.parse(z));
  return {
    log, redirect, calls,
    // The calls with this subcommand (the first part after the hardening and all `-c`).
    including: (...command) => calls().filter((a) => {
      const rest = [];
      for (let i = 0; i < a.args.length; i++) { if (a.args[i] === "-c") { i++; continue; } rest.push(a.args[i]); }
      return command.every((b, i) => rest[i] === b);
    }),
    response: (arg, text) => fs.writeFileSync(path.join(gates, `antwort-${arg}`), text),
  };
}

// The frame: withCreation + wrapper + fake git-lfs + repos + seam + open storage gate + a recorder for bell and log.
async function withClone(fn) {
  await withCreation(async (m) => {
    const { ctx } = m;
    const bin = path.join(ctx.root, "fake-bin");
    const g = cloneGit(bin, m.gitGates, ctx.root);
    const lfsLog = path.join(ctx.root, "lfs.jsonl");
    fakeLfs(bin, lfsLog);
    const repos = buildRepos(path.join(ctx.root, "sources-repos"));
    fs.writeFileSync(g.redirect, JSON.stringify([[`file://${repos.main}`, URL_H], [`file://${repos.sub}`, URL_S]]));
    const log = [];
    const hints = [];
    const real = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    for (const k of Object.keys(real)) console[k] = (...a) => { log.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); real[k](...a); };
    setCloneLogs(["file"]);
    setSetupSaveGate(() => true); // the machine's gate (storageSituation) would otherwise measure the Mac
    setSetupHint((h) => hints.push(h));
    try {
      await fn({ ...m, g, lfsLog, repos, log, hints });
    } finally {
      setCloneLogs([]);
      setSetupSaveGate(null);
      setSetupHint(null);
      Object.assign(console, real);
    }
  });
}

const cloneBody = (extra = {}, clone = {}) => ({ name: "Clone", sources: [{ kind: "clone", clone: { url: URL_INPUT, ...clone }, ...extra }] });
const source = (pid, seq = 1) => store.sourceOf(pid, seq);
const sourceError = (pid, what) => waitUntil(pid, (e) => e?.sources.find((q) => q.seq === 1)?.state === "error", what);
const again = async (ctx, pid) => {
  const r = await request(setupRoute(ctx.base, pid, "again"), { method: "POST" });
  assert.equal(r.status, 202, JSON.stringify(r.body));
};
const accesses = (ctx) => {
  store.setGitCred(ctx.ws.id, "git.example.invalid", "clone-user", SECRET_H);
  store.setGitCred(ctx.ws.id, "sub.example.invalid", "sub-user", SECRET_S);
};
// The states of source 1 in the events from `ab` on, until the project's "finished" event is there (SSE arrives in order).
// The reader lags behind the store (SSE under load: "error → lfs → …"): `sourceError`/`waitUntil` see the state
// in the store, the event for it can arrive in the stream only AFTER the mark `ab`. The mark is therefore set only when the stream
// has itself last shown the source's state.
async function streamShows(reader, pid, state) {
  await waitForTruthy(() => reader.events.filter((e) => e.type === "project/setup" && e.projectId === pid && e.source?.seq === 1).at(-1)?.source.state === state,
    `event "${state}" in the stream`);
  return reader.events.length;
}
async function sourceStatesUntilFinished(reader, pid, from) {
  const here = () => reader.events.slice(from).filter((e) => e.type === "project/setup" && e.projectId === pid);
  await waitForTruthy(() => here().some((e) => e.state === "finished"), "event \"finished\"");
  return here().filter((e) => e.source?.seq === 1).map((e) => e.source.state);
}
const helperKey = (a) => a.config.map(([k]) => k).filter((k) => /^credential\..+\.helper$/.test(k));
// No value (token, user) in docker argv, git argv, events, view, bell, log.
function withoutValues({ ctx, fd, g, reader, log, hints }, view, values = [SECRET_H, SECRET_S, "clone-user", "sub-user"]) {
  const locations = {
    "docker-argv": JSON.stringify(fd.calls().map((a) => a.args)),
    "git-argv": JSON.stringify(g.calls().map((a) => a.args)),
    events: JSON.stringify(reader.events),
    view: JSON.stringify(view),
    bell: JSON.stringify(hints),
    log: log.join("\n"),
  };
  for (const [location, text] of Object.entries(locations)) for (const w of values) assert.ok(!text.includes(w), `"${w}" is in ${location}`);
  for (const w of [SECRET_H, SECRET_S]) assert.ok(!read(g.log).includes(w), `a token in the wrapper's git log (${ctx.root})`);
}

// ── (P) The check ──────────────────────────────────────────────────────────────────────────────────────────────────

test("(P) check of the clone input: 400 with code for every forbidden form, and nothing is created; default target, normal form; the seam only in clone.js", async () => {
  await withCreation(async ({ ctx, fd }) => {
    const wsPath = path.join(ctx.root, "workspace");
    const folderPrior = fs.readdirSync(wsPath).sort();
    const projectsPrior = store.listAllProjects().length;
    const k = (url, branch) => ({ name: "Clone", sources: [{ kind: "clone", clone: { url, ...(branch === undefined ? {} : { branch }) } }] });
    const cases = [
      [{ name: "Clone", sources: [{ kind: "clone", target: "k" }] }, "ONLY_HTTPS"],
      [{ name: "Clone", sources: [{ kind: "clone", clone: [] }] }, "ONLY_HTTPS"],
      [k("http://git.example.invalid/o/r.git"), "ONLY_HTTPS"],
      [k("git@github.com:o/r.git"), "ONLY_HTTPS", /SSH/],
      [k("ssh://git@git.example.invalid/o/r.git"), "ONLY_HTTPS", /SSH/],
      [k("file:///tmp/x.git"), "ONLY_HTTPS"],
      [k("ext::sh"), "ONLY_HTTPS"],
      [k(`https://user:${SECRET_H}@git.example.invalid/o/r.git`), "WITH_USER"],
      [k("https://@git.example.invalid/o/r.git"), "WITH_USER"],
      [k("https://git.example.invalid/o/r.git?private_token=x"), "WITH_QUERY"],
      [k("https://git.example.invalid/o/r.git#@x"), "WITH_FRAGMENT"],
      [k(URL_H, "-x"), "BRANCH"],
      [k(URL_H, "a b"), "BRANCH"],
      [k(URL_H, "x".repeat(201)), "BRANCH"],
      [k("https://git.example.invalid/o/r ü"), "CHARACTER"],
      [k("https://git.example.invalid/o/%zz"), "CHARACTER"],
      [k("https://git%2eexample.invalid/o/r"), "HOST_UNCLEAR"],
      [k("https://git.example.invalid/"), "HOST_UNCLEAR"],
      [{ name: "Clone", sources: [{ kind: "clone", target: "", clone: { url: URL_H } }] }, "TARGET_INVALID"],
      [{ name: "Clone", sources: [{ kind: "clone", target: ".git", clone: { url: URL_H } }] }, "TARGET_INVALID"],
      [{ name: "Clone", sources: [{ kind: "clone", clone: { url: URL_H } }, { kind: "clone", clone: { url: "https://other.invalid/x/r" } }] }, "TARGET_DUPLICATE"],
      [{ name: "Clone", sources: [{ kind: "clone", target: "r", clone: { url: URL_H } }, { kind: "folder", target: "r/x" }] }, "TARGET_DUPLICATE"],
      [{ name: "Clone", sources: [{ kind: "clone", target: "a/r", clone: { url: URL_H } }, { kind: "clone", target: "a", clone: { url: URL_S } }] }, "TARGET_DUPLICATE"],
      [{ name: "Clone", sources: [{ kind: "clone", target: "a/r", clone: { url: URL_H } }], codeRepos: ["a"] }, "CODE_REPO_LOCATION"],
    ];
    for (const [body, code, set] of cases) {
      const r = await request(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body });
      assert.equal(r.status, 400, `${code}: ${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, code, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
      assert.equal(typeof r.body.error, "string");
      if (set) assert.match(r.body.error, set);
      assert.ok(!JSON.stringify(r.body).includes(SECRET_H), "the value of a user part is in the answer");
    }
    assert.deepEqual(fs.readdirSync(wsPath).sort(), folderPrior, "no folder was created");
    assert.equal(store.listAllProjects().length, projectsPrior, "no project was created");
    assert.deepEqual(store.setups(), [], "no setup");
    assert.deepEqual(fd.calls(), [], "no docker");

    // Normal form and default target (pure).
    assert.deepEqual(checkCloneDetail({ url: ` ${URL_INPUT} `, branch: "branch-b" }),
      { ok: true, url: URL_H, branch: "branch-b", host: "git.example.invalid", hostWithPort: "git.example.invalid:8443", name: "r" });
    assert.deepEqual(checkCloneDetail({ url: "https://git.example.invalid:443/group/My%20Repo.git" }),
      { ok: true, url: "https://git.example.invalid/group/My%20Repo.git", branch: null, host: "git.example.invalid", hostWithPort: "git.example.invalid", name: "My Repo" });
    // The seam: file only with it.
    assert.equal(checkCloneDetail({ url: "file:///tmp/x.git" }).code, "ONLY_HTTPS");
    setCloneLogs(["file"]);
    try { assert.equal(checkCloneDetail({ url: "file:///tmp/x.git" }).ok, true); } finally { setCloneLogs([]); }
    assert.equal(checkCloneDetail({ url: "file:///tmp/x.git" }).code, "ONLY_HTTPS", "the seam does not take itself back");
  });
  // The guard of the seams: no server file except clone.js names setCloneLogs or setSubmoduleCap (server.js never calls them).
  for (const seam of ["setCloneLogs", "setSubmoduleCap"]) {
    const hits = [];
    const run = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === "node_modules") continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) run(p);
        else if (/\.(c|m)?js$/.test(e.name) && fs.readFileSync(p, "latin1").includes(seam)) hits.push(path.relative(SERVER, p));
      }
    };
    run(SERVER);
    assert.deepEqual(hits, [path.join("server", "projectbox", "setup", "clone.js")], `the test seam ${seam} is outside clone.js: ${hits.join(", ")}`);
  }
});

// ── (K1) The whole path ────────────────────────────────────────────────────────────────────────────────────────────

test("(K1) clone with submodule and LFS in the container: access per host including port, local https address of the submodule, ONE rename, view with url/host/branch, no value anywhere; plus the graph worktree with LFS", async () => {
  await withClone(async (m) => {
    const { ctx, fd, gitGates, g, lfsLog } = m;
    accesses(ctx);
    gitHold(gitGates, "update");
    const proj = await create(ctx, cloneBody({ target: "code/r" }, { branch: "branch-b" }));
    const pid = proj.id;
    const beginning = proj.setup.sources[0];
    assert.deepEqual({ kind: beginning.kind, target: beginning.target, state: beginning.state, url: beginning.url, branch: beginning.branch, host: beginning.host, fetched: beginning.fetched },
      { kind: "clone", target: "code/r", state: "clone", url: URL_H, branch: "branch-b", host: "git.example.invalid", fetched: undefined });

    // At the gate before `submodule update`: the clone lies in the staging, the view stands on `submodule`, carries `fetched`
    // (from now on "take over as is" takes it) and holds busy.
    await gitWaiting(gitGates, "update");
    const b = staging(proj, 1);
    const sq = (await viewIn(ctx, pid)).setup.sources[0];
    assert.deepEqual({ state: sq.state, url: sq.url, branch: sq.branch, host: sq.host, fetched: sq.fetched }, { state: "submodule", url: URL_H, branch: "branch-b", host: "git.example.invalid", fetched: true });
    assert.equal((await active(ctx.base)).busy, true, "a running clone holds busy");
    assert.equal(source(pid).cloneFetched, true, "clone_fetched is set AFTER the clone");
    assert.equal(read(path.join(b, ".gitmodules")), GITMODULES, ".gitmodules unchanged");
    assert.equal(eg(b, "config", "--local", "submodule.lib.url"), URL_S, "the local address of the submodule is https");
    gitContinue(gitGates, "update");
    await finished(pid);

    // The clone at the target: branch, submodule, LFS files of both repos.
    const target = path.join(proj.path, "code", "r");
    assert.equal(read(path.join(target, "b.txt")), "branch only\n", "--branch branch-b");
    assert.equal(eg(target, "rev-parse", "--abbrev-ref", "HEAD"), "branch-b");
    assert.equal(eg(target, "remote", "get-url", "origin"), URL_H, "the remote is the https address (without access)");
    assert.equal(read(path.join(target, ".gitmodules")), GITMODULES);
    assert.equal(read(path.join(target, "lib", "sub.txt")), "Sub\n", "the submodule is there");
    assert.equal(read(path.join(target, "large.bin")), `LFS-CONTENT ${OID_H}\n`);
    assert.equal(read(path.join(target, "lib", "data.bin")), `LFS-CONTENT ${OID_S}\n`);
    assert.equal(fs.existsSync(b), false, "the staging is gone");

    // git: cloned with hardening, https permission, pack.threads=1, SKIP_SMUDGE and the host's access WITH port.
    const clones = g.including("clone");
    assert.equal(clones.length, 1, JSON.stringify(g.calls().map((a) => a.args)));
    const kl = clones[0];
    for (const t of [...GIT_HARDENING, "protocol.https.allow=always", "pack.threads=1", "--branch", "branch-b", "--", URL_H, path.resolve(b)]) {
      assert.ok(kl.args.includes(t), `clone without "${t}": ${JSON.stringify(kl.args)}`);
    }
    assert.deepEqual(helperKey(kl), ["credential.https://git.example.invalid:8443.helper"], JSON.stringify(kl.config));
    assert.deepEqual(kl.user, ["clone-user"]);
    assert.equal(kl.password, true);
    assert.equal(kl.skip, "1", "GIT_LFS_SKIP_SMUDGE=1 at the clone");
    assert.equal(kl.prompt, "0");
    const upd = g.including("submodule", "update");
    assert.equal(upd.length, 1);
    assert.deepEqual(upd[0].args.slice(-3), ["update", "--", "lib"], "without --recursive, per path");
    assert.ok(!upd[0].args.includes("--recursive"));
    assert.deepEqual(helperKey(upd[0]), ["credential.https://sub.example.invalid.helper"], JSON.stringify(upd[0].config));
    assert.deepEqual(upd[0].user, ["sub-user"]);
    assert.equal(upd[0].skip, "1");
    // Each of these calls ran IN the container: the docker log carries it as exec.
    const execs = fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec").map((a) => a.args);
    assert.ok(execs.some((a) => a.includes("git") && a.includes("clone") && a.includes(URL_H)), "the clone did not run via docker exec");
    assert.ok(execs.some((a) => a.includes("git") && a.includes("lfs") && a.includes("pull")), "LFS did not run via docker exec");

    // LFS: per repo with the access of ITS host, SKIP_SMUDGE=0 at the pull.
    const pulls = lfsCalls(lfsLog).filter((a) => a.command === "pull");
    const rb = fs.realpathSync(path.dirname(b));
    assert.deepEqual(pulls.map((a) => path.relative(rb, a.cwd)), [path.basename(b), path.join(path.basename(b), "lib")]);
    assert.ok(pulls[0].key.includes("credential.https://git.example.invalid:8443.helper"), JSON.stringify(pulls[0]));
    assert.deepEqual(pulls[0].user, ["clone-user"]);
    assert.ok(pulls[1].key.includes("credential.https://sub.example.invalid.helper"), JSON.stringify(pulls[1]));
    assert.deepEqual(pulls[1].user, ["sub-user"]);
    assert.ok(pulls.every((a) => a.skip === "0" && a.password === true));
    // ONE rename: the inode of the staging (measured at the LFS pull) is the target's.
    assert.equal(fs.statSync(target).ino, pulls[0].ino, "the clone was not placed with ONE rename");

    withoutValues(m, await viewIn(ctx, pid));

    // The graph worktree of the cloned repo — pointer in the fresh worktree, LFS with the host's access, in the container.
    const prior = lfsCalls(lfsLog).length;
    const info = await createGraphWorktree({ startId: "c0ffee00aa000001", project: store.getProject(pid), root: locationFor({ projectId: pid, converted: true }).worktrees });
    const r = info.repos.find((x) => x.relPath === path.join("code", "r"));
    assert.ok(r, `no worktree for code/r: ${JSON.stringify(info.repos.map((x) => x.relPath))}`);
    assert.equal(read(path.join(r.target, "large.bin")), `LFS-CONTENT ${OID_H}\n`, "the worktree carries a pointer instead of the LFS file");
    const wt = lfsCalls(lfsLog).slice(prior).filter((a) => a.command === "pull" && a.cwd === fs.realpathSync(r.target));
    assert.equal(wt.length, 1, JSON.stringify(lfsCalls(lfsLog).slice(prior)));
    assert.ok(wt[0].key.includes("credential.https://git.example.invalid:8443.helper"));
    assert.deepEqual(wt[0].user, ["clone-user"]);
    assert.ok(fd.calls({ daemon: "host" }).some((a) => a.args[0] === "exec" && a.args.includes("lfs") && a.args.includes("pull") && a.args.includes(r.target)),
      "the worktree's LFS pull did not run via docker exec (with the worktree as -w)");

    // In the code tab: "Pull" fetches the new LFS file with the access of the remote host (from the project's workspace);
    // "update submodules" carries the sub host's access (the local https address after the clone).
    const { repos } = m;
    eg(repos.mainWork, "checkout", "-q", "branch-b");
    fs.writeFileSync(path.join(repos.mainWork, "new.bin"), pointer("f".repeat(64)));
    eg(repos.mainWork, "add", "new.bin");
    eg(repos.mainWork, "commit", "-q", "-m", "new.bin");
    eg(repos.mainWork, "push", "-q", repos.main, "branch-b");
    const beforePull = lfsCalls(lfsLog).length;
    const pull = await request(`${ctx.base}/api/projects/${pid}/git/pull`, { method: "POST", body: { repo: "code/r" } });
    assert.equal(pull.status, 200, JSON.stringify(pull.body).slice(0, 400));
    assert.equal(read(path.join(target, "new.bin")), `LFS-CONTENT ${"f".repeat(64)}\n`, "the pull in the code tab left a pointer");
    const pullLfs = lfsCalls(lfsLog).slice(beforePull).filter((a) => a.command === "pull");
    assert.equal(pullLfs.length, 1);
    assert.ok(pullLfs[0].key.includes("credential.https://git.example.invalid:8443.helper"), JSON.stringify(pullLfs[0]));
    assert.deepEqual(pullLfs[0].user, ["clone-user"]);
    const sub = await request(`${ctx.base}/api/projects/${pid}/git/submodule/update`, { method: "POST", body: { repo: "code/r" } });
    assert.equal(sub.status, 200, JSON.stringify(sub.body).slice(0, 400));
    const updAll = g.including("submodule", "update");
    const updCode = updAll[updAll.length - 1];
    assert.ok(updCode.args.includes("--init") && updCode.args.includes("--recursive"), JSON.stringify(updCode.args));
    assert.ok(helperKey(updCode).includes("credential.https://sub.example.invalid.helper"), JSON.stringify(updCode.config));
    assert.ok(updCode.user.includes("sub-user"));
    withoutValues(m, await viewIn(ctx, pid));
  });
});

// ── (K2) Clone errors ────────────────────────────────────────────────────────────────────────────────────────────

test("(K2) NO_ACCESS with host, ACCESS_REJECTED, \"not found\" with/without access, \"take over as is\" without a clone 409, \"again\" clones anew", async () => {
  await withClone(async (m) => {
    const { ctx, g } = m;
    g.response("clone", "fatal: could not read Username for 'https://git.example.invalid:8443': terminal prompts disabled\n");
    const proj = await create(ctx, cloneBody());
    const pid = proj.id;
    await sourceError(pid, "NO_ACCESS");
    let q = source(pid);
    assert.deepEqual({ code: q.code, host: q.host, cloneFetched: q.cloneFetched }, { code: "NO_ACCESS", host: "git.example.invalid", cloneFetched: false });
    assert.match(q.error, /git\.example\.invalid/);
    assert.deepEqual(helperKey(g.including("clone")[0]), [], "without a stored access no helper");
    const sq = (await viewIn(ctx, pid)).setup.sources[0];
    assert.deepEqual({ state: sq.state, code: sq.code, host: sq.host, fetched: sq.fetched }, { state: "error", code: "NO_ACCESS", host: "git.example.invalid", fetched: undefined },
      "without a fetched clone no `fetched` (the clients then do not offer \"take over as is\")");
    // "Take over as is" without a fetched clone: 409, nothing changed.
    const ueb = await request(setupRoute(ctx.base, pid, "sources/1/finished"), { method: "POST", body: { takeOver: true } });
    assert.equal(ueb.status, 409, JSON.stringify(ueb.body));
    assert.equal(ueb.body.code, "SOURCE_STATE");
    assert.equal(source(pid).state, "error");

    // An access the server rejects.
    store.setGitCred(ctx.ws.id, "git.example.invalid", "clone-user", "wrong");
    g.response("clone", "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://git.example.invalid:8443/o/r.git/'\n");
    await again(ctx, pid);
    await sourceError(pid, "ACCESS_REJECTED");
    q = source(pid);
    assert.deepEqual({ code: q.code, host: q.host }, { code: "ACCESS_REJECTED", host: "git.example.invalid" });
    assert.deepEqual(helperKey(g.including("clone")[1]), ["credential.https://git.example.invalid:8443.helper"]);

    // "Repository not found" WITH access: rejected (a token without rights); WITHOUT access: CLONE with the last row.
    g.response("clone", "remote: Repository not found.\nfatal: repository 'https://git.example.invalid:8443/o/r.git/' not found\n");
    await again(ctx, pid);
    await sourceError(pid, "not found with access");
    assert.equal(source(pid).code, "ACCESS_REJECTED");
    store.deleteGitCred(ctx.ws.id, "git.example.invalid");
    g.response("clone", "remote: Repository not found.\nfatal: repository 'https://git.example.invalid:8443/o/r.git/' not found\n");
    await again(ctx, pid);
    await sourceError(pid, "not found without access");
    q = source(pid);
    assert.equal(q.code, "CLONE");
    // ONLY the reason (the last stderr row): web and iOS put it into "{source}: clone failed: {reason}".
    assert.equal(q.error, "fatal: repository 'https://git.example.invalid:8443/o/r.git/' not found");

    // With access: "again" clones anew (public repos need none — here it is there) and ends.
    accesses(ctx);
    await again(ctx, pid);
    await finished(pid);
    assert.equal(g.including("clone").length, 5, "every \"again\" in `clone` clones anew");
    assert.equal(read(path.join(proj.path, "r", "README.md")), "Main\n", "default target: the last address part without .git");
    assert.equal(read(path.join(proj.path, "r", "lib", "data.bin")), `LFS-CONTENT ${OID_S}\n`);
    withoutValues(m, await viewIn(ctx, pid));
  });
});

// ── (K3) Submodule without access, then LFS ────────────────────────────────────────────────────────────────────────────

test("(K3) SUBMODULE_ACCESS with the submodule's host — \"again\" resumes at submodule (ONE clone); LFS fails — \"again\" resumes at lfs", async () => {
  await withClone(async (m) => {
    const { ctx, g, lfsLog } = m;
    store.setGitCred(ctx.ws.id, "git.example.invalid", "clone-user", SECRET_H); // only the main host
    g.response("update", `fatal: could not read Username for '${URL_S.replace(/\/o\/sub\.git$/, "")}': terminal prompts disabled\nfatal: clone of '${URL_S}' into submodule path 'lib' failed\n`);
    const proj = await create(ctx, cloneBody());
    const pid = proj.id;
    await sourceError(pid, "SUBMODULE_ACCESS");
    let q = source(pid);
    assert.deepEqual({ code: q.code, host: q.host, cloneFetched: q.cloneFetched, submoduleFetched: q.submoduleFetched },
      { code: "SUBMODULE_ACCESS", host: "sub.example.invalid", cloneFetched: true, submoduleFetched: false });
    // ONLY the name: the clients put it into "{source}: no access for a submodule on {host}", the host is in `host`.
    assert.equal(q.error, "Submodul „lib“");
    const sqs = (await viewIn(ctx, pid)).setup.sources[0];
    assert.deepEqual({ code: sqs.code, host: sqs.host, error: sqs.error, fetched: sqs.fetched }, { code: "SUBMODULE_ACCESS", host: "sub.example.invalid", error: "Submodul „lib“", fetched: true });
    assert.deepEqual(helperKey(g.including("submodule", "update")[0]), [], "no access stored for the sub host");
    assert.ok(fs.existsSync(path.join(staging(proj, 1), ".git")), "the clone stays in the staging");

    // Create the access, "again": no second clone; then LFS fails.
    store.setGitCred(ctx.ws.id, "sub.example.invalid", "sub-user", SECRET_S);
    lfsFails(lfsLog, "batch response: Authentication required: Authorization error\n");
    await again(ctx, pid);
    assert.equal(source(pid).host, "git.example.invalid", "\"again\" resets the host to that of the address");
    await sourceError(pid, "LFS");
    q = source(pid);
    assert.deepEqual({ code: q.code, submoduleFetched: q.submoduleFetched, lfsFetched: q.lfsFetched }, { code: "LFS", submoduleFetched: true, lfsFetched: false });
    // ONLY the reason (the main repo, without submodule addition): the clients put it into "{source}: LFS files failed: {reason}".
    assert.equal(q.error, "batch response: Authentication required: Authorization error");
    assert.equal(g.including("clone").length, 1, "\"again\" after SUBMODULE_ACCESS cloned anew");
    assert.equal(g.including("submodule", "update").length, 2);

    lfsFails(lfsLog, null);
    const from = await streamShows(m.reader, pid, "error");
    await again(ctx, pid);
    await finished(pid);
    const states = await sourceStatesUntilFinished(m.reader, pid, from);
    assert.equal(states[0], "lfs", `"again" after LFS stood first in ${states[0]} (${states.join(" → ")})`);
    assert.equal(g.including("clone").length, 1);
    assert.equal(g.including("submodule", "update").length, 2, "\"again\" after LFS fetched the submodules anew");
    assert.equal(read(path.join(proj.path, "r", "large.bin")), `LFS-CONTENT ${OID_H}\n`);
    assert.equal(read(path.join(proj.path, "r", "lib", "data.bin")), `LFS-CONTENT ${OID_S}\n`);
    withoutValues(m, await viewIn(ctx, pid));
  });
});

// ── (K4) Target occupied ───────────────────────────────────────────────────────────────────────────────────────────────

test("(K4a) TARGET_OCCUPIED before the clone: nothing cloned, nothing deleted; \"again\" after clearing ⇒ done", async () => {
  await withClone(async ({ ctx, g, pyGates }) => {
    accesses(ctx);
    pyHold(pyGates, "clone");
    const proj = await create(ctx, cloneBody());
    const pid = proj.id;
    await pyWaiting(pyGates, "clone");
    const foreign = path.join(proj.path, "r");
    fs.writeFileSync(foreign, "foreign\n"); // an agent wrote it while the chats were running
    pyContinue(pyGates, "clone");
    await sourceError(pid, "TARGET_OCCUPIED");
    assert.equal(source(pid).code, "TARGET_OCCUPIED");
    assert.equal(g.including("clone").length, 0, "cloned although the target is occupied");
    assert.equal(read(foreign), "foreign\n", "the foreign file was touched");
    assert.equal(fs.existsSync(staging(proj, 1)), false);
    fs.rmSync(foreign);
    await again(ctx, pid);
    await finished(pid);
    assert.equal(read(path.join(proj.path, "r", "README.md")), "Main\n");
  });
});

test("(K4b) TARGET_OCCUPIED when placing: nothing moved (no other source either), the staging stays; \"again\" fails again; \"continue without this source\" ⇒ done", async () => {
  await withClone(async ({ ctx, gitGates, g }) => {
    accesses(ctx);
    gitHold(gitGates, "lfs");
    const body = cloneBody();
    body.sources.push({ kind: "files", target: "docs", bytes: 2 });
    const proj = await create(ctx, body);
    const pid = proj.id;
    await gitWaiting(gitGates, "lfs");
    // The second source uploads while the clone runs (one source at a time per project applies only to server states).
    const beg = await request(setupRoute(ctx.base, pid, "sources/2/begin"), { method: "POST", body: { bytes: 2 } });
    assert.equal(beg.status, 200, JSON.stringify(beg.body));
    // The subtree of a staging mirrors the target paths relative to the root (./operation.js).
    fs.mkdirSync(path.join(staging(proj, 2), "docs"), { recursive: true });
    fs.writeFileSync(path.join(staging(proj, 2), "docs", "s.txt"), "ok");
    assert.equal((await request(setupRoute(ctx.base, pid, "sources/2/finished"), { method: "POST" })).status, 202);
    const foreign = path.join(proj.path, "r");
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, "foreign.txt"), "foreign\n");
    gitContinue(gitGates, "lfs");
    const check = async (what) => {
      const e = await waitUntil(pid, (x) => x?.state === "error", what, { errorAllowed: true });
      assert.equal(e.code, "TARGET_OCCUPIED", JSON.stringify({ code: e.code, error: e.error }));
      assert.equal(source(pid).code, "TARGET_OCCUPIED");
      assert.deepEqual(fs.readdirSync(foreign), ["foreign.txt"], "something at the target was moved");
      assert.ok(fs.existsSync(path.join(staging(proj, 1), ".git")), "the clone no longer lies in the staging");
      assert.equal(fs.existsSync(path.join(proj.path, "docs")), false, "another source was placed before the clone failed");
      assert.equal(read(path.join(staging(proj, 2), "docs", "s.txt")), "ok");
    };
    await check("TARGET_OCCUPIED when placing");
    await again(ctx, pid);
    await check("TARGET_OCCUPIED after \"again\"");
    assert.equal(g.including("clone").length, 1, "\"again\" after placing does not clone anew");
    const way = await request(setupRoute(ctx.base, pid, "sources/1/leaveOut"), { method: "POST" });
    assert.equal(way.status, 202, JSON.stringify(way.body));
    await finished(pid);
    assert.equal(fs.existsSync(staging(proj, 1)), false, "the staging falls with \"continue without this source\"");
    assert.deepEqual(fs.readdirSync(foreign), ["foreign.txt"]);
    assert.equal(read(path.join(proj.path, "docs", "s.txt")), "ok", "the other source arrives afterwards");
  });
});

// ── (K5) Abort ────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(K5) abort in the middle of submodule init: aborted, the clone stays; \"again\" resumes at submodule, without a second clone", async () => {
  await withClone(async ({ ctx, gitGates, g, reader }) => {
    accesses(ctx);
    gitHold(gitGates, "init");
    const proj = await create(ctx, cloneBody());
    const pid = proj.id;
    await gitWaiting(gitGates, "init");
    const abort = await request(setupRoute(ctx.base, pid, "sources/1/abort"), { method: "POST" });
    assert.equal(abort.status, 202, JSON.stringify(abort.body));
    await waitUntil(pid, (e) => e?.sources[0]?.state === "aborted", "aborted");
    const q = source(pid);
    assert.deepEqual({ state: q.state, cloneFetched: q.cloneFetched, submoduleFetched: q.submoduleFetched }, { state: "aborted", cloneFetched: true, submoduleFetched: false });
    assert.ok(fs.existsSync(path.join(staging(proj, 1), "README.md")), "the clone stays");
    assert.equal((await active(ctx.base)).busy, false);
    const from = await streamShows(reader, pid, "aborted");
    await again(ctx, pid);
    await finished(pid);
    const states = await sourceStatesUntilFinished(reader, pid, from);
    assert.equal(states[0], "submodule", `"again" after the abort stood first in ${states[0]} (${states.join(" → ")})`);
    assert.ok(!states.includes("clone"));
    assert.equal(g.including("clone").length, 1, "\"again\" after the abort cloned anew");
    assert.equal(read(path.join(proj.path, "r", "lib", "sub.txt")), "Sub\n");
  });
});

// ── (K6) Storage gate ──────────────────────────────────────────────────────────────────────────────────────────────

test("(K6) storage gate closed: waiting storage, busy false, no clone; open wakes the storage queue, and the clone ends", async () => {
  await withClone(async ({ ctx, g }) => {
    accesses(ctx);
    let open = false;
    setSetupSaveGate(() => open);
    const proj = await create(ctx, cloneBody());
    const pid = proj.id;
    await waitUntil(pid, (e) => e?.waiting === "storage", "waits for storage");
    assert.equal((await viewIn(ctx, pid)).setup.waiting, "storage");
    assert.deepEqual({ state: source(pid).state, process: source(pid).process }, { state: "clone", process: "" });
    assert.equal((await active(ctx.base)).busy, false, "a waiting setup does not hold busy");
    assert.equal(g.including("clone").length, 0);
    assert.equal(wakeStorageQueue(), 0, "gate closed: no start");
    open = true;
    assert.equal(wakeStorageQueue(), 1, "gate open: one start");
    await finished(pid);
    assert.equal(g.including("clone").length, 1);
    assert.equal(read(path.join(proj.path, "r", "README.md")), "Main\n");
  });
});

// ── (K7) Remote hint ────────────────────────────────────────────────────────────────────────────────────────────

test("(K7) remote with access in the address: remoteHints in store and view, bell — names only, cbase rewrites nothing", async () => {
  await withClone(async (m) => {
    const { ctx, gitGates, hints } = m;
    accesses(ctx);
    gitHold(gitGates, "lfs");
    const proj = await create(ctx, cloneBody({ target: "code/r" }));
    const pid = proj.id;
    await gitWaiting(gitGates, "lfs");
    const spiegel = `https://oauth2:${SECRET_R}@mirror.example.invalid/o/r.git`;
    eg(staging(proj, 1), "remote", "add", "mirror", spiegel); // like a remote brought along (the agent, a hook)
    gitContinue(gitGates, "lfs");
    await finished(pid);
    const expected = [{ repo: "code/r", remote: "mirror" }];
    assert.deepEqual(store.remoteHintsOf(pid), expected);
    const view = await viewIn(ctx, pid);
    assert.deepEqual(view.remoteHints, expected, JSON.stringify(view));
    assert.equal(hints.length, 1, JSON.stringify(hints));
    assert.match(hints[0].text, /mirror/);
    assert.match(hints[0].text, /code\/r/);
    assert.equal(eg(path.join(proj.path, "code", "r"), "remote", "get-url", "mirror"), spiegel, "cbase rewrote the remote");
    withoutValues(m, view, [SECRET_H, SECRET_S, SECRET_R, "oauth2:"]);
    // The delete path takes the hint along (deleteSetup).
    store.deleteSetup(pid);
    assert.deepEqual(store.remoteHintsOf(pid), []);
  });
});

// ── (K8) "Take over as is", then target occupied when placing ───────────────────────────────────────────

test("(K8a) LFS fails, \"take over as is\", placing finds the target occupied, \"again\" after clearing ⇒ the clone stands at the target (without LFS files, as taken over) — no silent drop", async () => {
  await withClone(async ({ ctx, g, lfsLog }) => {
    accesses(ctx);
    lfsFails(lfsLog, "batch response: broken\n");
    const proj = await create(ctx, cloneBody());
    const pid = proj.id;
    await sourceError(pid, "LFS");
    const q = source(pid);
    assert.deepEqual({ code: q.code, cloneFetched: q.cloneFetched, submoduleFetched: q.submoduleFetched, lfsFetched: q.lfsFetched },
      { code: "LFS", cloneFetched: true, submoduleFetched: true, lfsFetched: false });
    const foreign = path.join(proj.path, "r");
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, "foreign.txt"), "foreign\n");
    const ueb = await request(setupRoute(ctx.base, pid, "sources/1/finished"), { method: "POST", body: { takeOver: true } });
    assert.equal(ueb.status, 202, JSON.stringify(ueb.body));
    const e = await waitUntil(pid, (x) => x?.state === "error", "TARGET_OCCUPIED when placing", { errorAllowed: true });
    assert.deepEqual({ step: e.step, code: e.code }, { step: "place", code: "TARGET_OCCUPIED" }, e.error);
    assert.deepEqual(fs.readdirSync(foreign), ["foreign.txt"]);
    fs.rmSync(foreign, { recursive: true });
    await again(ctx, pid);
    await finished(pid);
    const target = path.join(proj.path, "r");
    assert.equal(fs.existsSync(path.join(target, "README.md")), true, "\"again\" after placing silently dropped the taken-over clone");
    assert.equal(read(path.join(target, "README.md")), "Main\n");
    assert.equal(read(path.join(target, "large.bin")), pointer(OID_H), "taken over as is: the LFS file stays a pointer");
    assert.equal(read(path.join(target, "lib", "sub.txt")), "Sub\n");
    assert.equal(fs.existsSync(staging(proj, 1)), false);
    assert.equal(g.including("clone").length, 1, "\"again\" cloned anew");
    assert.equal(lfsCalls(lfsLog).filter((a) => a.command === "pull").length, 1, "\"again\" fetched the LFS files once more");
  });
});

test("(K8b) a source that is not ready when placing (the earlier state, replayed) aborts placing by name — PLACE, nothing moved; \"again\" ⇒ placed", async () => {
  await withClone(async ({ ctx, gitGates }) => {
    accesses(ctx);
    gitHold(gitGates, "lfs");
    const proj = await create(ctx, cloneBody());
    const pid = proj.id;
    await gitWaiting(gitGates, "lfs");
    const foreign = path.join(proj.path, "r");
    fs.mkdirSync(foreign);
    gitContinue(gitGates, "lfs");
    await waitUntil(pid, (x) => x?.state === "error" && x.code === "TARGET_OCCUPIED", "TARGET_OCCUPIED when placing", { errorAllowed: true });
    fs.rmSync(foreign, { recursive: true });
    // What "again" used to leave behind (restartState by the flags): the source back on `lfs`, the setup in placing.
    store.changeSource(pid, 1, { state: "lfs", lfsFetched: false, code: "", error: "", process: "" });
    store.changeSetup(pid, { state: "setUp", code: "", error: "", process: "" });
    resumeSetup(pid);
    const e = await waitUntil(pid, (x) => x?.state === "error", "PLACE", { errorAllowed: true });
    assert.deepEqual({ step: e.step, code: e.code }, { step: "place", code: "PLACE" }, e.error);
    assert.match(e.error, /^Quelle 1 steht nicht bereit \(lfs\) — nichts eingesetzt\./);
    assert.deepEqual({ state: source(pid).state, code: source(pid).code }, { state: "error", code: "PLACE" });
    assert.equal(fs.existsSync(path.join(proj.path, "r")), false, "placed although the source was not ready");
    assert.ok(fs.existsSync(path.join(staging(proj, 1), ".git")), "the clone no longer lies in the staging");
    await again(ctx, pid);
    await finished(pid);
    assert.equal(read(path.join(proj.path, "r", "README.md")), "Main\n");
  });
});

// ── (K9) Restart between clone and submodule ─────────────────────────────────────────────────────

test("(K9) a restart between clone and submodule: the view says INTERRUPTED with `fetched`, the resumption takes over the source and resumes at submodule — without a second clone", async () => {
  await withClone(async ({ ctx, gitGates, g, reader }) => {
    accesses(ctx);
    // The run ends at the gate before `submodule init`, without git (like one whose server is gone).
    gitHold(gitGates, "init");
    fs.writeFileSync(path.join(gitGates, "abort-init"), "");
    const proj = await create(ctx, cloneBody());
    const pid = proj.id;
    await gitWaiting(gitGates, "init");
    assert.deepEqual({ state: source(pid).state, cloneFetched: source(pid).cloneFetched }, { state: "submodule", cloneFetched: true });
    gitContinue(gitGates, "init");
    await sourceError(pid, "init ended");
    fs.rmSync(path.join(gitGates, "abort-init"));
    // The state after a restart in `submodule`: the boot id of the earlier process, no error.
    store.changeSource(pid, 1, { state: "submodule", code: "", error: "", process: "one-previous-process" });
    const sq = (await viewIn(ctx, pid)).setup.sources[0];
    assert.deepEqual({ state: sq.state, code: sq.code, fetched: sq.fetched }, { state: "error", code: "INTERRUPTED", fetched: true });
    const from = await streamShows(reader, pid, "error");
    resumeSetup(pid);
    await finished(pid, "the resumption did not take over the interrupted source");
    const states = await sourceStatesUntilFinished(reader, pid, from);
    assert.equal(states[0], "submodule", `the resumption stood first in ${states[0]} (${states.join(" → ")})`);
    assert.ok(!states.includes("clone"));
    assert.equal(g.including("clone").length, 1, "the restart cloned anew");
    assert.equal(read(path.join(proj.path, "r", "lib", "sub.txt")), "Sub\n");
  });
});

// ── (K10) Submodules without seam: malicious addresses, paths, caps ─────────────────────────────────────────

test("(K10a) a .gitmodules with file://, ext:: or -… is blocked — without the seam for submodules and without redirect: SUBMODULE, nothing fetched, no command ran", async () => {
  await withClone(async ({ ctx, g, repos }) => {
    fs.writeFileSync(g.redirect, "[]"); // no redirect: the wrapper allows no file://
    const dir = path.join(ctx.root, "malicious-repos");
    const marker = path.join(ctx.root, "MALICIOUS-RAN");
    const subSha = eg(repos.sub, "rev-parse", "HEAD");
    const cases = [
      ["malicious-file", `file://${repos.sub}`, /^Submodul „lib“: /],
      ["malicious-ext", `ext::sh -c touch% ${marker}`, /^Submodul „lib“: /],
      ["malicious-dash", `--upload-pack=touch ${marker}`, /^git submodule init: /],
    ];
    for (const [name, url, set] of cases) {
      const bare = repoWithGitmodules(dir, name, `[submodule "lib"]\n\tpath = lib\n\turl = ${url}\n`, subSha);
      const proj = await create(ctx, { name, sources: [{ kind: "clone", clone: { url: `file://${bare}` } }] });
      await sourceError(proj.id, `${name}: SUBMODULE`);
      const q = source(proj.id);
      assert.equal(q.code, "SUBMODULE", `${name}: ${q.code}: ${q.error}`);
      assert.match(q.error, set, `${name}: ${q.error}`);
      assert.equal(q.cloneFetched, true, `${name}: the main repo did not arrive (the seam applies to the clone of the main repo)`);
      assert.equal(fs.existsSync(path.join(staging(proj, 1), "lib", "sub.txt")), false, `${name}: the submodule arrived after all`);
      assert.equal(fs.existsSync(marker), false, `${name}: a command from .gitmodules ran`);
    }
  });
});

test("(K10b) a submodule path ../x or /x ⇒ SUBMODULE \"not a valid location\", no update at this path; without the entry ⇒ done", async () => {
  await withClone(async ({ ctx, gitGates, g }) => {
    accesses(ctx);
    gitHold(gitGates, ".gitmodules");
    const proj = await create(ctx, cloneBody());
    const pid = proj.id;
    await gitWaiting(gitGates, ".gitmodules");
    const b = staging(proj, 1);
    // An entry whose path points out of the repo, with an address in the local configuration — git itself would never write it for a
    // path without a gitlink; only so does the run reach the path check (a second safeguard before it becomes a cwd).
    const malicious = (p) => fs.writeFileSync(path.join(b, ".gitmodules"), `${GITMODULES}[submodule "evil"]\n\tpath = ${p}\n\turl = ${URL_S}\n`);
    malicious("../x");
    eg(b, "config", "--local", "submodule.evil.url", URL_S);
    gitContinue(gitGates, ".gitmodules");
    await sourceError(pid, "SUBMODULE ../x");
    assert.deepEqual({ code: source(pid).code, error: source(pid).error }, { code: "SUBMODULE", error: "Submodul „evil“: der Pfad „../x“ taugt nicht als Ort." });
    malicious("/x");
    await again(ctx, pid);
    await sourceError(pid, "SUBMODULE /x");
    assert.deepEqual({ code: source(pid).code, error: source(pid).error }, { code: "SUBMODULE", error: "Submodul „evil“: der Pfad „/x“ taugt nicht als Ort." });
    for (const a of g.including("submodule", "update")) assert.ok(!a.args.includes("../x") && !a.args.includes("/x"), JSON.stringify(a.args));
    fs.writeFileSync(path.join(b, ".gitmodules"), GITMODULES);
    eg(b, "config", "--local", "--remove-section", "submodule.evil");
    await again(ctx, pid);
    await finished(pid);
    assert.equal(read(path.join(proj.path, "r", "lib", "sub.txt")), "Sub\n");
    assert.equal(g.including("clone").length, 1);
  });
});

test("(K10c) depth and count of the submodules via the seam setSubmoduleCap ⇒ SUBMODULE with \"cap\", nothing behind it; without cap ⇒ done", async () => {
  await withClone(async ({ ctx, g }) => {
    accesses(ctx);
    try {
      setSubmoduleCap({ depth: 0 });
      const proj = await create(ctx, cloneBody());
      const pid = proj.id;
      await sourceError(pid, "depth cap");
      assert.deepEqual({ code: source(pid).code, error: source(pid).error },
        { code: "SUBMODULE", error: "Submodule tiefer als 0 Ebenen verschachtelt — Deckel erreicht, nicht weiter geholt." });
      assert.equal(g.including("submodule", "init").length, 0, "init ran behind the depth cap");
      setSubmoduleCap({ count: 0 });
      await again(ctx, pid);
      await sourceError(pid, "count cap");
      assert.deepEqual({ code: source(pid).code, error: source(pid).error },
        { code: "SUBMODULE", error: "Mehr als 0 Submodule — Deckel erreicht, nicht weiter geholt." });
      assert.equal(g.including("submodule", "update").length, 0, "an update ran behind the count cap");
      setSubmoduleCap(null);
      await again(ctx, pid);
      await finished(pid);
      assert.equal(read(path.join(proj.path, "r", "lib", "sub.txt")), "Sub\n");
    } finally {
      setSubmoduleCap(null);
    }
  });
});

// ── (K11) No space in submodule and lfs ────────────────────────────────────────────────────────────

test("(K11) \"No space left on device\" in the submodule update and in the LFS fetch ⇒ SLOT with the part that is missing; then done", async () => {
  await withClone(async ({ ctx, g, lfsLog }) => {
    accesses(ctx);
    g.response("update", `fatal: write error: No space left on device\nfatal: clone of '${URL_S}' into submodule path 'lib' failed\n`);
    const proj = await create(ctx, cloneBody());
    const pid = proj.id;
    await sourceError(pid, "SLOT in the submodule");
    let q = source(pid);
    assert.equal(q.code, "SLOT", `${q.code}: ${q.error}`);
    assert.match(q.error, /das Submodul „lib“ ist nicht vollständig/);
    lfsFails(lfsLog, `Error downloading object: gross.bin (${OID_H.slice(0, 7)}): write /x: no space left on device\n`);
    await again(ctx, pid);
    await sourceError(pid, "SLOT in LFS");
    q = source(pid);
    assert.equal(q.code, "SLOT", `${q.code}: ${q.error}`);
    assert.match(q.error, /der Klon ist nicht vollständig/);
    assert.deepEqual({ submoduleFetched: q.submoduleFetched, lfsFetched: q.lfsFetched }, { submoduleFetched: true, lfsFetched: false });
    lfsFails(lfsLog, null);
    await again(ctx, pid);
    await finished(pid);
    assert.equal(g.including("clone").length, 1);
    assert.equal(read(path.join(proj.path, "r", "large.bin")), `LFS-CONTENT ${OID_H}\n`);
  });
});

// ── (K12) Waiting for storage ends with the clone ─────────────────────────────────────────────────────

test("(K12) a clone waiting for storage, aborted ⇒ `waiting` falls at once; \"continue without this source\" ⇒ done with the gate closed; a row from the old state is cleared by the resumption", async () => {
  await withClone(async ({ ctx, g }) => {
    accesses(ctx);
    setSetupSaveGate(() => false);
    const proj = await create(ctx, cloneBody());
    const pid = proj.id;
    await waitUntil(pid, (e) => e?.waiting === "storage", "waits for storage");
    const from = await request(setupRoute(ctx.base, pid, "sources/1/abort"), { method: "POST" });
    assert.equal(from.status, 202, JSON.stringify(from.body));
    assert.equal(from.body.setup.waiting, undefined, "after the abort the setup waits for storage — for a clone that no longer runs");
    await waitUntil(pid, (e) => e?.sources[0]?.state === "aborted" && !e.waiting, "aborted, not waiting");
    assert.equal((await active(ctx.base)).busy, false);
    const way = await request(setupRoute(ctx.base, pid, "sources/1/leaveOut"), { method: "POST" });
    assert.equal(way.status, 202, JSON.stringify(way.body));
    await finished(pid, "\"continue without this source\" with the gate closed");
    assert.equal(g.including("clone").length, 0);
    assert.equal(fs.existsSync(path.join(proj.path, "r")), false);

    // A row from the old state: aborted, `waiting: "storage"` stayed — the resumption (here after `leaveOut`) clears it.
    const p2 = await create(ctx, cloneBody());
    await waitUntil(p2.id, (e) => e?.waiting === "storage", "waits for storage (old state)");
    assert.equal((await request(setupRoute(ctx.base, p2.id, "sources/1/abort"), { method: "POST" })).status, 202);
    await waitUntil(p2.id, (e) => e?.sources[0]?.state === "aborted", "aborted (old state)");
    store.changeSetup(p2.id, { waiting: "storage" });
    assert.equal((await request(setupRoute(ctx.base, p2.id, "sources/1/leaveOut"), { method: "POST" })).status, 202);
    await finished(p2.id, "a row from the old state stayed \"waiting for storage\"");
    assert.equal(g.including("clone").length, 0);
  });
});

// COUNTER-TESTS (each ONE sabotage in the working tree, the file run, then restored):
//   - clone.js: `GIT_LFS_SKIP_SMUDGE: "1"` removed from the clone                     ⇒ (K1) red
//   - clone.js: the helper under `source.host` (without port) instead of hostFromAddress ⇒ (K1) red
//   - clone.js: the SSH address not rewritten                                          ⇒ (K1) red
//   - clone.js: the target unchecked before the clone (`if (…occupied)` never true)     ⇒ (K4a) red
//   - procedure.js: restartState for clone always "clone"                              ⇒ (K3) (K5) red — only since the check of
//     the events: the flags in `clone` skip the effect anyway (second safeguard), the first counter-run was green
//   - procedure.js: checkCloneTarget removed                                           ⇒ (K4b) red (the other source was placed)
//   - procedure.js: the storage gate in the clone source never closed                  ⇒ (K6) red
//   - procedure.js: readRemoteHints removed                                            ⇒ (K7) red
//   - workflows/worktree.js: `lfsInWorktree` removed                                   ⇒ (K1) red (pointer in the graph worktree)
//   - devtools/code-route.js: gitSubmoduleUpdate without `accessesFor`                 ⇒ (K1) red
//   - routes.js: "take over as is" without the clone check                             ⇒ (K2) red
//   - routes.js: the clone special case removed                                        ⇒ (K4b) red
//   - sources.js: the check "nothing in the target of a clone" removed                 ⇒ (P) red
//   - runtime/git-run.js: `lfs pull` without `GIT_LFS_SKIP_SMUDGE=0`                   ⇒ (K1) red
//   - server.js: names `setCloneLogs` (a comment line suffices for the guard)          ⇒ (P) red
//   - clone.js: `error` of CLONE with its own sentence "clone failed: " before it      ⇒ (K2) red
//   - clone.js: `error` of LFS with its own sentence before it                         ⇒ (K3) red (the clients say that already)
//   - procedure.js: restartState without the line "cloneFetched and AFTER_SOURCES"     ⇒ (K8a) (K8b) red (PLACE "source 1 is not
//     ready (lfs)" instead of placed — the guard catches the old state by name)
//   - procedure.js: also the guard in stepPlace removed                                ⇒ (K8a) red ("no procedure lives any more" — the
//     setup ended without the clone), (K8b) red
//   - procedure.js: only the guard removed                                             ⇒ (K8b) red (the not-ready source dropped out silently)
//   - procedure.js: the take-over only without a foreign `process`                     ⇒ (K9) red (the interrupted source stayed)
//   - clone.js: setCloneLogs also for submodules                                       ⇒ (K10a) red (the file:// submodule was fetched)
//   - clone.js: the path check never run                                               ⇒ (K10b) red
//   - clone.js: the fixed caps instead of setSubmoduleCap                              ⇒ (K10c) red
//   - clone.js: SLOT in the submodule update removed                                   ⇒ (K11) red (SUBMODULE instead of SLOT)
//   - clone.js: SLOT in the LFS fetch removed                                          ⇒ (K11) red (LFS instead of SLOT)
//   - procedure.js: storageWaitFree in abortSource removed                             ⇒ (K12) red (`waiting` stayed "storage")
//   - procedure.js: storageWaitFree in the resumption removed                          ⇒ (K12) red (the row from the old state)
//   - clone.js: `error` of SUBMODULE_ACCESS with the old sentence                      ⇒ (K3) red
//   - store/project-setup.js: `fetched` removed                                        ⇒ (K1) (K3) (K9) red
//   - server.js: names `setSubmoduleCap` (a comment line)                              ⇒ (P) red
