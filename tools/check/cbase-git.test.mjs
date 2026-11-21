// The wrapper `cbase-git` (server/backend/cbase-git): VS Code in B gets it as `git.path`; if the effective folder lies in a
// converted project, git goes through `cbase-project <id> --git-access -- git ...` into its project container, otherwise
// `exec git`. server/backend/ is in no glob of the gate, so the guard lives here (like cbase-project.test.mjs). The REAL file
// runs under every available POSIX shell (bash 3.2 on the Mac, dash, bash 5 in the image) with a fake git and a fake
// cbase-project (CBASE_GIT_BIN, CBASE_PROJECT_BIN) that log place and arguments.
//
// Held:
//   - outside any converted project, without a list, with `-C` into nothing: `git` with the same arguments in the same folder;
//   - in the project (also in a subfolder): `cbase-project <id> --git-access -- git ...`, working folder = the effective one;
//     longest prefix wins; `till2` does not lie in `till`; paths with spaces and glob characters count literally;
//   - leading `-C` (several, relative) move the folder and drop in the container; `-c k=v` stays in place; an option AFTER the
//     subcommand is not global; arguments with spaces stay one argument;
//   - the list: CBASE_GIT_PROJECTS, else `$CBASE_DATA_ROOT/data/git-projects`, else `$HOME/cbase/data/git-projects` (the place
//     projectbox/git-assignment.js writes); unreadable or `!incomplete` means exit 128 with a message, no git (empty is not
//     unknown: whoever does not know where it is starts no git in B);
//   - exit codes pass through on both paths;
//   - in the backend image under /usr/bin (not in the project box, not /usr/local/bin), with `dash -n` and `bash -n` in the
//     build; build context (build.sh) and build-context-files.json (the deploy uploads that list).
// Counter-tests (in the test): copies with a prefix comparison without `/`, without `-C`, with an unquoted pattern, without the
// `!incomplete` check are each red in their case.
//
// Access from VS Code (`--git-access`, logic in cbase-project, head "DER ZUGANG AUS VS CODE"), at the end of this file:
//   - only the network commands (push, pull, fetch, ls-remote, remote update; not submodule update, not status) fetch an access;
//     targets as git resolves them (pushRemote, remote.pushDefault, branch.remote, origin; --all/remote update: all);
//   - ONLY the workspace's stored access, fetched from the backend (route with key, imitated here; the real one is bound by
//     server/backend/test/fence.test.js), for exactly the hosts of the targets; NO git in B, B's helpers (VS Code, Dev
//     Containers, Mac) are never asked and never reach the container; a remote or insteadOf to a foreign host gets no access of
//     another host; after a rejection nothing is discarded in B; the value is in no argv (docker gets `-e NAME`), only the empty
//     helper as `-e GIT_CONFIG_VALUE_0=`; in the container it applies only to its host, and no other helper answers there; no
//     key, wrong key, no stored access means without; exit code and message passed through; same path via the wrapper;
//   - B's ~/.gitconfig is read-only in the project container (mountRules/creationArgs), no writable mount carries a global git
//     configuration of B.
//   Counter-tests (in the test): without host binding, value in argv, without clearing the helper list, empty helper as `-e`
//   without `=`, one host too many at the backend: each red.
// Worktrees, at the very end: a worktree in the worktree folder of the runtime folder and a linked worktree outside (shared .git
//   in the project, real git, `core.fsmonitor` = marker) go through cbase-project, a repo of its own beside stays in B;
//   counter-test: without the shared-directory rule and with the earlier list git runs in B and the fsmonitor writes its marker.
//
// Run:  node --test --test-reporter=tap tools/check/cbase-git.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { dockerfileStages } from "./lib/projectbox.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SCRIPT = path.join(REPO, "server/backend/cbase-git");
// Every available POSIX shell; bash (3.2 on the Mac, 5 on Linux) is required, dash runs where it exists (Mac and image).
const SHELLS = ["/bin/bash", "/bin/dash", "/bin/sh"].filter((s) => fs.existsSync(s));

// A setup: fake git, fake cbase-project, project folders and the list.
function build(rows, { list = true } = {}) {
  const location = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-wrapper-")));
  const log = path.join(location, "calls.log");
  const bin = (name) => {
    const f = path.join(location, name);
    fs.writeFileSync(f, `#!/bin/sh\nr="${name}|$(pwd -P)"\nfor a in "$@"; do r="$r|[$a]"; done\nprintf '%s\\n' "$r" >> '${log}'\nexit \${FAKE_EXIT:-0}\n`, { mode: 0o755 });
    return f;
  };
  const folder = (...parts) => { const d = path.join(location, ...parts); fs.mkdirSync(d, { recursive: true }); return d; };
  const listFile = path.join(location, "git-projects");
  const paths = {
    till: folder("ws", "till"), under: folder("ws", "till", "src", "deep"), till2: folder("ws", "till2"),
    inside: folder("ws", "till", "module"), insideDeep: folder("ws", "till", "module", "x"), free: folder("ws", "free"),
    glob: folder("ws", "k a[s]*e"), globUnder: folder("ws", "k a[s]*e", "d"), globNeighbor: folder("ws", "k a[s]xe"),
    stern: folder("ws", "st*"), sternNeighbor: folder("ws", "stall"),
  };
  if (list) fs.writeFileSync(listFile, rows(paths).map((z) => `${z}\n`).join(""));
  return { location, log, git: bin("git"), project: bin("project"), listFile, paths };
}
function run(shell, script, a, cwd, args, env = {}) {
  fs.writeFileSync(a.log, "");
  const r = spawnSync(shell, [script, ...args], {
    cwd, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: a.location, CBASE_GIT_BIN: a.git, CBASE_PROJECT_BIN: a.project, CBASE_GIT_PROJECTS: a.listFile, ...env },
  });
  return { code: r.status, stderr: r.stderr, calls: fs.readFileSync(a.log, "utf8").split("\n").filter(Boolean) };
}
const row = (who, folder, args) => [`${who}|${folder}`, ...args.map((x) => `[${x}]`)].join("|");
const STANDARD = (p) => [`p-till\t${p.till}`, `p-inside\t${p.inside}`, `p-glob\t${p.glob}`, `p-stern\t${p.stern}`];

// The cases: each [name, check(shell, script, setup) -> finding text or null].
const CASES = [
  ["outside means git", (sh, sk, a) => {
    const r = run(sh, sk, a, a.paths.free, ["status", "--porcelain"]);
    return eq(r, 0, [row("git", a.paths.free, ["status", "--porcelain"])]);
  }],
  ["in the project, also in a subfolder: cbase-project <id> -- git, working folder stays", (sh, sk, a) =>
    eq(run(sh, sk, a, a.paths.under, ["status"]), 0, [row("project", a.paths.under, ["p-till", "--git-access", "--", "git", "status"])])
    || eq(run(sh, sk, a, a.paths.till, ["log", "-1"]), 0, [row("project", a.paths.till, ["p-till", "--git-access", "--", "git", "log", "-1"])])],
  ["longest prefix wins", (sh, sk, a) =>
    eq(run(sh, sk, a, a.paths.insideDeep, ["status"]), 0, [row("project", a.paths.insideDeep, ["p-inside", "--git-access", "--", "git", "status"])])],
  ["till2 does not lie in till", (sh, sk, a) =>
    eq(run(sh, sk, a, a.paths.till2, ["status"]), 0, [row("git", a.paths.till2, ["status"])])],
  ["spaces and glob characters count literally", (sh, sk, a) =>
    eq(run(sh, sk, a, a.paths.globUnder, ["status"]), 0, [row("project", a.paths.globUnder, ["p-glob", "--git-access", "--", "git", "status"])])
    || eq(run(sh, sk, a, a.paths.globNeighbor, ["status"]), 0, [row("git", a.paths.globNeighbor, ["status"])])
    || eq(run(sh, sk, a, a.paths.sternNeighbor, ["status"]), 0, [row("git", a.paths.sternNeighbor, ["status"])])],
  ["-C from outside into it: the folder changes, -C drops; several and relative -C", (sh, sk, a) =>
    eq(run(sh, sk, a, a.paths.free, ["-C", a.paths.till, "status", "-s"]), 0, [row("project", a.paths.till, ["p-till", "--git-access", "--", "git", "status", "-s"])])
    || eq(run(sh, sk, a, a.paths.free, ["-C", "..", "-C", "till/module", "diff"]), 0, [row("project", a.paths.inside, ["p-inside", "--git-access", "--", "git", "diff"])])
    || eq(run(sh, sk, a, a.paths.till, ["-C", "../free", "status"]), 0, [row("git", a.paths.till, ["-C", "../free", "status"])])],
  ["-c stays in place, an option after the subcommand is not global, arguments stay whole", (sh, sk, a) =>
    eq(run(sh, sk, a, a.paths.free, ["-c", "core.quotepath=false", "-C", a.paths.till, "commit", "-m", "two words", "-C", "HEAD"]), 0,
      [row("project", a.paths.till, ["p-till", "--git-access", "--", "git", "-c", "core.quotepath=false", "commit", "-m", "two words", "-C", "HEAD"])])
    || eq(run(sh, sk, a, a.paths.till, ["--no-pager", "log", "-C", "x"]), 0, [row("project", a.paths.till, ["p-till", "--git-access", "--", "git", "--no-pager", "log", "-C", "x"])])],
  ["-C into nothing: git decides itself", (sh, sk, a) =>
    eq(run(sh, sk, a, a.paths.till, ["-C", "exists-not", "status"]), 0, [row("git", a.paths.till, ["-C", "exists-not", "status"])])],
  ["exit codes pass through on both paths", (sh, sk, a) =>
    eq(run(sh, sk, a, a.paths.till, ["status"], { FAKE_EXIT: "7" }), 7, [row("project", a.paths.till, ["p-till", "--git-access", "--", "git", "status"])])
    || eq(run(sh, sk, a, a.paths.free, ["status"], { FAKE_EXIT: "5" }), 5, [row("git", a.paths.free, ["status"])])],
];
function eq(r, code, calls) {
  if (r.code === code && JSON.stringify(r.calls) === JSON.stringify(calls)) return null;
  return `Exit ${r.code} (expected ${code}), calls ${JSON.stringify(r.calls)} (expected ${JSON.stringify(calls)}), stderr ${JSON.stringify(r.stderr)}`;
}
function allCheck(script, shell) {
  const a = build(STANDARD);
  try {
    return CASES.map(([name, f]) => [name, f(shell, script, a)]).filter(([, b]) => b);
  } finally {
    fs.rmSync(a.location, { recursive: true, force: true });
  }
}

test("cbase-git: POSIX sh, syntactically clean under every available shell", () => {
  assert.ok(SHELLS.includes("/bin/bash"), "bash is missing");
  const text = fs.readFileSync(SCRIPT, "utf8");
  assert.equal(fs.statSync(SCRIPT).mode & 0o111, 0o111, "not executable");
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.ok(!/\blocal\b|\[\[|\bfunction\b|<<<|\$\{[A-Za-z_]+\[|\$\{[A-Za-z_]+\/\//.test(text.replace(/^#.*$/gm, "")), "bash-ism in a POSIX wrapper");
  for (const sh of SHELLS) {
    const r = spawnSync(sh, ["-n", SCRIPT], { encoding: "utf8" });
    assert.equal(r.status, 0, `${sh} -n: ${r.stderr}`);
  }
  console.log(`# Shells: ${SHELLS.join(", ")}`);
});

test("cbase-git: in a converted project via cbase-project, otherwise git: prefix, -C, -c, glob, exit codes, under every shell", () => {
  for (const sh of SHELLS) {
    const findings = allCheck(SCRIPT, sh);
    assert.deepEqual(findings, [], `${sh}:\n${findings.map(([n, b]) => `${n}: ${b}`).join("\n")}`);
  }
});

test("cbase-git: the list: its location, missing means git, unreadable or incomplete means exit 128 without git", () => {
  for (const sh of SHELLS) {
    // Without a list: WITHOUT the operating marker there is no converted project (the local server, a Mac), so git. WITH the
    // marker the backend ALWAYS writes the list (the lock rows of the copies are in it even without a converted project); if it
    // is missing there it is unknown, not empty: exit 128 without git. The wrapper's marker is CBASE_DIND=1 ALONE: it is set in
    // the whole container (gateway `-e`), CBASE_CONTAINER=1 only in the backend process (headless.js); a shell via `docker exec`
    // or a VS Code attached through Dev Containers has only DIND. CBASE_CONTAINER alone (a container without sysbox, no project
    // container possible) means git. Counter-test: the old condition (CBASE_CONTAINER=1 AND CBASE_DIND=1) turns "only CBASE_DIND" red.
    const without = build(STANDARD, { list: false });
    try {
      assert.equal(eq(run(sh, SCRIPT, without, without.paths.till, ["status"]), 0, [row("git", without.paths.till, ["status"])]), null, sh);
      assert.equal(eq(run(sh, SCRIPT, without, without.paths.free, ["status"], { CBASE_CONTAINER: "1" }), 0, [row("git", without.paths.free, ["status"])]), null, `${sh} only CBASE_CONTAINER`);
      for (const marker of [{ CBASE_DIND: "1" }, { CBASE_CONTAINER: "1", CBASE_DIND: "1" }]) {
        const what = `${sh} ${Object.keys(marker).join("+")}`;
        const including = run(sh, SCRIPT, without, without.paths.free, ["status"], marker);
        assert.equal(including.code, 128, `${what} without list: ${JSON.stringify(including)}`);
        assert.match(including.stderr, /is missing/, what);
        assert.deepEqual(including.calls, [], `${what}: git ran in B`);
      }
    } finally { fs.rmSync(without.location, { recursive: true, force: true }); }
    const a = build(STANDARD);
    try {
      // The location: CBASE_DATA_ROOT, else $HOME/cbase, the same as in the backend.
      for (const [env, root] of [[{ CBASE_GIT_PROJECTS: undefined, CBASE_DATA_ROOT: path.join(a.location, "data") }, path.join(a.location, "data")],
        [{ CBASE_GIT_PROJECTS: undefined }, path.join(a.location, "cbase")]]) {
        fs.mkdirSync(path.join(root, "data"), { recursive: true });
        fs.copyFileSync(a.listFile, path.join(root, "data", "git-projects"));
        const e = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
        const r = spawnSync(sh, [SCRIPT, "status"], { cwd: a.paths.till, encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: a.location, CBASE_GIT_BIN: a.git, CBASE_PROJECT_BIN: a.project, ...e } });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(fs.readFileSync(a.log, "utf8").trim().split("\n").pop(), row("project", a.paths.till, ["p-till", "--git-access", "--", "git", "status"]), `${sh} ${JSON.stringify(e)}`);
        fs.rmSync(path.join(root, "data", "git-projects"));
      }
      // Incomplete: exit 128, message, neither git nor cbase-project, also outside.
      fs.appendFileSync(a.listFile, "!incomplete\n");
      for (const cwd of [a.paths.till, a.paths.free]) {
        const r = run(sh, SCRIPT, a, cwd, ["status"]);
        assert.equal(r.code, 128, `${sh}: ${JSON.stringify(r)}`);
        assert.match(r.stderr, /incomplete/);
        assert.deepEqual(r.calls, []);
      }
      // Unreadable: the same. (root reads every file; there only the case above applies.)
      if (process.getuid?.() !== 0) {
        fs.writeFileSync(a.listFile, STANDARD(a.paths).join("\n"));
        fs.chmodSync(a.listFile, 0o000);
        const r = run(sh, SCRIPT, a, a.paths.free, ["status"]);
        fs.chmodSync(a.listFile, 0o644);
        assert.equal(r.code, 128, `${sh}: ${JSON.stringify(r)}`);
        assert.match(r.stderr, /not readable/);
        assert.deepEqual(r.calls, []);
      }
    } finally { fs.rmSync(a.location, { recursive: true, force: true }); }
  }
});

test("cbase-git: counter-tests: prefix without /, no -C, unquoted pattern, no check for !incomplete are each red", () => {
  const text = fs.readFileSync(SCRIPT, "utf8");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d4-git-wrapper-"));
  try {
    const copy = (name, from, to) => {
      assert.ok(text.includes(from), `counter-test outdated: "${from}" is missing`);
      const f = path.join(dir, name);
      fs.writeFileSync(f, text.split(from).join(to), { mode: 0o755 });
      return f;
    };
    const sh = "/bin/bash";
    const red = (script, fall) => allCheck(script, sh).map(([n]) => n).includes(fall);
    assert.ok(red(copy("prefix", '    case $1/ in\n      "$path"/*)', '    case $1 in\n      "$path"*)'), "till2 does not lie in till"));
    assert.ok(red(copy("without-c", "      -C) [ $# -ge 2 ] || break; d=$(folder_in \"$d\" \"$2\") || return 1; shift 2 ;;\n", ""), "-C from outside into it: the folder changes, -C drops; several and relative -C"));
    assert.ok(red(copy("pattern", '    "$path"/*)', "    $path/*)"), "spaces and glob characters count literally"));
    // !incomplete without the check: the row is then just a broken entry, git runs.
    const without = copy("incomplete", '  if [ "$row" = "!incomplete" ]; then', '  if false; then');
    const a = build((p) => [...STANDARD(p), "!incomplete"]);
    try {
      assert.notEqual(run(sh, without, a, a.paths.free, ["status"]).code, 128);
      assert.equal(run(sh, SCRIPT, a, a.paths.free, ["status"]).code, 128);
    } finally { fs.rmSync(a.location, { recursive: true, force: true }); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cbase-git: in the backend image under /usr/bin with dash -n and bash -n, in the build context and in the deploy, not in the project box", () => {
  const dockerfile = fs.readFileSync(path.join(REPO, "server/backend/Dockerfile"), "utf8");
  const st = dockerfileStages(dockerfile);
  const place = st.flatMap((s) => s.instructions.filter((a) => /cbase-git(\s|$)/.test(a.arg)).map((a) => [s.name, a.op, a.arg]));
  assert.deepEqual(place, [
    ["backend", "COPY", "cbase-git /usr/bin/cbase-git"],
    ["backend", "RUN", "chmod 755 /usr/bin/cbase-git && dash -n /usr/bin/cbase-git && bash -n /usr/bin/cbase-git"],
    // The `git` in the PATH folder /usr/lib/cbase/git-path calls the wrapper, for runs in B without an instance
    // (runtime/inProject.js). The folder is not under /usr/local/bin (no project container).
    ["backend", "RUN", `mkdir -p /usr/lib/cbase/git-path && printf '#!/bin/sh\\nCBASE_GIT_BIN=/usr/bin/git exec /usr/bin/cbase-git "$@"\\n' > /usr/lib/cbase/git-path/git && chmod 755 /usr/lib/cbase/git-path/git && dash -n /usr/lib/cbase/git-path/git && PATH=/usr/lib/cbase/git-path:$PATH git --version`],
  ]);
  assert.ok(!/\/usr\/local\/bin\/cbase-git/.test(dockerfile), "under /usr/local/bin it would lie in every project container");
  assert.match(fs.readFileSync(path.join(REPO, "server/backend/build.sh"), "utf8"), /^cp [^\n]*\bcbase-git\b[^\n]*"\$CTX\/"$/m, "build.sh does not stage cbase-git");
  assert.ok(JSON.parse(fs.readFileSync(path.join(HERE, "../../server/backend/build-context-files.json"), "utf8")).files.includes("cbase-git"), "the build context list does not name cbase-git (the deploy uploads that list)");
  // The same place as in the backend (projectbox/git-assignment.js) and the same path as git.path (vscode-tunnel.js).
  const assignment = fs.readFileSync(path.join(REPO, "server/backend/electron/server/projectbox/git-assignment.js"), "utf8");
  assert.match(assignment, /GIT_PROJECTS_FILE = "git-projects"/);
  assert.match(assignment, /INCOMPLETE = "!incomplete"/);
  assert.match(fs.readFileSync(path.join(REPO, "server/backend/electron/server/vscode-tunnel.js"), "utf8"), /GIT_WRAPPER = "\/usr\/bin\/cbase-git"/);
});

// ── access from VS Code for the network commands (cbase-project --git-access) ─────────────────────────────────────────
// ONLY the workspace's stored git access, fetched from the backend (POST /api/workspaces/<wid>/git-access with the key from
// <data>/git-access.key); no `git credential` in B. Real: cbase-project (as a command), git in the "container" and for target
// resolution, a repo with remotes. Fake: docker (runs `exec` locally: folder = `-w`, environment = a base container environment
// with CBASE_RUNS_IN=container plus ONLY the `-e` names, like docker; instead of `git <network command>` it asks `git credential
// fill` per host from FAKE_TARGETS and ends with FAKE_EXIT/FAKE_STDERR), B's git (a log in front of the real one; it must never
// run) and the API (a converted project, the access route with stored accesses for origin and upstream, none for foreign). B's
// global configuration carries a helper that answers for EVERY host, like VS Code (GIT_ASKPASS), the Dev Containers helper or the
// Mac keychain: it must neither be asked nor reach the container. The project configuration `credential.helper=!marker` must run
// neither in B nor beside the access in the container. System configuration off (GIT_CONFIG_NOSYSTEM), HOME a throwaway folder:
// the test reads no real access. The contract with the REAL route (path, header, file, shape of the answer) is bound at the
// server: server/backend/test/fence.test.js runs this file against the real server.
const PROJECT_SCRIPT = path.join(REPO, "server/backend/cbase-project");
const REAL_GIT = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const SECRET = `access-${crypto.randomBytes(6).toString("hex")}`;
const FOREIGN_SECRET = `vscode-session-${crypto.randomBytes(6).toString("hex")}`;
const KEY = `key-${crypto.randomBytes(8).toString("hex")}`;
const HOSTS = { origin: "git.example.test", upstream: "upstream.example.test", foreign: "foreign.example.test" };

async function accessBuild() {
  const location = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-access-")));
  const home = path.join(location, "home");
  fs.mkdirSync(home);
  const log = (n) => path.join(location, n);
  const script = (name, text) => { const f = path.join(location, name); fs.writeFileSync(f, text, { mode: 0o755 }); return f; };
  fs.writeFileSync(log("foreign-secret"), FOREIGN_SECRET);
  // B's global helper: answers for every host (see above); never asked, never in the container.
  const helper = script("helper-b.sh", `#!/bin/sh\nprintf '%s\\t%s\\t%s\\n' "$1" "\${CBASE_RUNS_IN:-B}" "$(pwd -P)" >> '${log("helper.log")}'\ncat > /dev/null\nif [ "$1" = get ]; then printf 'username=vscode\\npassword=%s\\n' "$(cat '${log("foreign-secret")}')"; fi\nexit 0\n`);
  const marker = script("marker.sh", `#!/bin/sh\nprintf '%s\\t%s\\n' "\${CBASE_RUNS_IN:-B}" "$1" >> '${log("marker.log")}'\ncat > /dev/null\nexit 0\n`);
  fs.writeFileSync(path.join(home, ".gitconfig"), `[credential]\n\thelper = !${helper}\n`);
  const gitB = script("git-b.sh", `#!/bin/sh\nprintf '%s\\t%s\\t%s\\n' "$(pwd -P)" "\${GIT_DIR-without}" "$*" >> '${log("git-b.log")}'\nexec '${REAL_GIT}' "$@"\n`);
  const proj = path.join(location, "ws", "till");
  fs.mkdirSync(proj, { recursive: true });
  const base = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const git = (...a) => {
    const r = spawnSync(REAL_GIT, a, { cwd: proj, env: base, encoding: "utf8" });
    assert.equal(r.status, 0, `${a.join(" ")}: ${r.stderr}`);
  };
  // The project configuration clears the list and sets its own helper, as an attacker in the project would.
  for (const a of [["init", "-q"], ["symbolic-ref", "HEAD", "refs/heads/main"], ["config", "credential.helper", ""], ["config", "--add", "credential.helper", `!${marker}`],
    ["remote", "add", "origin", `https://${HOSTS.origin}/team/till.git`], ["remote", "add", "upstream", `https://${HOSTS.upstream}/k.git`],
    ["remote", "add", "foreign", `https://${HOSTS.foreign}/x.git`], ["remote", "add", "ssh", "git@ssh.example.test:x.git"],
    ["config", "branch.main.pushRemote", "upstream"]]) git(...a);
  const docker = script("docker.mjs", `#!${process.execPath}
import { spawnSync } from "node:child_process";
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log("docker.log"))}, JSON.stringify(args) + "\\n");
if (args[0] !== "exec") process.exit(1);
let i = 1;
let cwd = process.cwd();
const names = [];
for (; i < args.length; i++) {
  const a = args[i];
  if (a === "-i" || a === "-t") continue;
  if (a === "-u") { i++; continue; }
  if (a === "-w") { cwd = args[++i]; continue; }
  if (a === "-e") { names.push(args[++i]); continue; }
  break;
}
const command = args.slice(i + 1);
const env = { PATH: process.env.PATH, HOME: ${JSON.stringify(home)}, CBASE_RUNS_IN: "container", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
for (const n of names) {
  if (n.includes("=")) env[n.slice(0, n.indexOf("="))] = n.slice(n.indexOf("=") + 1);
  else if (process.env[n] !== undefined) env[n] = process.env[n];
}
if (command[0] === "git") {
  const responses = [];
  for (const host of String(process.env.FAKE_TARGETS || "").split(",").filter(Boolean)) {
    const r = spawnSync(${JSON.stringify(REAL_GIT)}, ["credential", "fill"], { cwd, env, encoding: "utf8", input: "protocol=https\\nhost=" + host + "\\n\\n" });
    responses.push({ host, status: r.status, response: r.stdout });
  }
  fs.appendFileSync(${JSON.stringify(log("container.log"))}, JSON.stringify({ command, responses }) + "\\n");
  if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
  process.exit(Number(process.env.FAKE_EXIT || 0));
}
const r = spawnSync(command[0], command.slice(1), { cwd, env, stdio: "inherit" });
process.exit(r.status ?? 1);
`);
  const projects = [{ id: "p-till", name: "Kasse", path: proj, workspaceId: "w1", instance: { identifier: "p-till/main", state: "ready", converted: true, name: "till.cbase", container: "cbase-p-till" } }];
  // The route as projectbox/git-assignment.js: only with the key, only the stored hosts.
  const saved = { [HOSTS.origin]: { username: "user", secret: SECRET }, [HOSTS.upstream]: { username: "user", secret: SECRET } };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const response = (status, body) => { res.writeHead(status, { "Content-Type": "application/json", Connection: "close" }); res.end(JSON.stringify(body)); };
      if (req.method === "GET" && req.url === "/api/projects") return response(200, projects);
      if (req.method === "GET" && req.url === "/api/workspaces") return response(200, []);
      if (req.method === "POST" && req.url === "/api/workspaces/w1/git-access") {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* 400 below */ }
        const withKey = req.headers["x-cbase-git-key"] === KEY;
        fs.appendFileSync(log("api.log"), `${JSON.stringify({ hosts: body.hosts, key: withKey })}\n`);
        if (!withKey) return response(403, { error: "key" });
        if (!Array.isArray(body.hosts)) return response(400, { error: "hosts" });
        if (fs.existsSync(log("empty"))) return response(200, { accesses: {} }); // the case "no stored access"
        return response(200, { accesses: Object.fromEntries(body.hosts.filter((h) => saved[h]).map((h) => [h, saved[h]])) });
      }
      return response(404, { error: "not found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const list = log("git-projects");
  fs.writeFileSync(list, `p-till\t${proj}\n`);
  const key = log("git-access.key");
  fs.writeFileSync(key, `${KEY}\n`, { mode: 0o600 });
  return {
    location, home, proj, log, docker, gitB, list, key, git,
    api: `http://127.0.0.1:${server.address().port}`,
    read: (n) => (fs.existsSync(log(n)) ? fs.readFileSync(log(n), "utf8").split("\n").filter(Boolean) : []),
    clear: () => { for (const n of ["docker.log", "git-b.log", "helper.log", "marker.log", "container.log", "api.log"]) fs.rmSync(log(n), { force: true }); },
    close: async () => {
      await new Promise((r) => { server.closeAllConnections(); server.close(r); });
      fs.rmSync(location, { recursive: true, force: true });
    },
  };
}

// A call (asynchronous: the fake API runs in this process).
function calls(command, args, { cwd, env }) {
  const subprocess = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  subprocess.stdout.on("data", (b) => { out += b; });
  subprocess.stderr.on("data", (b) => { err += b; });
  return new Promise((resolve) => subprocess.once("close", (code) => resolve({ code, out, err })));
}

const AUTH_NOTICE = `fatal: Authentication failed for 'https://${HOSTS.upstream}/k.git/'\n`;
const ALL = `${HOSTS.origin},${HOSTS.upstream},${HOSTS.foreign}`;
const api = (hosts) => [JSON.stringify({ hosts, key: true })];
// The promises, each case a finding or null, as a function so the same check turns red on every copy. In EVERY case `check`
// also verifies: no git in B, B's helper never asked, the project configuration ran nowhere, no value in argv.
const ACCESS_CASES = [
  ["push without remote: pushRemote to upstream; only this host at the backend; value only as environment; only for this host", async (run, a) =>
    check(await run(["push"], { FAKE_TARGETS: ALL }), a, { code: 0, api: api([HOSTS.upstream]), container: { [HOSTS.upstream]: true, [HOSTS.origin]: false, [HOSTS.foreign]: false } })],
  ["fetch without remote means origin (no branch.main.remote)", async (run, a) =>
    check(await run(["fetch"], { FAKE_TARGETS: ALL }), a, { code: 0, api: api([HOSTS.origin]), container: { [HOSTS.origin]: true, [HOSTS.upstream]: false } })],
  ["explicit remote, global options before it, option values are no remote", async (run, a) =>
    check(await run(["-c", "x.y=1", "fetch", "-j", "2", "origin"], { FAKE_TARGETS: ALL }), a, { code: 0, api: api([HOSTS.origin]), container: { [HOSTS.origin]: true, [HOSTS.upstream]: false } })],
  ["fetch --all and remote update: every http(s) remote in ONE question, ssh without; foreign without a stored access gets none", async (run, a) => {
    for (const args of [["fetch", "--all"], ["remote", "update"]]) {
      const b = check(await run(args, { FAKE_TARGETS: ALL }), a, {
        code: 0, api: api([HOSTS.foreign, HOSTS.origin, HOSTS.upstream]), container: { [HOSTS.origin]: true, [HOSTS.upstream]: true, [HOSTS.foreign]: false },
      });
      if (b) return `${args.join(" ")}: ${b}`;
    }
    return null;
  }],
  ["a remote set by the container to a foreign host gets no access of another host (also via insteadOf)", async (run, a) => {
    const b1 = check(await run(["fetch", "foreign"], { FAKE_TARGETS: ALL }), a, { code: 0, api: api([HOSTS.foreign]), dockerCalls: 2, withoutAccess: true, container: { [HOSTS.foreign]: false, [HOSTS.origin]: false } });
    if (b1) return `fetch foreign: ${b1}`;
    // origin points to the foreign host via insteadOf (project configuration): THAT host is asked, origin's access does not go along.
    a.git("config", `url.https://${HOSTS.foreign}/.insteadOf`, `https://${HOSTS.origin}/`);
    try {
      const b2 = check(await run(["push", "origin"], { FAKE_TARGETS: ALL }), a, { code: 0, api: api([HOSTS.foreign]), dockerCalls: 2, withoutAccess: true, container: { [HOSTS.foreign]: false, [HOSTS.origin]: false } });
      return b2 ? `push origin (insteadOf): ${b2}` : null;
    } finally { a.git("config", "--unset", `url.https://${HOSTS.foreign}/.insteadOf`); }
  }],
  ["status and submodule update: no access, no question, one docker call", async (run, a) => {
    for (const args of [["status"], ["submodule", "update", "--remote"]]) {
      const b = check(await run(args, {}), a, { code: 0, api: [], dockerCalls: 1, withoutAccess: true });
      if (b) return `${args.join(" ")}: ${b}`;
    }
    return null;
  }],
  ["authentication rejected: exit and message passed through, nothing discarded in B", async (run, a) =>
    check(await run(["push"], { FAKE_TARGETS: HOSTS.upstream, FAKE_EXIT: "128", FAKE_STDERR: AUTH_NOTICE }), a, {
      code: 128, api: api([HOSTS.upstream]), container: { [HOSTS.upstream]: true }, stderr: /Authentication failed for/,
    })],
  ["other failure: exit passed through", async (run, a) =>
    check(await run(["push"], { FAKE_TARGETS: HOSTS.upstream, FAKE_EXIT: "1", FAKE_STDERR: "error: failed to push some refs\n" }), a, {
      code: 1, api: api([HOSTS.upstream]), container: { [HOSTS.upstream]: true },
    })],
  ["no stored access means without (no -e of the access)", async (run, a) => {
    fs.writeFileSync(path.join(a.location, "empty"), "");
    try {
      return check(await run(["push"], { FAKE_EXIT: "3" }), a, { code: 3, api: api([HOSTS.upstream]), dockerCalls: 2, withoutAccess: true });
    } finally { fs.rmSync(path.join(a.location, "empty"), { force: true }); }
  }],
  ["no key: no question to the backend, without access, with a message", async (run, a) =>
    check(await run(["push"], { CBASE_GIT_KEY: path.join(a.location, "missing"), FAKE_EXIT: "3" }), a, { code: 3, api: [], dockerCalls: 1, withoutAccess: true, stderr: /without git access — key .* not readable/ })],
  ["wrong key: the backend refuses (403), without access, with a message", async (run, a) => {
    fs.writeFileSync(path.join(a.location, "wrong"), "wrong\n");
    return check(await run(["push"], { CBASE_GIT_KEY: path.join(a.location, "wrong"), FAKE_EXIT: "3" }), a, {
      code: 3, api: [JSON.stringify({ hosts: [HOSTS.upstream], key: false })], dockerCalls: 2, withoutAccess: true, stderr: /without git access — backend .*HTTP 403/,
    });
  }],
  ["via the wrapper cbase-git: the same path", async (run, a) =>
    check(await run(["push"], { FAKE_TARGETS: ALL }, { wrapper: true }), a, { code: 0, api: api([HOSTS.upstream]), container: { [HOSTS.upstream]: true, [HOSTS.origin]: false } })],
];

function check(r, a, desired) {
  const f = [];
  if (r.code !== desired.code) f.push(`exit ${r.code} instead of ${desired.code} (${r.err.trim()})`);
  const gitB = a.read("git-b.log");
  if (gitB.length) f.push(`git ran in B: ${JSON.stringify(gitB)}`);
  const helper = a.read("helper.log");
  if (helper.length) f.push(`B's helper (VS Code, Dev Containers, Mac) was asked: ${JSON.stringify(helper)}`);
  const apiLog = a.read("api.log");
  if (desired.api && JSON.stringify(apiLog) !== JSON.stringify(desired.api)) f.push(`backend asked ${JSON.stringify(apiLog)} instead of ${JSON.stringify(desired.api)}`);
  const marker = a.read("marker.log");
  if (marker.some((z) => z.startsWith("B\t"))) f.push(`the project configuration ran in B: ${JSON.stringify(marker)}`);
  const docker = a.read("docker.log");
  const last = docker.length ? JSON.parse(docker[docker.length - 1]) : [];
  const withAccess = last.includes("GIT_CONFIG_COUNT");
  // In the container ONLY the access answers: another helper would get its `store` with the value after success (a
  // `credential.helper=store` would put it into the project container's layer). Without access the project's configuration
  // applies as before, in its own container.
  if (withAccess && marker.some((z) => z.startsWith("container\t"))) f.push(`a project helper ran in the container beside the access: ${JSON.stringify(marker)}`);
  for (const g of [SECRET, FOREIGN_SECRET, KEY]) if (docker.some((z) => z.includes(g))) f.push("a secret is in the arguments of docker");
  let emptyHelper = false;
  for (const z of docker) {
    const args = JSON.parse(z);
    args.forEach((x, i) => {
      if (x !== "-e" || !String(args[i + 1]).includes("=")) return;
      if (args[i + 1] === "GIT_CONFIG_VALUE_0=") emptyHelper = true;
      else f.push(`-e with value: ${args[i + 1].split("=")[0]}=…`);
    });
  }
  if (desired.dockerCalls !== undefined && docker.length !== desired.dockerCalls) f.push(`${docker.length} docker calls instead of ${desired.dockerCalls}`);
  if (desired.withoutAccess && withAccess) f.push("access passed along although there must be none");
  // The empty helper is `-e GIT_CONFIG_VALUE_0=` in argv, not `-e NAME` from an empty value.
  if (withAccess && !emptyHelper) f.push("the empty helper is missing as -e GIT_CONFIG_VALUE_0=");
  const container = a.read("container.log").map((z) => JSON.parse(z));
  const responses = Object.fromEntries((container[0]?.responses || []).map((x) => [x.host, x]));
  for (const [host, desired2] of Object.entries(desired.container || {})) {
    const x = responses[host];
    const has = Boolean(x && x.status === 0 && x.response.includes(`password=${SECRET}`));
    if (has !== desired2) f.push(`in the container for ${host}: ${has ? "access" : "none"} (expected ${desired2 ? "access" : "none"})`);
  }
  if (container.some((c) => c.responses.some((x) => x.status === 0 && x.response.includes("password=") && !x.response.includes(`password=${SECRET}`)))) f.push(`another helper answered in the container: ${JSON.stringify(container)}`);
  if (desired.stderr && !desired.stderr.test(r.err)) f.push(`message missing: ${JSON.stringify(r.err)}`);
  return f.length ? f.join("; ") : null;
}

async function checkAccess(script, { only = null, wrapper = SCRIPT, extra = {} } = {}) {
  const a = await accessBuild();
  try {
    const run = (gitArgs, env, { wrapper: over = false } = {}) => {
      a.clear();
      const e = {
        PATH: process.env.PATH, HOME: a.home, PWD: a.proj, TERM: "dumb", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
        CBASE_DOCKER_BIN: a.docker, CBASE_PROJECT_API: a.api, CBASE_GIT_BIN: a.gitB, CBASE_PROJECT_BIN: script,
        CBASE_GIT_PROJECTS: a.list, CBASE_GIT_KEY: a.key, GIT_DIR: path.join(a.proj, ".git"), ...extra, ...env,
      };
      return over
        ? calls("/bin/sh", [wrapper, ...gitArgs], { cwd: a.proj, env: e })
        : calls(process.execPath, [script, "p-till", "--git-access", "--", "git", ...gitArgs], { cwd: a.proj, env: e });
    };
    const findings = [];
    for (const [name, f] of ACCESS_CASES) {
      if (only && !only.includes(name)) continue;
      const b = await f(run, a);
      if (b) findings.push([name, b]);
    }
    return findings;
  } finally {
    await a.close();
  }
}

test("cbase-project --git-access: which command is a network command, which target gets an access (pure)", async () => {
  const { readArgs, networkCommand, targetOf } = await import(pathToFileURL(PROJECT_SCRIPT).href);
  assert.deepEqual(readArgs(["p", "--git-access", "--", "git", "push"]), { target: "p", command: ["git", "push"], gitAccess: true });
  assert.deepEqual(readArgs(["p", "--", "git", "push"]), { target: "p", command: ["git", "push"] }, "without the option the same shape as before");
  const f = (...b) => networkCommand(["git", ...b]);
  assert.deepEqual(f("push"), { mode: "push", remotes: [] });
  assert.deepEqual(f("-C", "x", "-c", "a=b", "--no-pager", "fetch", "origin"), { mode: "fetch", remotes: ["origin"] });
  assert.deepEqual(f("fetch", "-j", "4", "--depth", "1", "upstream", "main"), { mode: "fetch", remotes: ["upstream"] });
  assert.deepEqual(f("fetch", "--multiple", "a", "b"), { mode: "fetch", remotes: ["a", "b"] });
  assert.deepEqual(f("pull", "--rebase", "-s", "ours", "origin", "main"), { mode: "fetch", remotes: ["origin"] });
  assert.deepEqual(f("push", "--repo=upstream"), { mode: "push", remotes: ["upstream"] });
  assert.deepEqual(f("push", "-o", "ci.skip", "origin", "HEAD"), { mode: "push", remotes: ["origin"] });
  assert.deepEqual(f("ls-remote", "--sort", "v:refname", "origin"), { mode: "fetch", remotes: ["origin"] });
  assert.deepEqual(f("fetch", "--all"), { mode: "all", remotes: [] });
  assert.deepEqual(f("remote", "update", "group"), { mode: "group", remotes: ["group"] });
  for (const no of [["status"], ["submodule", "update", "--remote"], ["remote", "-v"], ["commit", "-m", "push"], ["log", "--", "fetch"]]) {
    assert.equal(f(...no), null, no.join(" "));
  }
  assert.equal(networkCommand(["bash", "-lc", "git push"]), null, "only a direct git call");
  // The target: area of the helper (with port) and host name for the question to the backend (without port).
  assert.deepEqual(targetOf("https://git.example.test/a.git"), { area: "https://git.example.test", host: "git.example.test" });
  assert.deepEqual(targetOf("http://user@git.example.test:8443/a.git"), { area: "http://git.example.test:8443", host: "git.example.test" });
  for (const no of ["git@ssh.example.test:x.git", "ssh://git@h/x", "file:///tmp/x", "https://u:pw@h.test/x", "https://[::1]/x", "broken"]) {
    assert.equal(targetOf(no), null, no);
  }
});

test("cbase-project --git-access: only the workspace's stored access, never B's helper, never in argv, no git in B", async () => {
  const findings = await checkAccess(PROJECT_SCRIPT);
  assert.deepEqual(findings, [], `\n${findings.map(([n, b]) => `${n}: ${b}`).join("\n")}`);
});

test("cbase-project --git-access counter-tests: without host binding, value in argv, without clearing the helper list, empty helper as -e without =: each red", async () => {
  const text = fs.readFileSync(PROJECT_SCRIPT, "utf8");
  fs.mkdirSync(path.join(os.tmpdir(), "d4w2-gitb"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d4w2-gitb", "zugang-"));
  try {
    const copy = (name, from, to) => {
      assert.ok(text.includes(from), `counter-test outdated: "${from}" is missing`);
      const f = path.join(dir, `${name}.mjs`);
      fs.writeFileSync(f, text.split(from).join(to), { mode: 0o755 });
      return f;
    };
    const F1 = ACCESS_CASES[0][0];
    const red = async (script, fall, pattern) => {
      const b = await checkAccess(script, { only: [fall] });
      assert.ok(b.length && pattern.test(b[0][1]), `${path.basename(script)} is not red as expected in "${fall}": ${JSON.stringify(b)}`);
    };
    // Without host binding every remote would get the access of the one.
    await red(copy("host", "helper.push([`credential.${area}.helper`,", 'helper.push(["credential.helper",'), F1, new RegExp(`${HOSTS.origin.replace(/\./g, "\\.")}: access`));
    // The value as `-e NAME=value`: visible in `ps` of B.
    await red(copy("argv", "envNames: access?.names", "envNames: access && [...Object.entries(access.values).map(([k, v]) => `${k}=${v}`), \"GIT_CONFIG_VALUE_0=\"]"), F1, /arguments of docker/);
    // Without clearing the list B's global helper (and the project's) would run in the container before the access.
    await red(copy("reset", 'values.GIT_CONFIG_KEY_0 = "credential.helper";', 'values.GIT_CONFIG_KEY_0 = "cbase.empty";'), F1, /project helper ran in the container|another helper/);
    // The empty helper as `-e GIT_CONFIG_VALUE_0` from the environment depends on whether docker passes an empty value on
    // (unmeasured).
    await red(copy("empty", '"GIT_CONFIG_VALUE_0="], values };', '"GIT_CONFIG_VALUE_0"], values: { ...values, GIT_CONFIG_VALUE_0: "" } };'), F1, /empty helper is missing/);
    // The target over ALL hosts instead of the command's targets: the backend would get hosts the command never addresses.
    await red(copy("all-hosts", "hosts: [...new Set(targets.values())]", "hosts: [...new Set([...targets.values(), \"git.example.test\"])]"), ACCESS_CASES[0][0], /backend asked/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("B's ~/.gitconfig is read-only in the project container, no writable mount carries a global git configuration", async () => {
  const { mountRules, creationArgs } = await import(pathToFileURL(path.join(REPO, "server/backend/electron/server/projectbox/creation.js")).href);
  const home = "/home/agent";
  const rules = mountRules({ home, wsPath: `${home}/ws`, projectPath: `${home}/ws/till`, runtime: `${home}/cbase/data/projects/p1`, entries: () => [] });
  const gc = rules.filter((m) => m.target === `${home}/.gitconfig`);
  assert.deepEqual(gc.map((m) => [m.rule, m.source, m.rw]), [["home-.gitconfig", `${home}/.gitconfig`, false]]);
  const readIn = (p, d) => p === d || p.startsWith(`${d}/`);
  for (const target of [`${home}/.gitconfig`, `${home}/.config/git/config`, `${home}/.git-credentials`, "/etc/gitconfig"]) {
    const rw = rules.filter((m) => m.rw && readIn(target, m.target));
    assert.deepEqual(rw.map((m) => m.rule), [], `${target} would lie under a writable mount`);
  }
  const args = creationArgs({ projectId: "p1", network: { hostname: "till.cbase", ip: "10.249.0.2" }, image: "cbase-projectbox:latest", mounts: gc, hash: "h", cliHome: `${home}/cbase/data/projects/p1/home` });
  assert.ok(args.includes(`type=bind,src=${home}/.gitconfig,dst=${home}/.gitconfig,readonly`), args.join(" "));
});

// ── worktrees (in the runtime folder, and outside with a shared .git in the project) ─────────────────────────────────────
// A REAL code repo in the project with `core.fsmonitor` = marker script (the project container can set it), a worktree in the
// worktree folder of the runtime folder (the list names it, projectbox/git-assignment.js) and one outside every root. In both
// git goes through cbase-project; B's git is REAL here (behind the setup's log): if it ran, the fsmonitor would write its
// marker. A repo of its own outside stays in B. Counter-test: a copy without the shared-directory rule and with the earlier
// list (no worktree row) means git in B and the marker written.
function worktreeBuild() {
  const a = build(STANDARD);
  const env = { PATH: process.env.PATH, HOME: a.location, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const g = (cwd, ...args) => { const r = spawnSync(REAL_GIT, args, { cwd, env, encoding: "utf8" }); assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`); };
  const repo = path.join(a.paths.till, "app");
  fs.mkdirSync(repo);
  g(repo, "init", "-q");
  g(repo, "commit", "-q", "--allow-empty", "-m", "a");
  const wtRoot = path.join(a.location, "cbase", "data", "projects", "p-till", "worktrees");
  const inRun = path.join(wtRoot, "agent-x");
  const outside = path.join(a.location, "ws", "hotfix");
  g(repo, "worktree", "add", "-q", "-b", "wt-run", inRun);
  g(repo, "worktree", "add", "-q", "-b", "wt-outside", outside);
  fs.mkdirSync(path.join(outside, "deep"));
  g(a.paths.free, "init", "-q");
  const marker = path.join(a.location, "fsmonitor.log");
  const fsm = path.join(a.location, "fsmonitor.sh");
  fs.writeFileSync(fsm, `#!/bin/sh\nprintf 'fsmonitor lief in %s\\n' "$(pwd -P)" >> '${marker}'\nexit 1\n`, { mode: 0o755 });
  g(repo, "config", "core.fsmonitor", fsm);
  const gitReal = path.join(a.location, "git-real");
  fs.writeFileSync(gitReal, `#!/bin/sh\nr="git|$(pwd -P)"\nfor x in "$@"; do r="$r|[$x]"; done\nprintf '%s\\n' "$r" >> '${a.log}'\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 });
  const list = (rows) => fs.writeFileSync(a.listFile, rows.map((z) => `${z}\n`).join(""));
  const markers = () => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").split("\n").filter(Boolean) : []);
  return { a, inRun, outside, wtRoot, gitReal, list, markers, env };
}

test("worktree in the runtime folder and outside with a shared .git in the project: cbase-project, never git in B; counter-test red", () => {
  for (const sh of SHELLS) {
    const w = worktreeBuild();
    const { a } = w;
    try {
      w.list([...STANDARD(a.paths), `p-till\t${w.wtRoot}`]);
      const env = { CBASE_GIT_BIN: w.gitReal, HOME: a.location };
      const intoTheProject = (cwd, args) => [row("project", cwd, ["p-till", "--git-access", "--", "git", ...args])];
      // The worktree in the runtime folder is in the list.
      assert.equal(eq(run(sh, SCRIPT, a, w.inRun, ["status"], env), 0, intoTheProject(w.inRun, ["status"])), null, `${sh} in the runtime folder`);
      // Outside every root, also from a subfolder and via -C: the shared .git lies in the project.
      for (const cwd of [w.outside, path.join(w.outside, "deep")]) {
        assert.equal(eq(run(sh, SCRIPT, a, cwd, ["status"], env), 0, intoTheProject(cwd, ["status"])), null, `${sh} ${cwd}`);
      }
      assert.equal(eq(run(sh, SCRIPT, a, a.paths.free, ["-C", w.outside, "status"], env), 0, intoTheProject(w.outside, ["status"])), null, `${sh} -C`);
      // Without the worktree row (an earlier list) the shared-directory rule also catches the runtime folder.
      w.list(STANDARD(a.paths));
      assert.equal(eq(run(sh, SCRIPT, a, w.inRun, ["status"], env), 0, intoTheProject(w.inRun, ["status"])), null, `${sh} list without row`);
      // A repo of its own outside stays in B (real git, own configuration).
      assert.equal(eq(run(sh, SCRIPT, a, a.paths.free, ["status", "--porcelain"], env), 0, [row("git", a.paths.free, ["status", "--porcelain"])]), null, `${sh} free`);
      assert.deepEqual(w.markers(), [], `${sh}: the project's fsmonitor ran in B`);
    } finally { fs.rmSync(a.location, { recursive: true, force: true }); }
  }
  // Counter-test: without the rule and with the earlier list git runs in B, and with it the project's fsmonitor.
  const text = fs.readFileSync(SCRIPT, "utf8");
  const rule = 'b0=$best\nif gd=$(common "$target"); then\n  search "$gd"\n  lock "$gd"\n  [ -n "$b0" ] && best=$b0\nfi\n';
  assert.ok(text.includes(rule), "counter-test outdated: the shared-directory rule is missing");
  const w = worktreeBuild();
  try {
    const without = path.join(w.a.location, "without-common");
    fs.writeFileSync(without, text.replace(rule, ""), { mode: 0o755 });
    w.list(STANDARD(w.a.paths));
    const env = { CBASE_GIT_BIN: w.gitReal, HOME: w.a.location };
    for (const cwd of [w.inRun, w.outside]) {
      const r = run("/bin/bash", without, w.a, cwd, ["status"], env);
      assert.deepEqual(r.calls, [row("git", cwd, ["status"])], `counter-test ${cwd}: ${JSON.stringify(r)}`);
    }
    assert.ok(w.markers().length >= 2 && w.markers().every((z) => z.startsWith("fsmonitor lief in")), `counter-test: the marker is missing: ${JSON.stringify(w.markers())}`);
  } finally { fs.rmSync(w.a.location, { recursive: true, force: true }); }
});

// ── lock rows and the whole runtime folder ───────────────────────────────────────────────────────────────────────────────
// The backend (projectbox/git-assignment.js) lists, per converted project, its WHOLE runtime folder as a root of the main one
// (the project container creates `.git` folders there, `outputs/<chat>`, CLI home, whose hooks and `core.fsmonitor` it writes),
// and with the operating marker ALWAYS the lock rows `!locked\t<path>` for `<data>/copies` and `<data>/copies-backup` (layers
// and backups of the copies: a copy container writes there), plus `<runtime>/copy-worktrees` (worktrees of a copy whose row no
// longer exists). The wrapper: the longest prefix wins; if it is a lock row (of the folder OR its shared git directory) it ends
// with a message and exit 128, before any exec; a live copy (`copy-worktrees/<name>`, deeper than the lock) goes on to its
// container. Real: git (setup, and behind the log as B's git: if it ran in the runtime folder the fsmonitor would write its
// marker). Counter-test (in the test): the list without lock rows means git or cbase-project is called for the copy.
// Sabotage on the wrapper: deleting `lock "$target"` => red; deleting `lock "$gd"` => red (two tests); replacing the
// operating-marker check for a missing list with `false` => red (test "the list").
test("lock rows (copies, backups, copy-worktrees): exit 128 before any exec, also via the shared git directory; the runtime folder goes into the container", () => {
  for (const sh of SHELLS) {
    const a = build(STANDARD);
    try {
      const env0 = { PATH: process.env.PATH, HOME: a.location, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
      const g = (cwd, ...args) => { const r = spawnSync(REAL_GIT, args, { cwd, env: env0, encoding: "utf8" }); assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`); };
      const mk = (...t) => { const d = path.join(...t); fs.mkdirSync(d, { recursive: true }); return d; };
      const data = path.join(a.location, "cbase", "data");
      const copies = mk(data, "copies");
      const backup = mk(data, "copies-backup");
      const runtime = mk(data, "projects", "p-till");
      // (b) the layer of a copy with a complete .git
      const copy = mk(copies, "p-till", "k1", "layer", "p");
      g(copy, "init", "-q");
      g(copy, "commit", "-q", "--allow-empty", "-m", "a");
      const copyDeep = mk(copy, "src");
      // (c) a linked worktree OUTSIDE whose shared git directory lies under copies/
      const wt = path.join(a.location, "ws", "wt-copy");
      g(copy, "worktree", "add", "-q", "-b", "wt", wt);
      const itself = mk(backup, "p-till", "k1");
      const kwOld = mk(runtime, "copy-worktrees", "k1", "agent-a");
      const kwAlive = mk(runtime, "copy-worktrees", "k2", "agent-b");
      // (a) a .git in the runtime folder (outputs/c1), core.fsmonitor = marker
      const c1 = mk(runtime, "outputs", "c1");
      g(c1, "init", "-q");
      const marker = path.join(a.location, "fsmonitor-lz.log");
      const fsm = path.join(a.location, "fsmonitor-lz.sh");
      fs.writeFileSync(fsm, `#!/bin/sh\nprintf 'fsmonitor lief in %s\\n' "$(pwd -P)" >> '${marker}'\nexit 1\n`, { mode: 0o755 });
      g(c1, "config", "core.fsmonitor", fsm);
      const gitReal = path.join(a.location, "git-real-lz");
      fs.writeFileSync(gitReal, `#!/bin/sh\nr="git|$(pwd -P)"\nfor x in "$@"; do r="$r|[$x]"; done\nprintf '%s\\n' "$r" >> '${a.log}'\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 });
      const env = { CBASE_GIT_BIN: gitReal };
      const list = (rows) => fs.writeFileSync(a.listFile, rows.map((z) => `${z}\n`).join(""));
      list([...STANDARD(a.paths), `p-till\t${runtime}`, `!locked\t${copies}`, `!locked\t${backup}`,
        `!locked\t${path.join(runtime, "copy-worktrees")}`, `p-till/k2\t${path.join(runtime, "copy-worktrees", "k2")}`]);
      for (const [place, cwd, args] of [["Copy", copy, ["status"]], ["copy, subfolder", copyDeep, ["status"]], ["worktree outside (commondir under copies/)", wt, ["status"]],
        ["Backup", itself, ["status"]], ["copy-worktrees without row", kwOld, ["status"]], ["-C into the copy", a.paths.free, ["-C", copy, "log"]]]) {
        const r = run(sh, SCRIPT, a, cwd, args, env);
        assert.equal(r.code, 128, `${sh} ${place}: ${JSON.stringify(r)}`);
        assert.match(r.stderr, /locked/, `${sh} ${place}`);
        assert.deepEqual(r.calls, [], `${sh} ${place}: a call despite the lock`);
      }
      // The live copy (deeper than the lock) goes into ITS container; the runtime folder into the project's, never git in B.
      assert.equal(eq(run(sh, SCRIPT, a, kwAlive, ["status"], env), 0, [row("project", kwAlive, ["p-till/k2", "--git-access", "--", "git", "status"])]), null, `${sh} live copy`);
      assert.equal(eq(run(sh, SCRIPT, a, c1, ["status"], env), 0, [row("project", c1, ["p-till", "--git-access", "--", "git", "status"])]), null, `${sh} runtime folder`);
      assert.equal(eq(run(sh, SCRIPT, a, a.paths.free, ["status"], { CBASE_GIT_BIN: a.git }), 0, [row("git", a.paths.free, ["status"])]), null, `${sh} free`);
      assert.ok(!fs.existsSync(marker), `${sh}: the runtime folder's fsmonitor ran in B`);
      // Counter-test: without lock rows the wrapper calls git for the copy (the earlier list).
      list(STANDARD(a.paths));
      const r = run(sh, SCRIPT, a, copy, ["status"], { CBASE_GIT_BIN: a.git });
      assert.deepEqual(r.calls, [row("git", copy, ["status"])], `${sh} counter-test: ${JSON.stringify(r)}`);
    } finally { fs.rmSync(a.location, { recursive: true, force: true }); }
  }
});
