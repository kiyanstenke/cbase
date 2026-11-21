// The LFS helper of the agent shells, server/backend/cbase-lfs-access. server/backend/ lies in no glob of the gate, so the
// guard stands here (like cbase-git.test.mjs). The REAL file runs with `node` against a fake backend endpoint on a free port
// (the route itself has its own guard, server/backend/test/lfs-access.test.js); in the repo as ES module
// (server/backend/package.json), as a copy without package.json like in the image. The helper reads the ancestry from a FAKE
// /proc (`CBASE_LFS_PROC`, one folder per chain with `self` and `<pid>/{stat,cmdline,exe}`), never from the real one: `helper()`
// and `git()` throw when a run with CBASE_LFS_URL and CBASE_LFS_PASS carries no root of its own, else the helper would read this
// machine's processes.
//
// Held (one test per sentence):
//   (1) `store` => no output, no request, even WITH environment and the git-lfs chain (via `fill` as via `reject`); `erase`
//       likewise unless the chain is that of a rejection by git-lfs (via `git credential fill`);
//  (1b) THE REJECTION: `erase` with the chain helper <- sh -c "<helper> erase" <- git credential reject <- git-lfs and user +
//       password in the input => EXACTLY ONE `POST` `{ host, rejected }` with the sha256 (base-16) of `username\npassword` and the
//       pass, never the value, silent for git (no output, no stderr, exit 0) even if the backend refuses or is missing; without
//       the chain (git itself via git-remote-http, a sh with ` get`, `credential fill`), without environment, without https,
//       without user or password => no request;
//   (2) without CBASE_LFS_URL or without CBASE_LFS_PASS => no request, no output, NO stderr, exit 0, even when git-lfs asks (a
//       `git lfs pull` in a terminal, in a service, in VS Code: every git in the project container asks it);
//   (3) `protocol=http` => no request;
//   (4) THE ANCESTRY: the chains exactly as measured in the project container (git 2.39.5, git-lfs 3.3.0, /bin/sh = dash):
//       checkout with smudge, `git pull` (merge), `git clone`, `git lfs pull` (helper <- sh -c <- git credential fill <- git-lfs)
//       and one without the shell in between => EXACTLY ONE request, with `path=group/repo.git` (the form in which git-lfs asks);
//       likewise git itself over https (`git fetch`, `ls-remote`, `push`, the fetch part of `pull`, with and without shell:
//       helper <- sh <- git-remote-https (exe /usr/lib/git-core/git-remote-http) <- git remote-https); and without the
//       environment (terminal, service) git fetch stays silent too; `git credential fill` directly from a shell, a renamed sh
//       called git-lfs (comm fits, exe does not), a replaced binary (" (deleted)"), a git-lfs at another place, a `git credential
//       fill` with a further argument, a shell with another command, a missing link, an exe without link and no /proc at all =>
//       no request; likewise the forgeries and gaps of git's own chain. A comm with ")" does not disturb reading `stat`. A host
//       with `/`, with user or empty => no request (c);
//   (5) git-lfs => EXACTLY ONE `POST` to CBASE_LFS_URL with `{ host, path }` and the pass in `x-cbase-token`, on stdout exactly
//       `username=…`/`password=…`; `host=h:8443` goes to the route with the port; without `path` (git without useHttpPath) only
//       `{ host }` goes out;
//   (6) `{ access: null }`, 403, no backend, no JSON, no field `access`, a value with a line break => no output, EXACTLY ONE line
//       on stderr, without value; exit 0;
//   (7) cap => one line with "cap", no output (the fake endpoint never answers; the knob CBASE_LFS_CAP_MS is set to a few ms;
//       the test waits for the helper's end, never for a duration);
//   (8) never a value in argv, stderr or file: the source starts no process, writes no file and loads nothing (no import/require;
//       `node:fs` only via `process.getBuiltinModule` and from it only `readFileSync`/`readlinkSync`); over ALL runs of this
//       file neither pass nor password stands on stderr, and the helper's working folder stays empty;
//   (9) as a copy without package.json (CommonJS, like under /usr/local/bin in the image) the same behaviour, without a warning
//       on stderr;
//  (10) NEUTRAL next to today's paths, with REAL git and a configuration like /etc/gitconfig of the project box
//       (`credential.helper = <helper>`, `credential.useHttpPath = true`; played via GIT_CONFIG_GLOBAL with GIT_CONFIG_NOSYSTEM=1,
//       see `systemConfiguration`), compared with the same without the helper and with "today" (none): with the access of the
//       admin git (runtime/git-run.js `accessAsEnvironment`, per host) the helper is not asked at all and the login is the same,
//       also with LFS environment, the git-lfs chain and a further helper; without access (clone of a public repo, terminals,
//       services) git asks it, it stays silent, and git ends byte-equal as without it; a further helper behind it answers as
//       without THIS helper; approve/reject reach it, it asks nobody. With LFS environment and the git-lfs chain it answers via
//       real git, with AND without `useHttpPath`; with git's own chain it stays silent. NOT neutral against today is the line
//       `credential.useHttpPath = true` for a STORING helper (own test under (10)): `store`/`cache` no longer find an entry
//       without a path (exit 0 -> 128). Harmless for B's mounted ~/.gitconfig, because ~/.git-credentials is never mounted
//       (projectbox/creation.js `neverMounted`); it hits a storing helper that an agent sets up itself.
//
// COUNTER-TESTS (built in, each a broken version as a copy in a throwaway folder; each must turn its case red):
//   (1) without the switch `action !== "get"` => `store` asks the backend and prints the access;
//  (1b) without the `erase` branch => the rejection never arrives; with the password instead of the fingerprint => the value
//       would stand in the body; without the ancestry in erase => git's own reject reported a rejection;
//   (2) without the condition on the environment => with only CBASE_LFS_URL a request with an empty pass goes out, with neither
//       a line on stderr;
//   (3) without the https comparison => `protocol=http` asks;
//   (4) without the ancestry => `git credential fill` from a shell gets the access; without the git-remote-http branch => git
//       fetch/push are silent again; with argv instead of exe for git-remote-http => a renamed sh gets it; without rule 3' =>
//       git-remote-http directly from a shell gets it; without the jump over the shell (rule 1) => checkout and `git lfs pull`
//       are silent; with the base name instead of the whole exe => the renamed sh gets the access;
//   (6) without the line-break check => a password with `\n` writes an additional protocol line to git;
//  (10) a helper that prints `username=…` without environment => the path without access no longer ends like without it; the
//       storing helper: the same entry WITH a path also works under `useHttpPath` (the missing path is the cause, not the helper).
// Sabotage by hand: (5) with `path: path` removed from the body => red; (7) without `signal: AbortSignal.timeout(cap)` the helper
// never ends and the test stands (caught by the runner's emergency stop `--test-timeout=5000`, not a deadline in the file); (8) with
// a line `process.stderr.write(pass)` => red ("pass on stderr"; (8) needs the runs of the other tests, so the whole file: with a
// name filter alone it reports "too few runs", on purpose: a check over zero runs says nothing). Likewise at
// projectbox/creation.js: without `h(".git-credentials", …)` in `neverMounted` => the test "not neutral …" red.
//
// Run:  node --test --test-reporter=tap tools/check/lfs-helper.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isGitAuthError } from "../../server/backend/electron/server/git.js";
import { accessAsEnvironment } from "../../server/backend/electron/server/runtime/git-run.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const HELPER = path.join(REPO, "server/backend/cbase-lfs-access");
const SOURCE = fs.readFileSync(HELPER, "utf8");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lfs-helper-")));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const PASS = `pass-${crypto.randomBytes(8).toString("hex")}`;
const USER = "lfs-user";
const PASSWORD = `lfs-secret-${crypto.randomBytes(8).toString("hex")}`;
const HOST = "git.example.test";
// The path with which git-lfs 3.3.0 asks for an endpoint on the remote's scheme and host: the same as git itself.
const REPO_PATH = "group/repo.git";
const question = ({ protocol = "https", host = HOST, path: filePath = REPO_PATH } = {}) =>
  `protocol=${protocol}\nhost=${host}\n${filePath === null ? "" : `path=${filePath}\n`}\n`;

// Everything a run wrote to stderr; (8) checks at the end that no value stands anywhere.
const ALL_STDERR = [];

// ── The fake /proc ───────────────────────────────────────────────────────────────────────────────────────────────────

// The links as measured (comm, exe, cmdline). The helper itself stands first; only its parent counts. `HELPER_IN_IMAGE` is the
// path from /etc/gitconfig of the project box, as it stands in the shell's command line.
const HELPER_IN_IMAGE = "/usr/local/bin/cbase-lfs-access";
const G = {
  helper: { comm: "node", exe: "/usr/local/bin/node", argv: ["/usr/local/bin/node", HELPER_IN_IMAGE, "get"] },
  sh: (action = "get") => ({ comm: "sh", exe: "/usr/bin/dash", argv: ["/bin/sh", "-c", `${HELPER_IN_IMAGE} ${action}`, `${HELPER_IN_IMAGE} ${action}`] }),
  fill: (exe = "/usr/lib/git-core/git", comm = "git") => ({ comm, exe, argv: ["git", "credential", "fill"] }),
  lfsFilter: { comm: "git-lfs", exe: "/usr/bin/git-lfs", argv: ["git-lfs", "filter-process"] },
  shFilter: { comm: "sh", exe: "/usr/bin/dash", argv: ["/bin/sh", "-c", "git-lfs filter-process", "git-lfs filter-process"] },
  lfsPull: { comm: "git-lfs", exe: "/usr/bin/git-lfs", argv: ["/usr/bin/git-lfs", "pull"] },
  // git itself over https, measured: argv[0] git-remote-https, exe the target of the link git-remote-http.
  remoteHttp: (kind, name = "git-remote-https") => ({ comm: "git-remote-http", exe: "/usr/lib/git-core/git-remote-http", argv: [`/usr/lib/git-core/${name}`, kind, `https://${HOST}/${REPO_PATH}`] }),
  remoteHttpGit: (kind, command = "remote-https") => ({ comm: "git", exe: "/usr/lib/git-core/git", argv: ["/usr/lib/git-core/git", command, kind, `https://${HOST}/${REPO_PATH}`] }),
  git: (...argv) => ({ comm: "git", exe: "/usr/bin/git", argv: ["git", ...argv] }),
  gitCore: (...argv) => ({ comm: "git", exe: "/usr/lib/git-core/git", argv: ["/usr/lib/git-core/git", ...argv] }),
  shScript: { comm: "sh", exe: "/usr/bin/dash", argv: ["sh", "/tmp/t6-measurement/cases.sh"] },
};
// git-lfs asks: the measured chains, at the top the helper's link, at the bottom what started the command.
const LFS_CHAINS = {
  "checkout with smudge": [G.helper, G.sh(), G.fill(), G.lfsFilter, G.shFilter, G.git("checkout", "--", "large.bin"), G.shScript],
  "git pull (merge)": [G.helper, G.sh(), G.fill(), G.lfsFilter, G.shFilter, G.gitCore("merge", "-q", "FETCH_HEAD"), G.git("pull", "-q"), G.shScript],
  "git clone": [G.helper, G.sh(), G.fill(), G.lfsFilter, G.shFilter, G.git("clone", "-q", `https://${HOST}/${REPO_PATH}`, "b3"), G.shScript],
  "git lfs pull": [G.helper, G.sh(), G.fill(), G.lfsPull, G.git("lfs", "pull"), G.shScript],
  // A shell that replaces itself with its last command via exec (bash -c) is missing in the chain; rule 1 skips only what is there.
  "without shell in between": [G.helper, G.fill(), G.lfsPull, G.git("lfs", "pull")],
  // `stat` is read after the LAST ")": a comm with a parenthesis and a space shifts nothing.
  "comm with \") S 1 (\"": [G.helper, G.sh(), G.fill("/usr/lib/git-core/git", "git) S 1 (x"), G.lfsPull, G.git("lfs", "pull")],
};
// git itself over https: the chains as measured in a project container (ls-remote, fetch --dry-run, push --dry-run with a
// measuring helper, each the same form).
const GIT_HTTP_CHAINS = {
  "git fetch (git itself, via git-remote-https)": [G.helper, G.sh(), G.remoteHttp("origin"), G.remoteHttpGit("origin"), G.git("fetch", "origin"), G.shScript],
  "git ls-remote": [G.helper, G.sh(), G.remoteHttp(`https://${HOST}/${REPO_PATH}`), G.remoteHttpGit(`https://${HOST}/${REPO_PATH}`), G.git("ls-remote", `https://${HOST}/${REPO_PATH}`)],
  "git push": [G.helper, G.sh(), G.remoteHttp("origin"), G.remoteHttpGit("origin"), G.git("push", "origin", "HEAD")],
  "git pull (fetch part)": [G.helper, G.sh(), G.remoteHttp("origin"), G.remoteHttpGit("origin"), G.gitCore("fetch", "--update-head-ok"), G.git("pull")],
  "git-remote-http under its own name (remote-http)": [G.helper, G.sh(), G.remoteHttp("origin", "git-remote-http"), G.remoteHttpGit("origin", "remote-http"), G.git("fetch")],
  "without shell in between": [G.helper, G.remoteHttp("origin"), G.remoteHttpGit("origin"), G.git("fetch")],
};
// Neither git-lfs nor git over https.
const NO_CHAINS = {
  "git credential fill directly from a shell": [G.helper, G.sh(), G.fill("/usr/bin/git"), { comm: "sh", exe: "/usr/bin/dash", argv: ["sh"] }],
  "renamed sh called git-lfs (comm fits, exe does not)": [G.helper, G.sh(), G.fill("/usr/bin/git"),
    { comm: "git-lfs", exe: "/tmp/t6-measurement/git-lfs", argv: ["../git-lfs", "-c", "git credential fill < /tmp/t6-measurement/anfrage.txt > /dev/null 2>&1"] }],
  "replaced binary (deleted)": [G.helper, G.sh(), G.fill(), { ...G.lfsPull, exe: "/usr/bin/git-lfs (deleted)" }],
  "git-lfs at another place": [G.helper, G.sh(), G.fill(), { ...G.lfsPull, exe: "/usr/local/bin/git-lfs" }],
  "git credential fill with a further argument": [G.helper, G.sh(), { ...G.fill(), argv: ["git", "credential", "fill", "x"] }, G.lfsPull],
  "git credential approve": [G.helper, G.sh(), { ...G.fill(), argv: ["git", "credential", "approve"] }, G.lfsFilter],
  "an exe called gitx": [G.helper, G.sh(), G.fill("/usr/bin/gitx"), G.lfsPull],
  "shell with another command": [G.helper, { comm: "sh", exe: "/usr/bin/dash", argv: ["/bin/sh", "-c", "something else", "x"] }, G.fill(), G.lfsPull],
  "missing link above git credential fill": [G.helper, G.sh(), G.fill(), null],
  "git-lfs without readable exe": [G.helper, G.sh(), G.fill(), { ...G.lfsPull, exe: null }],
  // Forgeries and gaps of git's own chain.
  "git-remote-http at another place (/tmp)": [G.helper, G.sh(), { ...G.remoteHttp("origin"), exe: "/tmp/git-remote-http" }, G.remoteHttpGit("origin"), G.git("fetch")],
  "renamed sh called git-remote-https (comm/argv fit, exe does not)": [G.helper, G.sh(), { ...G.remoteHttp("origin"), exe: "/usr/bin/dash" }, G.remoteHttpGit("origin"), G.git("fetch")],
  "git-remote-http replaced (deleted)": [G.helper, G.sh(), { ...G.remoteHttp("origin"), exe: "/usr/lib/git-core/git-remote-http (deleted)" }, G.remoteHttpGit("origin")],
  "git-remote-http directly from a shell": [G.helper, G.sh(), G.remoteHttp("origin"), { comm: "sh", exe: "/usr/bin/dash", argv: ["sh"] }],
  "git-remote-http under git with another command": [G.helper, G.sh(), G.remoteHttp("origin"), G.git("remote-ftp", "origin")],
  "git-remote-http without parent": [G.helper, G.sh(), G.remoteHttp("origin"), null],
  "git-remote-http without readable exe": [G.helper, G.sh(), { ...G.remoteHttp("origin"), exe: null }, G.remoteHttpGit("origin")],
  "another remote helper (git-remote-ftp)": [G.helper, G.sh(), { ...G.remoteHttp("origin"), exe: "/usr/lib/git-core/git-remote-ftp" }, G.remoteHttpGit("origin", "remote-ftp")],
  "a service (node) calls the helper": [G.helper, G.sh(), { comm: "node", exe: "/usr/local/bin/node", argv: ["node", "service.js"] }],
};

// A fake /proc: per link `<pid>/stat` (pid, comm, state, ppid, …), `<pid>/cmdline` (NUL-separated) and `<pid>/exe` (a link,
// without target, only readlink is read), plus `self` -> the first link. A `null` link has no folder (gone).
let buildSeq = 0;
function procTree(segments) {
  const root = path.join(ROOT, `proc-${++buildSeq}`);
  fs.mkdirSync(root);
  segments.forEach((g, i) => {
    if (!g) return;
    const pid = 4000 + i;
    const ppid = i + 1 < segments.length ? 4000 + i + 1 : 1;
    const location = path.join(root, String(pid));
    fs.mkdirSync(location);
    fs.writeFileSync(path.join(location, "stat"), `${pid} (${g.comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560 120 0 0 0 0 0 0 0 20 0 1 0 1234\n`);
    fs.writeFileSync(path.join(location, "cmdline"), `${g.argv.join("\0")}\0`);
    if (g.exe) fs.symlinkSync(g.exe, path.join(location, "exe"));
  });
  fs.symlinkSync("4000", path.join(root, "self"));
  return root;
}
const CHAIN_LFS = procTree(LFS_CHAINS["checkout with smudge"]);
const CHAIN_GIT = procTree(GIT_HTTP_CHAINS["git fetch (git itself, via git-remote-https)"]);
// Neither git-lfs nor git over https: `git credential fill` directly from a shell (a script that wants the access).
const CHAIN_FOREIGN = procTree(NO_CHAINS["git credential fill directly from a shell"]);
const WITHOUT_PROC = fs.mkdtempSync(path.join(ROOT, "no-proc-")); // an empty folder: no `self`

// A run that would reach the ancestry (both environment names) reads only a fake /proc.
function neverTheRealProc(env) {
  if (env.CBASE_LFS_URL && env.CBASE_LFS_PASS) {
    assert.ok(typeof env.CBASE_LFS_PROC === "string" && env.CBASE_LFS_PROC.startsWith(ROOT),
      "a run with LFS environment without its own /proc root: the helper would read this machine's processes");
  }
}

// ── The fake endpoint ────────────────────────────────────────────────────────────────────────────────────────────────

// `response`: { status, body } (body as an object => JSON, as text => verbatim) or "never": then the request stays open (a gate
// nobody opens) until `close` cuts the connections.
async function endpoint(response = { status: 200, body: { access: { username: USER, password: PASSWORD } } }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (response === "never") return;
      res.writeHead(response.status ?? 200, { "content-type": "application/json" });
      res.end(typeof response.body === "string" ? response.body : JSON.stringify(response.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/projects/p-one/lfs-access`;
  return {
    url, requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
// A free port on which nobody listens ("no backend").
async function deadPort() {
  const s = http.createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

// ── The helper ───────────────────────────────────────────────────────────────────────────────────────────────────────

// One run: `node <file> <action>` with the input on stdin and ONLY the given environment (plus PATH), nothing from this
// process's environment. Waits for the child's end (event, no duration). `cwd` is an empty folder of its own (8).
let runSeq = 0;
function helper(file, action, input, env = {}) {
  neverTheRealProc(env);
  const cwd = path.join(ROOT, `lauf-${++runSeq}`);
  fs.mkdirSync(cwd);
  return new Promise((resolve, reject) => {
    const subprocess = spawn(process.execPath, [file, action], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let error = "";
    subprocess.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
    subprocess.stderr.setEncoding("utf8").on("data", (d) => { error += d; });
    subprocess.stdin.on("error", () => {});
    subprocess.stdin.end(input);
    subprocess.on("error", reject);
    subprocess.on("close", (code) => {
      ALL_STDERR.push(error);
      resolve({ code, stdout, error, rows: error.split("\n").filter(Boolean), files: fs.readdirSync(cwd) });
    });
  });
}
// The environment of an agent shell; the /proc root is the git-lfs chain unless said otherwise.
const environment = (url, extra = {}) => ({ CBASE_LFS_URL: url, CBASE_LFS_PASS: PASS, CBASE_LFS_PROC: CHAIN_LFS, ...extra });

// A broken version as a copy: `alt` must occur exactly once (else the counter-test does not bite).
function broken(name, old, fresh) {
  assert.equal(SOURCE.split(old).length, 2, `"${old.slice(0, 60)}" does not stand exactly once in the helper — the counter-test does not bite`);
  const file = path.join(ROOT, name);
  fs.writeFileSync(file, SOURCE.replace(old, fresh), { mode: 0o755 });
  return file;
}

// A run that must be SILENT: exit 0, no output, no stderr, no request. Throws (AssertionError) if not.
async function mustStillBe(file, action, input, env, purpose) {
  const ep = await endpoint();
  try {
    const r = await helper(file, action, input, typeof env === "function" ? env(ep.url) : env);
    assert.equal(r.code, 0, `${purpose}: exit`);
    assert.equal(r.stdout, "", `${purpose}: output to git`);
    assert.equal(r.error, "", `${purpose}: stderr`);
    assert.equal(ep.requests.length, 0, `${purpose}: request to the backend`);
  } finally { await ep.close(); }
}
// A run that must make NO request (stderr does not matter there).
async function asksNot(file, input, purpose, extra = {}) {
  const ep = await endpoint();
  try {
    const r = await helper(file, "get", input, environment(ep.url, extra));
    assert.equal(ep.requests.length, 0, `${purpose}: request to the backend`);
    assert.equal(r.stdout, "", `${purpose}: output to git`);
    assert.equal(r.code, 0, `${purpose}: exit`);
  } finally { await ep.close(); }
}
// A run that makes EXACTLY ONE request and prints the access.
async function asksOnce(file, input, purpose, extra = {}) {
  const ep = await endpoint();
  try {
    const r = await helper(file, "get", input, environment(ep.url, extra));
    assert.equal(ep.requests.length, 1, `${purpose}: not exactly one request (${r.error})`);
    assert.equal(r.stdout, `username=${USER}\npassword=${PASSWORD}\n`, `${purpose}: output to git`);
    assert.equal(r.code, 0, `${purpose}: exit`);
    return { r, request: ep.requests[0] };
  } finally { await ep.close(); }
}

// ── (1) store/erase ──────────────────────────────────────────────────────────────────────────────────────────────────

// The chain of a rejection by git-lfs: like that of a get, with `reject` instead of `fill`.
const reject = () => ({ ...G.fill(), argv: ["git", "credential", "reject"] });
const REJECTION_CHAIN = [G.helper, G.sh("erase"), reject(), G.lfsFilter, G.shFilter, G.git("lfs", "pull")];
const WITH_VALUE = question().replace(/\n\n$/, `\nusername=${USER}\npassword=${PASSWORD}\n\n`);

async function checkStoreErase(file) {
  for (const action of ["store", "erase"]) {
    await mustStillBe(file, action, WITH_VALUE, (url) => environment(url, { CBASE_LFS_PROC: procTree([G.helper, G.sh(action), G.fill(), G.lfsFilter]) }), `${action} with environment and git-lfs chain`);
  }
  await mustStillBe(file, "store", WITH_VALUE, (url) => environment(url, { CBASE_LFS_PROC: procTree([G.helper, G.sh("store"), reject(), G.lfsFilter]) }), "store with the chain via reject");
}
test("(1) store/erase => no output, no request, even with environment and the git-lfs chain (erase via fill, store also via reject); counter-test: without the switch store asks", async () => {
  await checkStoreErase(HELPER);
  const withoutSwitch = broken("without-switch", 'if (action !== "get") return end();', "");
  await assert.rejects(checkStoreErase(withoutSwitch), assert.AssertionError);
});

// ── (1b) erase reports the rejection ─────────────────────────────────────────────────────────────────────────────────

const fingerprint = (n, p) => crypto.createHash("sha256").update(`${n}\n${p}`).digest("hex");
async function checkRejection(file) {
  for (const [purpose, response] of [["route answers", { status: 200, body: { ok: true } }], ["route refuses", { status: 403, body: { error: "fence" } }], ["route broken", { status: 500, body: "<html>" }]]) {
    const ep = await endpoint(response);
    try {
      const r = await helper(file, "erase", WITH_VALUE, environment(ep.url, { CBASE_LFS_PROC: procTree(REJECTION_CHAIN) }));
      assert.deepEqual({ code: r.code, stdout: r.stdout, error: r.error }, { code: 0, stdout: "", error: "" }, `${purpose}: erase is not silent for git`);
      assert.equal(ep.requests.length, 1, `${purpose}: the rejection did not arrive (exactly once)`);
      const [a] = ep.requests;
      assert.equal(a.method, "POST");
      assert.equal(a.url, "/api/projects/p-one/lfs-access");
      assert.equal(a.headers["x-cbase-token"], PASS);
      assert.deepEqual(JSON.parse(a.body), { host: HOST, rejected: fingerprint(USER, PASSWORD) }, `${purpose}: body`);
      assert.ok(!a.body.includes(PASSWORD) && !a.body.includes(USER), `${purpose}: a value in the body`);
    } finally { await ep.close(); }
  }
  // No backend: silent.
  const port = await deadPort();
  const tot = await helper(file, "erase", WITH_VALUE, environment(`http://127.0.0.1:${port}/api/projects/p-one/lfs-access`, { CBASE_LFS_PROC: procTree(REJECTION_CHAIN) }));
  assert.deepEqual({ code: tot.code, stdout: tot.stdout, error: tot.error }, { code: 0, stdout: "", error: "" }, "no backend: erase is not silent for git");
}
async function checkNoRejection(file) {
  const withChain = (chain) => (url) => environment(url, { CBASE_LFS_PROC: procTree(chain) });
  for (const [purpose, input, env] of [
    ["git itself (reject via git-remote-http)", WITH_VALUE, withChain([G.helper, G.sh("erase"), G.remoteHttp("origin"), G.remoteHttpGit("origin"), G.git("push")])],
    ["git credential reject from a shell", WITH_VALUE, withChain([G.helper, G.sh("erase"), { ...reject(), exe: "/usr/bin/git" }, { comm: "sh", exe: "/usr/bin/dash", argv: ["sh"] }])],
    ["a sh that says \"get\"", WITH_VALUE, withChain([G.helper, G.sh("get"), reject(), G.lfsFilter])],
    ["via credential fill", WITH_VALUE, withChain([G.helper, G.sh("erase"), G.fill(), G.lfsFilter])],
    ["without environment", WITH_VALUE, () => ({ CBASE_LFS_PROC: procTree(REJECTION_CHAIN) })],
    ["http", question({ protocol: "http" }).replace(/\n\n$/, `\nusername=${USER}\npassword=${PASSWORD}\n\n`), withChain(REJECTION_CHAIN)],
    ["without user", question().replace(/\n\n$/, `\npassword=${PASSWORD}\n\n`), withChain(REJECTION_CHAIN)],
    ["without password", question().replace(/\n\n$/, `\nusername=${USER}\n\n`), withChain(REJECTION_CHAIN)],
  ]) await mustStillBe(file, "erase", input, env, purpose);
}
test("(1b) erase with the chain git credential reject <- git-lfs => exactly one POST { host, rejected: sha256 } with the pass, never the value, silent for git; none without the chain, environment, https, user or password; counter-tests built in", async () => {
  await checkRejection(HELPER);
  await checkNoRejection(HELPER);
  const withoutBranch = broken("without-rejection", 'if (action === "erase") return rejection(input);', "");
  await assert.rejects(checkRejection(withoutBranch), assert.AssertionError);
  const withValue = broken("rejection-with-value", "rejected: await fingerprint(user, password)", "rejected: password");
  await assert.rejects(checkRejection(withValue), assert.AssertionError);
  const withoutAncestry = broken("rejection-without-ancestry", 'if (!ofGitLfs("erase", "reject")) return end();', "");
  await assert.rejects(checkNoRejection(withoutAncestry), assert.AssertionError);
});

// ── (2) without environment ──────────────────────────────────────────────────────────────────────────────────────────

// Every case with the git-lfs chain: a `git lfs pull` in a terminal or service asks the helper exactly like this, only without
// the environment of the agent starts.
async function checkWithoutEnvironment(file) {
  const p = { CBASE_LFS_PROC: CHAIN_LFS };
  for (const [purpose, env] of [
    ["neither", () => ({ ...p })],
    ["only CBASE_LFS_URL", (url) => ({ ...p, CBASE_LFS_URL: url })],
    ["only CBASE_LFS_PASS", () => ({ ...p, CBASE_LFS_PASS: PASS })],
    ["both empty", () => ({ ...p, CBASE_LFS_URL: "", CBASE_LFS_PASS: "" })],
  ]) await mustStillBe(file, "get", question(), env, purpose);
}
test("(2) without CBASE_LFS_URL or CBASE_LFS_PASS => silent, even when git-lfs asks: no request, no output, no stderr, exit 0; counter-test: without the condition terminals and services would ask", async () => {
  await checkWithoutEnvironment(HELPER);
  const withoutCondition = broken("without-environment", "if (!url || !pass) return end(); // (b)", "// (b)");
  await assert.rejects(checkWithoutEnvironment(withoutCondition), assert.AssertionError);
});

// ── (3) https only ───────────────────────────────────────────────────────────────────────────────────────────────────

test("(3) protocol=http (and without protocol) => no request; counter-test: without the comparison http asks", async () => {
  await asksNot(HELPER, question({ protocol: "http" }), "http");
  await asksNot(HELPER, `host=${HOST}\npath=${REPO_PATH}\n\n`, "without protocol");
  const withoutHttps = broken("without-https", 'f.get("protocol") !== "https" || ', "");
  await assert.rejects(asksNot(withoutHttps, question({ protocol: "http" }), "http"), assert.AssertionError);
});

// ── (4) the ancestry ─────────────────────────────────────────────────────────────────────────────────────────────────

async function checkLfsChains(file) {
  for (const [purpose, chain] of Object.entries(LFS_CHAINS)) {
    const { request } = await asksOnce(file, question(), purpose, { CBASE_LFS_PROC: procTree(chain) });
    assert.deepEqual(JSON.parse(request.body), { host: HOST, path: REPO_PATH }, `${purpose}: body`);
  }
}
async function checkGitHttpChains(file) {
  for (const [purpose, chain] of Object.entries(GIT_HTTP_CHAINS)) {
    const { request } = await asksOnce(file, question(), purpose, { CBASE_LFS_PROC: procTree(chain) });
    assert.deepEqual(JSON.parse(request.body), { host: HOST, path: REPO_PATH }, `${purpose}: body`);
    assert.equal(request.headers["x-cbase-token"], PASS, `${purpose}: Pass`);
  }
}
async function checkNoLfsChains(file) {
  for (const [purpose, chain] of Object.entries(NO_CHAINS)) await asksNot(file, question(), purpose, { CBASE_LFS_PROC: procTree(chain) });
  await asksNot(file, question(), "no /proc at all", { CBASE_LFS_PROC: WITHOUT_PROC });
}
test("(4) the ancestry as measured: git-lfs via git credential fill (checkout, pull, clone, git lfs pull, without shell) => exactly one request with path=group/repo.git; git itself over https (fetch, ls-remote, push, pull) likewise; the shell, a renamed sh, wrong exe, missing links => none", async () => {
  await checkLfsChains(HELPER);
  await checkGitHttpChains(HELPER);
  await checkNoLfsChains(HELPER);
  // (b) stays before the ancestry: a terminal or service without the names of the agent starts stays silent for git fetch too.
  await mustStillBe(HELPER, "get", question(), () => ({ CBASE_LFS_PROC: CHAIN_GIT }), "git fetch in a terminal (without environment)");
  await asksNot(HELPER, question({ protocol: "http" }), "git fetch over http", { CBASE_LFS_PROC: CHAIN_GIT });
  // (c) stays before the ancestry: a host without the pattern does not ask even with the git-lfs chain.
  for (const [purpose, host] of [["host with /", `${HOST}/x`], ["host with user", `u@${HOST}`], ["empty host", ""]]) await asksNot(HELPER, question({ host }), purpose);
});
test("(4) counter-tests of the ancestry: without it git credential fill from the shell gets the access; without the git-remote-http branch git fetch is silent; without the jump over the shell git-lfs is silent; with the base name instead of the whole exe the renamed sh gets it; without 3' git-remote-http from a shell gets it", async () => {
  const withoutAncestry = broken("without-ancestry", "  if (!ofGitLfs(action) && !ofGitRemoteHttp(action)) return end(); // (d)", "  // (d)");
  await assert.rejects(asksNot(withoutAncestry, question(), "git credential fill from the shell", { CBASE_LFS_PROC: CHAIN_FOREIGN }), assert.AssertionError);
  const withoutGitHttp = broken("without-git-http", "if (!ofGitLfs(action) && !ofGitRemoteHttp(action))", "if (!ofGitLfs(action))");
  await assert.rejects(checkGitHttpChains(withoutGitHttp), assert.AssertionError);
  const remoteBase = broken("remote-base-name", "if (!p2 || p2.exe !== GIT_REMOTE_HTTP_EXE) return false;", 'if (!p2 || !String(p2.argv[0] || "").includes("git-remote-http")) return false;');
  await assert.rejects(asksNot(remoteBase, question(), "renamed sh called git-remote-https", { CBASE_LFS_PROC: procTree(NO_CHAINS["renamed sh called git-remote-https (comm/argv fit, exe does not)"]) }), assert.AssertionError);
  const withoutP3 = broken("without-p3", "return Boolean(p3 && baseName(p3.exe) === \"git\" && REMOTE_HTTP_COMMANDS.has(p3.argv[1]));", "return true;");
  await assert.rejects(asksNot(withoutP3, question(), "git-remote-http directly from a shell", { CBASE_LFS_PROC: procTree(NO_CHAINS["git-remote-http directly from a shell"]) }), assert.AssertionError);
  const withoutJump = broken("without-jump", "if (SHELLS.has(baseName(p2.exe)) && ", "if (false && ");
  await assert.rejects(checkLfsChains(withoutJump), assert.AssertionError);
  const withBaseName = broken("with-base-name", "return Boolean(p3 && p3.exe === GIT_LFS_EXE);", 'return Boolean(p3 && (p3.exe === GIT_LFS_EXE || (p3.exe || "").endsWith("/git-lfs")));');
  await assert.rejects(asksNot(withBaseName, question(), "renamed sh", { CBASE_LFS_PROC: procTree(NO_CHAINS["renamed sh called git-lfs (comm fits, exe does not)"]) }), assert.AssertionError);
});

// ── (5) the request ──────────────────────────────────────────────────────────────────────────────────────────────────

test("(5) git-lfs => exactly one POST with { host, path } and the pass in x-cbase-token, output username/password; host=h:8443 with port; without path only { host }", async () => {
  for (const [host, filePath, body] of [[HOST, REPO_PATH, { host: HOST, path: REPO_PATH }], ["h:8443", REPO_PATH, { host: "h:8443", path: REPO_PATH }], [HOST, null, { host: HOST }]]) {
    const ep = await endpoint();
    try {
      const r = await helper(HELPER, "get", question({ host, path: filePath }), environment(ep.url));
      assert.equal(r.code, 0);
      assert.equal(r.error, "", `${host}: stderr`);
      assert.equal(r.stdout, `username=${USER}\npassword=${PASSWORD}\n`, `${host}: output`);
      assert.equal(ep.requests.length, 1, `${host}: not exactly one request`);
      const [a] = ep.requests;
      assert.equal(a.method, "POST");
      assert.equal(a.url, "/api/projects/p-one/lfs-access");
      assert.equal(a.headers["x-cbase-token"], PASS, `${host}: Pass`);
      assert.match(a.headers["content-type"] || "", /^application\/json/);
      assert.deepEqual(JSON.parse(a.body), body, `${host}: body`);
      assert.ok(!a.url.includes(PASS), "the pass stands in the URL");
    } finally { await ep.close(); }
  }
});

// ── (6) no answer with access ────────────────────────────────────────────────────────────────────────────────────────

async function checkWithoutAccess(file) {
  const port = await deadPort();
  for (const [purpose, response, pattern] of [
    ["{ access: null }", { status: 200, body: { access: null } }, /no stored access for git\.example\.test$/],
    ["403", { status: 403, body: { error: "fence" } }, /refuses \(HTTP 403\)/],
    ["no backend", null, /not reachable \(ECONNREFUSED\)/],
    ["no JSON", { status: 200, body: "<html>" }, /not JSON/],
    ["without field access", { status: 200, body: { ok: true } }, /without field “access”/],
    ["password with line break", { status: 200, body: { access: { username: USER, password: `${PASSWORD}\nquit=1` } } }, /without valid access/],
    ["user empty", { status: 200, body: { access: { username: "", password: PASSWORD } } }, /without valid access/],
    ["password not a string", { status: 200, body: { access: { username: USER, password: 7 } } }, /without valid access/],
  ]) {
    const ep = response ? await endpoint(response) : null;
    try {
      const r = await helper(file, "get", question(), environment(ep ? ep.url : `http://127.0.0.1:${port}/api/projects/p-one/lfs-access`));
      assert.equal(r.code, 0, `${purpose}: exit`);
      assert.equal(r.stdout, "", `${purpose}: output to git`);
      assert.equal(r.rows.length, 1, `${purpose}: not exactly one line on stderr: ${r.error}`);
      assert.match(r.rows[0], /^cbase-lfs-access: /, purpose);
      assert.match(r.rows[0], pattern, purpose);
      assert.ok(!r.error.includes(PASSWORD) && !r.error.includes(PASS), `${purpose}: a value on stderr`);
      if (ep) assert.equal(ep.requests.length, 1, `${purpose}: not exactly one request`);
    } finally { if (ep) await ep.close(); }
  }
}
test("(6) { access: null }, 403, no backend, no JSON, without field, invalid access => no output, one line on stderr without value; counter-test: without the line check a second protocol line goes to git", async () => {
  await checkWithoutAccess(HELPER);
  const withoutRows = broken("without-rows", "\n    || CONTROL_CHARACTERS.test(z.username) || CONTROL_CHARACTERS.test(z.password)) {", ") {");
  await assert.rejects(checkWithoutAccess(withoutRows), assert.AssertionError);
});

// ── (7) the cap ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("(7) the backend never answers (gate stays shut, knob at 30 ms) => one line with \"cap\", no output, exit 0; and the default is 10 s", async () => {
  const ep = await endpoint("never");
  try {
    const r = await helper(HELPER, "get", question(), environment(ep.url, { CBASE_LFS_CAP_MS: "30" }));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.rows.length, 1, r.error);
    assert.match(r.rows[0], /^cbase-lfs-access: cap — the backend did not answer within 30 ms; no access for git\.example\.test$/);
  } finally { await ep.close(); }
  // The knob takes only positive integers; otherwise the default applies (text, no duration).
  assert.match(SOURCE, /const CAP_DEFAULT_MS = 10_000;/);
  assert.match(SOURCE, /\/\^\[1-9\]\[0-9\]\*\$\/\.test\(raw\) \? Number\(raw\) : CAP_DEFAULT_MS/);
});

// ── (8) no values ────────────────────────────────────────────────────────────────────────────────────────────────────

test("(8) the source starts nothing, writes no file, loads nothing, only reads /proc; over all runs no pass, no password on stderr, no working folder written", async () => {
  const code = SOURCE.split("\n").filter((z) => !/^\s*\/\//.test(z)).join("\n");
  for (const [what, pattern] of [
    ["a process start", /child_process|\bspawn\b|\bexecFile\b|\bexecSync\b|\bfork\(/],
    ["a write to a file", /writeFile|appendFile|createWriteStream|\bopenSync\b|\bmkdir|\brmSync\b|\bunlink|\brename|\bsymlink|\bcopyFile|\bchmod|\bchown|\btruncate/],
    ["an import/require", /^\s*import\s|\bimport\(|\brequire\(/m],
  ]) assert.doesNotMatch(code, pattern, `the helper contains ${what}`);
  // `node:fs` only via getBuiltinModule (without import, works for both module kinds), and from it only the two read paths of the ancestry.
  assert.deepEqual([...code.matchAll(/getBuiltinModule\(([^)]*)\)/g)].map((m) => m[1]), ['"node:fs"'], "getBuiltinModule not exactly once, not exactly node:fs");
  assert.deepEqual([...new Set([...code.matchAll(/\bfs\.(\w+)/g)].map((m) => m[1]))].sort(), ["readFileSync", "readlinkSync"], "the helper uses more of node:fs than the two read paths");
  // All runs of this file up to here (node --test runs the tests of a file in order).
  assert.ok(ALL_STDERR.length > 40, `too few runs seen (${ALL_STDERR.length}), the check says nothing`);
  for (const f of ALL_STDERR) {
    assert.ok(!f.includes(PASS), "pass on stderr");
    assert.ok(!f.includes(PASSWORD), "password on stderr");
  }
  for (const d of fs.readdirSync(ROOT).filter((n) => n.startsWith("lauf-"))) {
    assert.deepEqual(fs.readdirSync(path.join(ROOT, d)), [], `the helper wrote into its working folder (${d})`);
  }
});

// ── (9) like in the image: without package.json ──────────────────────────────────────────────────────────────────────

test("(9) as a copy without package.json (CommonJS, like under /usr/local/bin in the image): silent without environment, answers git-lfs and git over https, silent when called from the shell, without a warning on stderr", async () => {
  const location = path.join(ROOT, "usr-local-bin");
  fs.mkdirSync(location);
  const copy = path.join(location, "cbase-lfs-access");
  fs.copyFileSync(HELPER, copy);
  for (let d = location; d !== path.dirname(d); d = path.dirname(d)) assert.ok(!fs.existsSync(path.join(d, "package.json")), `package.json above the copy: ${d}`);
  await mustStillBe(copy, "get", question(), () => ({ CBASE_LFS_PROC: CHAIN_LFS }), "copy without environment");
  const { r } = await asksOnce(copy, question(), "copy with the git-lfs chain");
  assert.equal(r.error, "");
  const { r: rGit } = await asksOnce(copy, question(), "copy, git itself asks over https", { CBASE_LFS_PROC: CHAIN_GIT });
  assert.equal(rGit.error, "");
  await mustStillBe(copy, "get", question(), (url) => environment(url, { CBASE_LFS_PROC: CHAIN_FOREIGN }), "copy, called from the shell");
  assert.match(SOURCE, /^#!\/usr\/local\/bin\/node\n/, "shebang is not the base image's node");
  assert.ok(fs.statSync(HELPER).mode & 0o100, "the helper is not executable in the repo");
});

// ── (10) neutral next to today's paths, with real git ────────────────────────────────────────────────────────────────

// A call of real git (asynchronous: the fake endpoint lives in THIS process), environment from scratch (`environmentGit`).
function git(args, input, env) {
  neverTheRealProc(env);
  return new Promise((resolve, reject) => {
    const subprocess = spawn("git", args, { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let error = "";
    subprocess.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
    subprocess.stderr.setEncoding("utf8").on("data", (d) => { error += d; });
    subprocess.stdin.on("error", () => {});
    subprocess.stdin.end(input);
    subprocess.on("error", reject);
    subprocess.on("close", (code) => { ALL_STDERR.push(error); resolve({ code, stdout, error }); });
  });
}
// Only what counts for the login (the line `path=` is printed by `git credential fill` depending on useHttpPath).
const login = (r) => ({ code: r.code, rows: r.stdout.split("\n").filter((z) => /^(username|password)=/.test(z)) });

// Three configurations, one file each:
//   "projectbox"    like /etc/gitconfig of the project box: the helper (via a wrapper that only logs the ACTION) and
//                   `credential.useHttpPath = true`;
//   "withoutHelper" the same without the helper, the comparison that measures ONLY the helper;
//   "today"         none: the project container before the helper (there `useHttpPath` only changes the wording of the message,
//                   without a storing helper; for it see the test "not neutral …" under (10)).
// With `global` a further helper hangs behind it (via include at its place, like B's ~/.gitconfig after /etc/gitconfig).
// EVERYTHING via GIT_CONFIG_GLOBAL with GIT_CONFIG_NOSYSTEM=1, never via GIT_CONFIG_SYSTEM: Xcode's git reads next to
// /etc/gitconfig a file of its own with `credential.helper=osxkeychain` (only NOSYSTEM turns it off), and a `git credential
// approve` would otherwise write into this machine's keychain. Before a git runs, `systemConfiguration` checks that this
// environment carries no helper.
// The helper reads the ancestry from a fake /proc here too (CBASE_LFS_PROC): the real chain of this machine (git -> sh ->
// wrapper -> node) belongs to no git-lfs; the wrapper itself stands as a shell in between.
function systemConfiguration(helperFile) {
  const location = fs.mkdtempSync(path.join(ROOT, "git-"));
  const log = path.join(location, "asked.log");
  fs.writeFileSync(log, "");
  const wrapper = path.join(location, "helper");
  fs.writeFileSync(wrapper, `#!/bin/sh\necho "$1" >> '${log}'\nexec '${process.execPath}' '${helperFile}' "$@"\n`, { mode: 0o755 });
  const globalHelper = path.join(location, "global");
  fs.writeFileSync(globalHelper, "[credential]\n\thelper = \"!f() { printf 'username=global\\\\npassword=global-pw\\\\n'; }; f\"\n");
  const home = path.join(location, "home");
  fs.mkdirSync(home);
  const file = (name, parts) => { const f = path.join(location, name); fs.writeFileSync(f, parts.join("")); return f; };
  const withGlobal = (global) => (global ? [`[include]\n\tpath = ${globalHelper}\n`] : []);
  const files = {};
  for (const global of [false, true]) {
    files[`projectbox${global}`] = file(`projektbox-${global}`, [`[credential]\n\thelper = ${wrapper}\n\tuseHttpPath = true\n`, ...withGlobal(global)]);
    files[`withoutHelper${global}`] = file(`without-helper-${global}`, ["[credential]\n\tuseHttpPath = true\n", ...withGlobal(global)]);
    files[`today${global}`] = file(`heute-${global}`, withGlobal(global));
  }
  const environmentGit = (kind, { global = false, ...extra } = {}) => ({
    PATH: process.env.PATH, HOME: home, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: files[`${kind}${global}`], ...extra,
  });
  const empty = spawnSync("git", ["config", "--show-origin", "--get-all", "credential.helper"], { cwd: ROOT, env: environmentGit("today"), encoding: "utf8" });
  assert.equal(empty.status, 1, `this environment carries a helper of this machine; no git call that could reach it: ${empty.stdout}${empty.stderr}`);
  return { asked: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean), environmentGit };
}

const NORMAL = question();
const ACCESS = { username: "administration", secret: `administration-secret-${crypto.randomBytes(4).toString("hex")}` };

// The path without access (clone of a public repo, terminals, services): git asks the helper, it stays silent, and git ends
// byte-equal as without it. As a function over a helper file so the counter-test can run it with a broken version.
async function checkWithoutAccessNeutral(helperFile) {
  const k = systemConfiguration(helperFile);
  const without = await git(["credential", "fill"], NORMAL, k.environmentGit("withoutHelper"));
  assert.notEqual(without.code, 0, `without the helper git does not end with an error here, the check says nothing: ${without.stdout}`);
  const including = await git(["credential", "fill"], NORMAL, k.environmentGit("projectbox"));
  assert.deepEqual(including, without, "without access git ends differently with the helper than without it");
  assert.deepEqual(k.asked(), ["get"], "git did not ask the helper (exactly once), the check says nothing");
  return { without, k };
}

test("(10) neutral: with the admin git's access (accessAsEnvironment) the helper is not asked at all and the answer is the same as without it and as today, also with LFS environment and the git-lfs chain", async () => {
  const ep = await endpoint();
  try {
    const k = systemConfiguration(HELPER);
    const access = accessAsEnvironment([{ host: HOST, access: ACCESS }]); // per host only
    assert.equal(access.GIT_CONFIG_KEY_0, "credential.helper");
    assert.equal(access.GIT_CONFIG_VALUE_0, "", "accessAsEnvironment no longer clears the list first: this test's assumption does not hold");
    for (const [purpose, input, extra] of [
      ["pull/fetch/push", NORMAL, {}],
      ["pull/fetch/push in an agent shell", NORMAL, environment(ep.url, { CBASE_LFS_PROC: CHAIN_GIT })],
      ["git-lfs in an agent shell", NORMAL, environment(ep.url)],
      ["with a further helper behind it", NORMAL, { global: true }],
    ]) {
      const byKind = {};
      for (const kind of ["projectbox", "withoutHelper", "today"]) byKind[kind] = login(await git(["credential", "fill"], input, k.environmentGit(kind, { ...access, ...extra })));
      assert.deepEqual(byKind.projectbox, { code: 0, rows: [`username=${ACCESS.username}`, `password=${ACCESS.secret}`] }, purpose);
      assert.deepEqual(byKind.withoutHelper, byKind.projectbox, `${purpose}: different from without the helper`);
      assert.deepEqual(byKind.today, byKind.projectbox, `${purpose}: different from today`);
    }
    assert.deepEqual(k.asked(), [], "the helper was asked despite the cleared list");
    assert.equal(ep.requests.length, 0, "the backend was asked");
  } finally { await ep.close(); }
});

test("(10) neutral: without access git asks the helper, it stays silent, git ends byte-equal as without it (against today only the message URL, isGitAuthError recognises both); counter-test: a helper that says something without environment changes the end", async () => {
  const { without, k } = await checkWithoutAccessNeutral(HELPER);
  // Against today (without useHttpPath): the same exit, the same (empty) output; the message names the URL WITH path, which
  // `credential.useHttpPath` changes, not the helper, and the login-error detection (git.js isGitAuthError) reads both alike.
  const today = await git(["credential", "fill"], NORMAL, k.environmentGit("today"));
  assert.equal(today.code, without.code);
  assert.equal(today.stdout, without.stdout);
  assert.match(today.error, /could not read Username for 'https:\/\/git\.example\.test': terminal prompts disabled/);
  assert.match(without.error, /could not read Username for 'https:\/\/git\.example\.test\/group\/repo\.git': terminal prompts disabled/);
  assert.equal(isGitAuthError(today.error), true);
  assert.equal(isGitAuthError(without.error), true);
  const talks = broken("talks", "if (!url || !pass) return end(); // (b)", 'if (!url || !pass) return end({ output: "username=cbase\\n" }); // (b)');
  await assert.rejects(checkWithoutAccessNeutral(talks), assert.AssertionError);
});

test("(10) neutral: a further helper behind it (global configuration, no path use) answers as without the helper, also in an agent shell when neither git-lfs nor git over https asks; approve/reject reach it, it asks nobody; if git asks over https from an agent shell this helper wins (it stands first)", async () => {
  // Compared with "withoutHelper", the SAME configuration including useHttpPath: only this helper is measured. The helper behind
  // it does not evaluate the path; for a storing one the useHttpPath line itself is not neutral (next test).
  const ep = await endpoint();
  try {
    const k = systemConfiguration(HELPER);
    for (const extra of [{}, environment(ep.url, { CBASE_LFS_PROC: CHAIN_FOREIGN })]) {
      const without = await git(["credential", "fill"], NORMAL, k.environmentGit("withoutHelper", { global: true, ...extra }));
      const including = await git(["credential", "fill"], NORMAL, k.environmentGit("projectbox", { global: true, ...extra }));
      assert.equal(including.code, 0, including.error);
      assert.deepEqual(including, without);
      assert.deepEqual(login(including).rows, ["username=global", "password=global-pw"]);
    }
    const full = NORMAL.replace(/\n\n$/, `\nusername=${USER}\npassword=${PASSWORD}\n\n`);
    for (const action of ["approve", "reject"]) {
      const r = await git(["credential", action], full, k.environmentGit("projectbox", environment(ep.url)));
      assert.equal(r.code, 0, `${action}: ${r.error}`);
      assert.equal(r.error, "", action);
    }
    assert.deepEqual(k.asked(), ["get", "get", "store", "erase"]);
    assert.equal(ep.requests.length, 0, "the backend was asked");
    // git over https from an agent shell: this helper stands first in /etc/gitconfig and answers; the one behind it is no longer
    // asked (git stops after the first complete access).
    const gitHttp = await git(["credential", "fill"], NORMAL, k.environmentGit("projectbox", { global: true, ...environment(ep.url, { CBASE_LFS_PROC: CHAIN_GIT }) }));
    assert.equal(gitHttp.code, 0, gitHttp.error);
    assert.deepEqual(login(gitHttp).rows, [`username=${USER}`, `password=${PASSWORD}`]);
    assert.equal(ep.requests.length, 1);
  } finally { await ep.close(); }
});

// NOT neutral against today is the line `credential.useHttpPath = true` itself, for a STORING helper. git then asks with a path,
// and an entry without a path no longer fits (credential_match in git: a field of the question must stand in the entry), yet
// that is how `store` writes it without the line. Measured with `credential-store --file` in a folder of its own (never this
// machine's store), per configuration as above: today, without the helper, like the project box.
async function savingHelper(entry) {
  const location = fs.mkdtempSync(path.join(ROOT, "store-"));
  const home = path.join(location, "home");
  fs.mkdirSync(home);
  const deposit = path.join(location, "accesses");
  fs.writeFileSync(deposit, `${entry}\n`, { mode: 0o600 });
  const wrapper = path.join(location, "helper");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${HELPER}' "$@"\n`, { mode: 0o755 });
  const store = `store --file ${deposit}`;
  const byKind = {};
  for (const [kind, helper, withPath] of [["today", [store], false], ["withoutHelper", [store], true], ["projectbox", [wrapper, store], true]]) {
    const file = path.join(location, kind);
    fs.writeFileSync(file, `[credential]\n${helper.map((h) => `\thelper = ${h}\n`).join("")}${withPath ? "\tuseHttpPath = true\n" : ""}`);
    const env = { PATH: process.env.PATH, HOME: home, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: file };
    const list = spawnSync("git", ["config", "--get-all", "credential.helper"], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(list.stdout, helper.map((h) => `${h}\n`).join(""), `${kind}: this environment carries a further helper; no git call that could reach it`);
    byKind[kind] = login(await git(["credential", "fill"], NORMAL, env));
  }
  return byKind;
}

test("(10) not neutral is the useHttpPath line for a storing helper: credential-store no longer finds an entry without a path (today exit 0, with the line 128, the same with and without the helper); harmless for B because ~/.git-credentials is never mounted; counter-test: the same entry with a path works", async () => {
  const withoutPath = await savingHelper(`https://stored:saved-pw@${HOST}`);
  assert.deepEqual(withoutPath.today, { code: 0, rows: ["username=stored", "password=saved-pw"] }, "today the stored access does not work: the check says nothing");
  assert.deepEqual(withoutPath.withoutHelper, { code: 128, rows: [] }, "with useHttpPath an entry without a path still works");
  assert.deepEqual(withoutPath.projectbox, withoutPath.withoutHelper, "different with the helper than without it: then it would be the helper, not the line");
  // Counter-test: the same entry WITH a path works under useHttpPath too: the missing path is the cause.
  const withPath = await savingHelper(`https://stored:saved-pw@${HOST}/group/repo.git`);
  assert.deepEqual(withPath.projectbox, withoutPath.today);
  // Harmless for B's mounted ~/.gitconfig: its `store` without --file reads ~/.git-credentials, which is never mounted into a
  // project container. It hits a storing helper that an agent sets up itself in the project container.
  const { neverMounted } = await import(new URL("../../server/backend/electron/server/projectbox/creation.js", import.meta.url).href);
  const home = "/home/agent";
  const data = `${home}/cbase/data`;
  const never = neverMounted({ home, data, flat: { scratch: `${data}/scratch`, playwrightProfiles: `${data}/playwright-profiles` } });
  assert.ok(never.some((e) => e.path === `${home}/.git-credentials` && e.below), "~/.git-credentials no longer stands in neverMounted: the claim \"harmless for B\" does not hold");
});

test("(10) with LFS environment and the git-lfs chain it answers via real git, with AND without useHttpPath (the path is no gate); if git itself asks over https it answers likewise; a call from the shell gets nothing", async () => {
  const ep = await endpoint();
  try {
    const k = systemConfiguration(HELPER);
    const r = await git(["credential", "fill"], question({ host: "h:8443" }), k.environmentGit("projectbox", environment(ep.url)));
    assert.equal(r.code, 0, r.error);
    assert.deepEqual(login(r).rows, [`username=${USER}`, `password=${PASSWORD}`]);
    assert.equal(ep.requests.length, 1);
    assert.deepEqual(JSON.parse(ep.requests[0].body), { host: "h:8443", path: REPO_PATH });
    // Without useHttpPath git strips the path before the helper: it still asks, only without `path`.
    const withoutPath = await git(["-c", "credential.useHttpPath=false", "credential", "fill"], question(), k.environmentGit("projectbox", environment(ep.url)));
    assert.equal(withoutPath.code, 0, withoutPath.error);
    assert.deepEqual(login(withoutPath).rows, [`username=${USER}`, `password=${PASSWORD}`]);
    assert.equal(ep.requests.length, 2);
    assert.deepEqual(JSON.parse(ep.requests[1].body), { host: HOST });
    // If git itself asks (the chain via git-remote-http): the same access, one more request.
    const itself = await git(["credential", "fill"], question(), k.environmentGit("projectbox", environment(ep.url, { CBASE_LFS_PROC: CHAIN_GIT })));
    assert.equal(itself.code, 0, itself.error);
    assert.deepEqual(login(itself).rows, [`username=${USER}`, `password=${PASSWORD}`]);
    assert.equal(ep.requests.length, 3, "git itself did not ask the backend");
    // A call from the shell (neither git-lfs nor git over https): no word, no request, git fails as without it.
    const foreign = await git(["credential", "fill"], question(), k.environmentGit("projectbox", environment(ep.url, { CBASE_LFS_PROC: CHAIN_FOREIGN })));
    assert.notEqual(foreign.code, 0, "a call from the shell got an access");
    assert.equal(ep.requests.length, 3, "a call from the shell asked the backend");
    assert.deepEqual(k.asked(), ["get", "get", "get", "get"]);
  } finally { await ep.close(); }
});
