// The project repo. When a project is relocated, cbase creates a local git (no remote, first commit FIRST_COMMIT) in a project
// folder that is not a repo and does not lie in one. It versions what lies NEXT TO the code repos (notes, decks, code without
// git); the code repos and the dependencies are excluded through `.git/info/exclude`, and a local `pre-commit` hook refuses any
// commit that still carries an embedded repo (mode 160000) and names it. The repo is recognised by its marker (git.js
// isProjectRepo) everywhere.
//
// No route of its own. Callers: projectbox/relocation (data.js, collect.js), projectbox/setup/procedure.js (project creation:
// `message: "Creation"`, `withoutDeadline`, `harden`) and stacks/ (code-snapshot.js, project-repo-copy.js, request.js, fetch.js).
// Each caller passes the instance it works on: the main's for a relocation, the clone HELPER's before a copy (hooks and filters
// run in the helper, never in B), the COPY's for its own project repo (its `.git` lies in the overlay; in B it would be the
// main's file).
//
// Runs in the backend as the backend user (agent in B) — never as root through an exec in the project container, or `.git` and
// everything in it would belong to root and the agent could no longer write there. Paths are the same in B and in the project
// container, so a repo created in B applies there unchanged.
//
//   createProjectRepo(projectPath, { message })  → { created: true, commit, branch: "main", repos, unreadable }
//                                          | { created: false, reason, repo }. `reason`: "repo" (the folder carries its own `.git`)
//                                          · "in-repo" (it lies in one, `repo` = its path — git is asked first, it searches from the
//                                          PHYSICAL path; then the ancestors of the physical and of the lexical path). If a step
//                                          fails AFTER `git init`, the new `.git` is removed again and the function throws. WITH an
//                                          instance the CONTAINER deletes (`rm -rf` through commandRun), never B: a recursive delete
//                                          in B by path names follows a link that the running container swaps in mid-tree. If that
//                                          fails, `.git` stays and the message says so (`e.gitStayed`); B does not delete it again.
//   commitProjectRepo(projectPath, message, { empty, onlyIfNeeded })  an own commit of cbase: FIRST refresh `info/exclude`, then
//                                          take what now lies in a repo or is unreadable out of the INDEX (an exclusion only acts
//                                          on untracked files; the files stay), then `add -A` and `commit` (with the hook). Only in
//                                          a project repo (marker). With `onlyIfNeeded` it commits only if something is staged after
//                                          `add -A` (`withoutCommit: true` otherwise) — idempotent, before a copy is merged.
//                                          → { commit, repos, unreadable }
//   removeProjectRepo(projectPath, { commit })  the way back of a relocation: only with the marker and only if HEAD is exactly
//                                          the own first commit (`commit` from the result of createProjectRepo); then `.git` goes,
//                                          the files stay. → { removed: true } | { removed: false, reason }. Never throws.
//                                          WITH an instance `.git` goes in the container, never in B.
//   searchProject(root, { cap }) → { repos, unreadable }: the OWN, complete search for every `.git` (folder, file or link) under
//                                          the root, relative and sorted: without the depth/count limits and without skipping dot
//                                          folders of git.js findRepos — an overlooked repo would be taken by `add -A` as mode
//                                          160000. Also every file and folder the backend user cannot read (`unreadable`, folders
//                                          with a trailing "/"): an unreadable FILE aborts `git add -A` altogether ("fatal: adding
//                                          files failed"), an unreadable folder only produces a warning and is silently left out —
//                                          both are excluded and named. It does not descend into a found repo, into `.git` or into
//                                          the excluded dependencies (the pattern covers those at any depth); links are not followed
//                                          (git versions a link as a link). Asynchronous: after every YIELD_EVERY accesses it yields
//                                          the event loop (all chats of the user hang on it in B); beyond `cap` folders (default
//                                          FOLDER_CAP, knob CBASE_PROJECT_REPO_FOLDER_CAP) it aborts WITH A MESSAGE instead of
//                                          silently cutting.
//   embeddedRepos(root)                 → only the `repos` of it.
//   upkeepExclude(root)                 rewrites the cbase block in `.git/info/exclude` (everything outside the block stays)
//                                          → { repos, unreadable, changed }. With `{ instance, inContainer: true }`: search AND
//                                          write in the container of the instance (EXCLUDE_PROGRAM, the same pure computation
//                                          `excludeNew`) — for a copy whose `.git` lies in the overlay.
//   takeFromTheIndex(root, out, { instance })  the "take out of the index" step of ownCommit on its own — the project repo of a
//                                          copy commits without `add -A` (stacks/project-repo-copy.js).
//   GIT_REDIRECTOR                        the names and prefixes gitEnvironment removes — for a program that starts git itself in
//                                          the container (stacks/returnPath.js).
//   RETURN_PATH_REST                       the pattern `.cbase-back-*.tmp` of the leftovers of the return-path program of a copy
//                                          (stacks/returnPath.js rest_name) — one line of the cbase block, without anchor and "/".
//   addPathDetails(out)                 the path arguments of the `add -A` of an own commit: `.` plus `:(exclude,literal)<p>` for
//                                          each repo/unreadable path that git does NOT already ignore (a `.gitignore` with `!…`
//                                          beats info/exclude), NUL-separated over stdin.
//   GIT_FILE_CAP                         WITH an instance B reads a file inside `.git` (info/exclude) only up to 1 MiB — `fstat`
//                                          on the descriptor first, above that it aborts with a message (`ETOOLARGE`).
//
// The fixed identity, the marker and `core.hooksPath` live in the LOCAL configuration: a global `core.hooksPath` would silently
// switch the hook off (projectRepo.test.js shows the commit that then goes through), and B has no `~/.gitconfig` — without a
// local identity every commit would fail. What stands ABOVE the local configuration (GIT_CONFIG_COUNT/_KEY_n/_VALUE_n,
// GIT_CONFIG_PARAMETERS) and the `init` template (GIT_TEMPLATE_DIR) is removed by gitEnvironment.
//
// EVERY git call of this file goes through `git(cwd, args, instance)` — also the question whether the folder already lies in a
// repo. WITH an instance every git runs through runtime/git-run.js in the project container as agent (hooks, `core.fsmonitor`
// and filters that the container can write into the project repo never run in B); WITHOUT one, the starter `gitInB`. The
// READABILITY CHECK applies where `git add -A` reads: with an instance the search (`searchProject`, the same function `search`)
// runs as `node -e` in the project container — what the agent cannot read THERE is excluded. The other file accesses
// (`info/exclude`, hook) stay in the backend; the `.git` removal runs in the container (gitFolderRemove; guard
// projectbox-rm-in-b.test.js: every `fs.rmSync` of this file stands behind `if (!instance)`). Since the project container can
// write `.git`, `info/exclude` and the hook go through the descriptor (runtime/real-path.js openFileWithoutReference — project
// folder area, O_NOFOLLOW, only a regular file); a link in their place throws instead of B writing through it.
//
// HARDENING WITH AN INSTANCE (`harden`): every public function that calls git takes `harden` — then every git IN THE CONTAINER
// carries `GIT_HARDENING`, for `commit` `HARDENING_COMMIT`. Reason: in the project container the `~/.gitconfig` of the project
// home applies, and the agent writes it — a `core.hooksPath` there would switch off the own `pre-commit` (gitlink protection)
// and run a foreign hook, `commit.gpgSign=true` would make the setup fail, a `core.fsmonitor` would start a command. The
// container way does NOT neutralise the configured filters (only `gitInB` does): they would run as the same user as the agent,
// in the namespace of the project. Without `harden` (relocation, copy) git runs unhardened.
// WITHOUT DEADLINE (`withoutDeadline`): every git and the search run without the cap GIT_CAP_MS (a big folder that the user does
// not keep as a code repo would otherwise hit a size limit at 120 s).
//
// THE HARDENING. Every git WITHOUT an instance (the fallback `gitInB`) runs with `GIT_HARDENING`: `core.fsmonitor=false`
// (`ls-files`/`status`/`add` would otherwise run a command from the repo configuration), `core.hooksPath=/dev/null` (`add`/`rm`
// write the index — `post-index-change`), `core.untrackedCache=false`, `protocol.allow=never` (no transport: `core.sshCommand`,
// `ext::`, remote helpers and the lazy fetch of a partial clone would otherwise run a command of the repo configuration). Only
// the cbase commit needs its own `pre-commit`: for `commit` `core.hooksPath` points EXPLICITLY at `.git/hooks` (relative to the
// work tree root), never at a place a configuration sets; plus `commit.gpgSign=false` (else `gpg.program` from the repo
// configuration). Filters go through the ENVIRONMENT, because `-c` splits a subsection containing "=" wrongly
// (`filter.x=y.clean`): before every git that reads file content (`add`, `commit`, `diff`, `rm`), `filterNeutral` asks for the
// names `filter.<x>.clean|smudge|process|required` in the repo configuration (origin local, worktree or included — only
// `global` and `system` belong to B) and sets them as GIT_CONFIG_COUNT/_KEY_n/_VALUE_n to empty, `required=false` (measured on
// git 2.50: an empty filter does not run, `required=false` lets the content through raw). `diff.external` and textconv are not
// reached: this file only asks `diff --cached --quiet`, and the hook reads `--raw`. Guard: projectRepo.test.js "(10b)".
// Exported for the relocation plan (projectbox/relocation/collect.js). With an instance git runs in the project container
// without hardening unless the caller asks for it (`harden`).

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { PROJECT_REPO_SECTION, PROJECT_REPO_KEY, isProjectRepo } from "../git.js";
import { realRoots, openFileWithoutReference } from "../runtime/real-path.js";
import { writeStdin } from "../providers/kind-stdin.js";
import { commandRun, gitRun } from "../runtime/git-run.js";

const pexec = promisify(execFile);

// Cap of one git call: `add -A` reads the whole project folder without the excluded parts. Estimated, not measured; 120 s is
// the deadline of a HANGING git, as in workflows/worktree.js.
export const GIT_CAP_MS = 120_000;

export const BRANCH = "main";
export const FIRST_COMMIT = "State at relocation";
// The fixed identity of the cbase commits: "cbase" <cbase@cbase.invalid> — `.invalid` is reserved by RFC 2606, so the address
// is never deliverable.
export const IDENTITY = { name: "cbase", email: "cbase@cbase.invalid" };
// The local configuration of the project repo, in this order (the marker FIRST: if a later step fails, the repo is already
// recognisable as the own one). ONE list for createProjectRepo and the preparation of a copy (stacks/prepare.js writes it with
// the git IN the copy container through the overlay — this module would write in B, which for a copy is the main).
export const PROJECT_REPO_CONFIG = Object.freeze([
  [`${PROJECT_REPO_SECTION}.${PROJECT_REPO_KEY}`, "true"],
  ["user.name", IDENTITY.name],
  ["user.email", IDENTITY.email],
  ["core.hooksPath", ".git/hooks"],
  ["commit.gpgsign", "false"],
].map((z) => Object.freeze(z)));
// The hook of the project repo, relative to the repo (PRE_COMMIT below, mode 0755).
export const PROJECT_REPO_HOOK = ".git/hooks/pre-commit";
// The dependencies that never belong in the project repo — lines in `info/exclude`.
export const DEPENDENCIES = ["node_modules", ".venv", ".pptx-venv", ".playwright-mcp/"];
// The search does not descend into these folders: the pattern excludes them at any depth, with every repo inside. A FILE of
// this name is covered only by a pattern without a trailing "/" (`.playwright-mcp/` applies to folders only).
const NOT_DESCEND = new Set(DEPENDENCIES.map((z) => z.replace(/\/$/, "")));
const FILE_EXCLUDED = new Set(DEPENDENCIES.filter((z) => !z.endsWith("/")));

// Cap of the search: after this many folders it aborts with a message. Estimated, not measured (64,000 folders took ≈ 1.6 s);
// 200,000 leaves a project without a `.venv` name (`venv/`, data folders) plenty of room. Knob CBASE_PROJECT_REPO_FOLDER_CAP,
// read at run time.
export const FOLDER_CAP = 200_000;
// After this many file system accesses (reading a folder, checking a file) the search yields the event loop.
export const YIELD_EVERY = 256;
function folderCap() {
  const n = Number.parseInt(String(process.env.CBASE_PROJECT_REPO_FOLDER_CAP ?? ""), 10);
  return Number.isInteger(n) && n > 0 ? n : FOLDER_CAP;
}

// The pattern of the leftovers of the return-path program (stacks/returnPath.js `rest_name` — projectbox/ never imports stacks/;
// the guard projectRepo.test.js keeps both together).
export const RETURN_PATH_REST = ".cbase-back-*.tmp";
// The stagings of a setup (`.cbase-source-<n>/`) and of an after-the-fact upload (`.cbase-upload-<operation>/`) lie in the ROOT —
// dot folders that belong to cbase alone. An own commit in between (copy, creation commit) would otherwise take half-uploaded files.
export const STAGINGS = "/.cbase-*/";
export const EXCLUDE_BEGINNING = "# >>> cbase: project repo (projectbox/projectRepo.js) — rewritten before every cbase commit";
export const EXCLUDE_END = "# <<< cbase: project repo";

// The hook (sh: bash 3.2 on the Mac, dash/bash in the image — only what all can do; grep and cut are everywhere). It looks at the
// index of the commit (`--cached`, also against the empty tree before the first commit) and names every line with target mode
// 160000 — that is an embedded repo, new or changed.
export const HOOK_MARKER = "# cbase: project repo, pre-commit (projectbox/projectRepo.js)";
export const PRE_COMMIT = `#!/bin/sh
${HOOK_MARKER}
# A commit in the project repo must not carry an embedded repo (mode 160000): the code repos lie NEXT TO this repo and are
# versioned in their own repos.
hits=$(git diff --cached --raw --no-renames | grep -E '^:[0-7]{6} 160000 ' | cut -f2-)
if [ -n "$hits" ]; then
  echo "cbase: This commit in the project repo contains embedded repos (mode 160000):" >&2
  printf '%s\\n' "$hits" | while IFS= read -r p; do echo "  $p" >&2; done
  echo "The project repo versions only what lies next to the code repos. Take them out of the index (git rm --cached <path>) and add them to .git/info/exclude." >&2
  exit 1
fi
exit 0
`;

// The environment of a git call: without the variables that redirect the repo, the author or the configuration (a backend started
// from a git hook would otherwise inherit GIT_DIR/GIT_INDEX_FILE of the foreign repo), without prompts. Configuration from the
// environment stands ABOVE the local one: GIT_CONFIG_COUNT with `core.hooksPath` would switch the hook off, with `user.email`
// change the identity; GIT_TEMPLATE_DIR would bring foreign hooks along on `init`; GIT_CONFIG would point `git config` at another
// file; GIT_CEILING_DIRECTORIES would stop the question "does the folder lie in a repo?" too early.
const REDIRECTOR = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_TEMPLATE_DIR", "GIT_CEILING_DIRECTORIES"];
const REDIRECTOR_PREFIXES = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];
/** The same lists for a program that starts git itself in the container (stacks/returnPath.js removes them from its own
 *  environment — the allowlist of runtime/in-project.js carries only deviations, no "unset"). */
export const GIT_REDIRECTOR = Object.freeze({ names: Object.freeze([...REDIRECTOR]), prefixes: Object.freeze([...REDIRECTOR_PREFIXES]) });
// Exported for the relocation plan (projectbox/relocation/collect.js: the same cleaned environment for its git in B).
export function gitEnvironment() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const k of Object.keys(env)) {
    if (REDIRECTOR.includes(k) || REDIRECTOR_PREFIXES.some((p) => k.startsWith(p))) delete env[k];
  }
  return env;
}

// The ONE place where this file starts git (see header): with an instance in the project container (runtime/git-run.js), else
// the starter `gitInB`. An error carries `code` (the exit code of git, 128 = "fatal") and `stderr` on both ways. `stdin` (the path
// arguments of `add -A`) goes along on both ways — with an instance through gitRun, without through the stdin of the child of gitInB.
async function git(cwd, args, instance = null, { stdin, withoutDeadline = false, harden = false } = {}) {
  if (!instance) return gitRun(null, cwd, args, { fallback: () => gitInB(cwd, args, { stdin, withoutDeadline }) });
  // See header "HARDENING WITH AN INSTANCE": `gitInB` is always hardened; with an instance only at the caller's request.
  const argv = harden ? [...(args[0] === "commit" ? HARDENING_COMMIT : GIT_HARDENING), ...args] : args;
  const r = await gitRun(instance, cwd, argv, { ...(withoutDeadline ? { withoutDeadline: true } : { timeout: GIT_CAP_MS }), maxBuffer: 16 * 1024 * 1024, ...(stdin === undefined ? {} : { stdin }) });
  if (r.code === 0) return r.stdout;
  const err = new Error(`git ${args.join(" ")} in ${cwd} (project container ${instance.identifier || instance.projectId}): ${String(r.stderr || "").trim()}`);
  err.stderr = String(r.stderr || "");
  err.code = r.code;
  throw err;
}

/** The hardening of every git in B (see header "THE HARDENING"). */
export const GIT_HARDENING = Object.freeze(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false", "-c", "protocol.allow=never"]);
const HARDENING_COMMIT = Object.freeze(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=.git/hooks", "-c", "core.untrackedCache=false", "-c", "protocol.allow=never", "-c", "commit.gpgSign=false"]);

// The filters of the repo configuration, neutralised through the environment (see header "THE HARDENING"). Commands that read no
// file content do not ask (one more query per call otherwise); every other one — also a future one — asks.
const READS_NO_CONTENT = new Set(["init", "config", "rev-parse", "check-ignore"]);
const FILTER_KEY = "^filter\\..+\\.(clean|smudge|process|required)$";
/** `filterNeutral` neutralises at most this many filter keys (estimated, not measured — a repo carries a handful). */
export const FILTER_CAP = 200;
// `start(argv)` is the starter of gitInB (the ONE git start of this file, in-project-start-places.test.js GIT_STARTER).
async function filterNeutral(start) {
  let out = "";
  try {
    ({ stdout: out } = await start([...GIT_HARDENING, "config", "-z", "--show-scope", "--name-only", "--get-regexp", FILTER_KEY]));
  } catch (e) {
    if (e?.code === 1) return {}; // no key — the normal case
    throw e;
  }
  const parts = String(out).split("\0");
  const names = new Set();
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i] !== "global" && parts[i] !== "system") names.add(parts[i + 1]);
  if (names.size > FILTER_CAP) {
    const err = new Error(`${names.size} filter keys in the configuration of the repo — over the cap of ${FILTER_CAP} (estimated, not measured); git does not run here.`);
    err.code = "FILTER_CAP";
    throw err;
  }
  if (!names.size) return {};
  const env = { GIT_CONFIG_COUNT: String(names.size) };
  [...names].forEach((n, i) => { env[`GIT_CONFIG_KEY_${i}`] = n; env[`GIT_CONFIG_VALUE_${i}`] = n.endsWith(".required") ? "false" : ""; });
  return env;
}

// The starter without an instance (the fallback) — always hardened.
async function gitInB(cwd, args, { stdin, withoutDeadline = false } = {}) {
  // The filter query and the command itself go through the SAME start — hardened, with a cleaned environment.
  // `withoutDeadline` ⇒ `timeout: 0` (execFile: no cap).
  const start = (argv, env = {}) => pexec("git", argv, { cwd, timeout: withoutDeadline ? 0 : GIT_CAP_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...gitEnvironment(), ...env } });
  try {
    const filter = READS_NO_CONTENT.has(args[0]) ? {} : await filterNeutral(start);
    const run = start([...(args[0] === "commit" ? HARDENING_COMMIT : GIT_HARDENING), ...args], filter);
    // Without `stdin` the stdin of the child stays open and unread; with `stdin` it goes through the ONE write place for child
    // stdin (providers/kind-stdin.js, guard stdin-epipe.test.js).
    if (stdin !== undefined) writeStdin(run.child, stdin, { close: true });
    const { stdout } = await run;
    return stdout;
  } catch (e) {
    const cap = e?.killed ? ` (cap of ${GIT_CAP_MS / 1000} s reached — estimated, not measured)` : "";
    const err = new Error(`git ${args.join(" ")} in ${cwd}: ${String(e?.stderr || e?.message || e).trim()}${cap}`);
    err.stderr = String(e?.stderr || "");
    err.code = e?.code;
    throw err;
  }
}

// An entry named `.git` in `dir` — folder, file (worktree, submodule) or link, also a broken one.
function hasGitEntry(dir) {
  try { fs.lstatSync(path.join(dir, ".git")); return true; } catch { return false; }
}

// The search itself, as ONE pure function: it gets `fs`, `path` and its constants as arguments and reads nothing outside — so
// the same function runs in B (directly) and in the project container (as source text in `node -e`). Abort at the cap: an Error
// with `cap` (thrown in B, returned from the container as JSON and rethrown here).
// Names come as BYTES (`encoding: "buffer"`), every access goes through the byte path, and a name that is not UTF-8 enters the
// list in surrogateescape form (each invalid byte 0x80–0xFF as U+DC80–U+DCFF, as stacks/returnPath.js nameBytes computes it
// back). Read as text, `caf\xe9` became a non-existent `caf\ufffd`: the folder counted as unreadable and a repo inside it was
// missing from every backup of a copy.
// LIMIT: only the SEARCH and the fetching of a copy (stacks/fetch.js) work with bytes. The path of the own commit is still TEXT
// for such a name — `excludeBlock` (the line in info/exclude), `addPathDetails` and `check-ignore` (stdin), `takeFromTheIndex`
// (argv) send the surrogateescape form as UTF-8 (U+DCE9 ⇒ EF BF BD), and none of these hits the folder. `add -A` therefore takes
// an embedded repo with such a name as a gitlink and the pre-commit hook refuses the own commit — loudly, without loss (the step
// fails with a message before a copy or before a merge). Open: these four ways as bytes (nameBytes/nulBytes,
// `rm --pathspec-from-file`) — projectbox/ never imports stacks/.
async function search(fs, path, root, cap, K) {
  const notDescend = new Set(K.notDescend);
  const fileExcluded = new Set(K.fileExcluded);
  const asText = (b) => {
    if (b.every((x) => x < 0x80)) return b.toString("latin1");
    let t = "";
    let i = 0;
    while (i < b.length) {
      const c = b[i];
      const n = c < 0x80 ? 1 : c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0;
      let ok = n > 0 && i + n <= b.length;
      for (let j = 1; ok && j < n; j++) ok = (b[i + j] & 0xc0) === 0x80;
      if (ok && n === 3) ok = !(c === 0xe0 && b[i + 1] < 0xa0) && !(c === 0xed && b[i + 1] > 0x9f);
      if (ok && n === 4) ok = !(c === 0xf0 && b[i + 1] < 0x90) && !(c === 0xf4 && b[i + 1] > 0x8f);
      if (ok) { t += b.toString("utf8", i, i + n); i += n; } else { t += String.fromCharCode(0xdc00 + c); i += 1; }
    }
    return t;
  };
  const SL = Buffer.from("/");
  const repos = [];
  const unreadable = [];
  let folder = 0;
  let accesses = 0;
  const handOver = async () => { if (++accesses % K.yieldEvery === 0) await new Promise((r) => setImmediate(r)); };
  const walk = async (dir, rel) => {
    if (++folder > cap) {
      const e = new Error(`Project repo: the search for embedded repos and unreadable files under ${root} reached the cap of ${cap} folders (estimated, not measured; knob CBASE_PROJECT_REPO_FOLDER_CAP) — aborted instead of cut: an overlooked repo would be taken by \`git add -A\` as mode 160000.`);
      e.cap = cap;
      throw e;
    }
    let entries;
    // An unreadable folder: git only warns ("could not open directory") and silently leaves it out — exclude it, name it.
    try { entries = fs.readdirSync(dir, { withFileTypes: true, encoding: "buffer" }); } catch { if (rel) unreadable.push(`${rel}/`); return; }
    await handOver();
    const names = entries.map((e) => ({ e, n: asText(e.name) }));
    if (rel && names.some((x) => x.n === ".git")) { repos.push(rel); return; }
    for (const { e, n } of names) {
      if (n === ".git") continue;
      const kind = rel ? `${rel}/${n}` : n;
      const p = Buffer.concat([dir, SL, e.name]);
      if (e.isDirectory()) {
        if (!notDescend.has(n)) await walk(p, kind);
      } else if (e.isFile() && !fileExcluded.has(n)) {
        // An unreadable file: `git add -A` aborts altogether on it. A link is not read (git takes it as a link).
        try { fs.accessSync(p, fs.constants.R_OK); } catch { unreadable.push(kind); }
        await handOver();
      }
    }
  };
  await walk(Buffer.from(path.resolve(root)), "");
  return { repos: repos.sort(), unreadable: unreadable.sort() };
}
const SEARCH_CONSTANTS = { notDescend: [...NOT_DESCEND], fileExcluded: [...FILE_EXCLUDED], yieldEvery: YIELD_EVERY };
// The program in the project container: the same `search`, its result as JSON on stdout (also the cap abort).
export const SEARCH_PROGRAM = `const fs = require("node:fs"), path = require("node:path");
(${search.toString()})(fs, path, process.argv[1], Number(process.argv[2]), ${JSON.stringify(SEARCH_CONSTANTS)}).then(
  (r) => process.stdout.write(JSON.stringify({ ok: r })),
  (e) => process.stdout.write(JSON.stringify({ error: String((e && e.message) || e), cap: (e && e.cap) || null })));
`;

/**
 * The complete search under `root` (see header): embedded repos and paths unreadable for the backend, each relative, with "/"
 * for folders, sorted; the root itself does not count. Throws with a message if it would have to read more than `cap` folders.
 * With `instance` it runs in the project container, and "unreadable" means "unreadable for the agent THERE".
 */
export async function searchProject(root, { cap = folderCap(), instance = null, withoutDeadline = false } = {}) {
  if (!instance) return search(fs, path, root, cap, SEARCH_CONSTANTS);
  const target = path.resolve(root);
  const r = await commandRun(instance, target, process.execPath, ["-e", SEARCH_PROGRAM, target, String(cap)], { ...(withoutDeadline ? { withoutDeadline: true } : { timeout: GIT_CAP_MS }), maxBuffer: 64 * 1024 * 1024 });
  let response = null;
  try { response = JSON.parse(r.stdout); } catch { /* below */ }
  if (response?.ok) return response.ok;
  const e = new Error(response?.error || `Project repo: the search in project container ${instance.identifier || instance.projectId} failed (exit ${r.code}): ${String(r.stderr || "").trim()}`);
  if (response?.cap) e.cap = response.cap;
  throw e;
}

/** Only the embedded repos of searchProject. */
export async function embeddedRepos(root, opts) {
  return (await searchProject(root, opts)).repos;
}

// A path as an anchored line in `info/exclude`: `/<rel>/` for a folder (only this folder), `/<rel>` for a file; glob characters and
// the backslash literal, spaces at the line end masked (git would drop them). A line break cannot be written there — better no
// repo at all than one that takes the path.
function excludeRow(rel, { folder = true } = {}) {
  if (/[\r\n]/.test(rel)) throw new Error(`The path “${JSON.stringify(rel)}” contains a line break — info/exclude cannot exclude it.`);
  const z = rel.replace(/[\\*?[]/g, "\\$&");
  return folder ? `/${z}/` : `/${z.replace(/ +$/, (m) => "\\ ".repeat(m.length))}`;
}

// Exported for the relocation plan (projectbox/relocation/collect.js): it computes the files of the first commit with EXACTLY this
// block in a throwaway index instead of rebuilding the exclusions.
export function excludeBlock(repos, unreadable) {
  return [
    EXCLUDE_BEGINNING,
    "# Code repos (every embedded repo under the project folder):",
    ...repos.map((r) => excludeRow(r)),
    "# Unreadable for the backend (`git add -A` would abort on an unreadable file):",
    ...unreadable.map((u) => (u.endsWith("/") ? excludeRow(u.slice(0, -1)) : excludeRow(u, { folder: false }))),
    "# Dependencies:",
    ...DEPENDENCIES,
    // The leftover that the return-path program builds next to a target (stacks/returnPath.js `rest_name`:
    // `.cbase-back-<sha>.tmp`), at any depth, file or folder — without anchor and without "/". A leftover of a killed run would
    // otherwise enter the project repo with the next own commit.
    "# Leftovers of the return-path program of a copy (stacks/returnPath.js rest_name):",
    RETURN_PATH_REST,
    "# Stagings of the setup and of after-the-fact uploads (projectbox/setup/operation.js):",
    STAGINGS,
    EXCLUDE_END,
  ].join("\n");
}

// A file in `.git` WITH an instance (see header): through the descriptor, area of the project folders (its realpath is its mount
// point), the file itself never a link. Reading: a missing file is empty. Writing: create or replace, `mode` on the descriptor.
// Before reading, `fstat` on the descriptor — above GIT_FILE_CAP the file counts as foreign (the project container can write it;
// a sparse file of gigabytes would otherwise be read into B's memory entirely), the step aborts with a message. Same value as
// stacks/code-snapshot.js EXCLUDE_CAP.
export const GIT_FILE_CAP = 1024 * 1024;
const gitArea = (root) => { const w = path.resolve(root); return realRoots([w], [w]); };
function readInGit(file, root) {
  let fd;
  try { fd = openFileWithoutReference(file, gitArea(root)); } catch (e) { if (e?.code === "ENOENT") return ""; throw e; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size > GIT_FILE_CAP) {
      const e = new Error(`Project repo: ${file} is ${size} bytes — above the cap of ${GIT_FILE_CAP} bytes it counts as foreign; not read, aborted`);
      e.code = "ETOOLARGE";
      throw e;
    }
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}
function writeInGit(file, text, root, mode = null) {
  const fd = openFileWithoutReference(file, gitArea(root), { flags: fs.constants.O_WRONLY, create: true });
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, text);
    if (mode !== null) fs.fchmodSync(fd, mode);
  } finally { fs.closeSync(fd); }
}

// The new content of `info/exclude`: the old one without the cbase block, then the new block. ONE pure function (strings only) —
// it runs in B and, as source text, in the copy container (EXCLUDE_PROGRAM).
function excludeNew(old, block, beginning, end) {
  const rows = old.split("\n");
  const a = rows.indexOf(beginning);
  const e = a < 0 ? -1 : rows.indexOf(end, a);
  const foreign = (a < 0 ? rows : [...rows.slice(0, a), ...(e < 0 ? [] : rows.slice(e + 1))]).join("\n").replace(/\n+$/, "");
  return `${foreign ? `${foreign}\n` : ""}${block}\n`;
}

// The `info/exclude` of a COPY is written by a program IN the copy container (`upkeepExclude` with `inContainer`). With `fs` in B
// it would be the file of the MAIN — paths are the same in B and in the copy, only the overlay of the copy redirects the write
// into its upper layer. argv: the root; stdin: the block (computed in B, excludeBlock). `.git` and `.git/info` must be real
// folders, `exclude` a regular file or missing — a link is never followed (O_NOFOLLOW); result `{ changed }` as JSON, an error
// `{ error }`.
export const EXCLUDE_PROGRAM = `const fs = require("node:fs"), path = require("node:path");
const excludeNew = ${excludeNew.toString()};
try {
  const root = process.argv[1];
  const block = fs.readFileSync(0, "utf8");
  const git = path.join(root, ".git"), info = path.join(git, "info"), file = path.join(info, "exclude");
  const statOf = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
  const g = statOf(git);
  if (!g || !g.isDirectory()) throw new Error(git + " is not a folder");
  const i = statOf(info);
  if (i && !i.isDirectory()) throw new Error(info + " is not a folder");
  if (!i) fs.mkdirSync(info);
  const d = statOf(file);
  if (d && !d.isFile()) throw new Error(file + " is not a regular file");
  const old = d ? fs.readFileSync(file, "utf8") : "";
  const fresh = excludeNew(old, block, ${JSON.stringify(EXCLUDE_BEGINNING)}, ${JSON.stringify(EXCLUDE_END)});
  if (fresh === old) { process.stdout.write(JSON.stringify({ changed: false })); }
  else {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
    try { fs.writeSync(fd, fresh); } finally { fs.closeSync(fd); }
    process.stdout.write(JSON.stringify({ changed: true }));
  }
} catch (e) { process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) })); }
`;

/** Rewrites the cbase block in `<root>/.git/info/exclude`; foreign lines stay. `inContainer` (only with `instance`): search AND
 *  write in the container of the instance (EXCLUDE_PROGRAM) — for a copy whose `.git` lies in the overlay. */
export async function upkeepExclude(root, { instance = null, inContainer = false, withoutDeadline = false } = {}) {
  const { repos, unreadable } = await searchProject(root, { instance, withoutDeadline });
  if (inContainer) {
    if (!instance) throw new TypeError("upkeepExclude: inContainer only with an instance");
    const target = path.resolve(root);
    const r = await commandRun(instance, target, process.execPath, ["-e", EXCLUDE_PROGRAM, target], { ...(withoutDeadline ? { withoutDeadline: true } : { timeout: GIT_CAP_MS }), stdin: excludeBlock(repos, unreadable) });
    let response = null;
    try { response = JSON.parse(r.stdout); } catch { /* below */ }
    if (r.code === 0 && response && typeof response.changed === "boolean") return { repos, unreadable, changed: response.changed };
    throw new Error(`Project repo: info/exclude not written in container ${instance.identifier || instance.projectId}: ${response?.error || `exit ${r.code} ${String(r.stderr || "").trim()}`}`);
  }
  const file = path.join(root, ".git", "info", "exclude");
  const old = instance ? readInGit(file, root) : fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const fresh = excludeNew(old, excludeBlock(repos, unreadable), EXCLUDE_BEGINNING, EXCLUDE_END);
  if (fresh === old) return { repos, unreadable, changed: false };
  if (instance) writeInGit(file, fresh, root);
  else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fresh);
  }
  return { repos, unreadable, changed: true };
}

/** The path arguments of the `add -A` of an own commit — `.` and for each path to exclude (unreadable folders with "/" as from
 *  searchProject) `:(exclude,literal)<p>`, NUL-separated. As TEXT: a name that is not UTF-8 hits nothing here (see "LIMIT" at
 *  `search`). */
export function addPathDetails(out) {
  return [".", ...out.map((u) => `:(exclude,literal)${u.replace(/\/$/, "")}`)].map((x) => `${x}\0`).join("");
}

/** Of `out` (as from searchProject, folders with "/") the paths that git does NOT ignore — `check-ignore` asks the same rules as
 *  `add` (a `.gitignore` with `!…` beats info/exclude). Exit 1 means "none ignored". */
async function notIgnored(root, out, instance, withoutDeadline = false, harden = false) {
  if (!out.length) return [];
  const paths = out.map((u) => u.replace(/\/$/, ""));
  let result = "";
  try { result = await git(root, ["check-ignore", "-z", "--stdin"], instance, { stdin: paths.map((x) => `${x}\0`).join(""), withoutDeadline, harden }); } catch (e) { if (e.code !== 1) throw e; }
  const ignored = new Set(String(result).split("\0").filter(Boolean));
  return paths.filter((x) => !ignored.has(x));
}

// So many paths per `git rm` call (the command line stays short, also with long paths).
const RM_PER_CALL = 100;

// The one way of a cbase commit: first refresh `info/exclude`, then take what is already in the index and now lies in a repo or is
// unreadable out of the INDEX (an exclusion acts only on untracked files — a repo created in a versioned folder after the first
// commit would otherwise stay in the project repo with its files; `-f` because a refused commit can leave staged states; the files
// stay, `--literal-pathspecs` takes every name literally), then take everything and commit with the hook. → the full id of the new HEAD.
async function ownCommit(root, message, { empty = false, onlyIfNeeded = false, instance = null, withoutDeadline = false, harden = false } = {}) {
  const f = { withoutDeadline, harden };
  const { repos, unreadable } = await upkeepExclude(root, { instance, withoutDeadline });
  await takeFromTheIndex(root, [...repos, ...unreadable], { instance, withoutDeadline, harden });
  // `info/exclude` stands BELOW every `.gitignore` — a `!certs/key.pem` there would bring the unreadable file back and `add -A`
  // would abort ("adding files failed"). So `add` additionally excludes the same paths as a path argument: `.` plus
  // `:(exclude,literal)<p>`, NUL-separated over stdin (without `--literal-pathspecs` — the `exclude` magic must apply; `literal`
  // takes every name literally). Only for the paths that git does NOT already ignore (notIgnored): a path argument that names
  // exactly one ignored path is reported by `add` as "The following paths are ignored" with exit 1, even under `exclude` (measured
  // on git 2.50: dir.c exclude_matches_pathspec does not skip the magic).
  const out = await notIgnored(root, [...repos, ...unreadable], instance, withoutDeadline, harden);
  await git(root, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], instance, { stdin: addPathDetails(out), ...f });
  // Before merging a copy only if there is something to commit — a fetch is idempotent and would otherwise leave an empty commit
  // per call. `diff --cached --quiet`: exit 1 means "there is something".
  if (onlyIfNeeded && !empty) {
    let something = false;
    try { await git(root, ["diff", "--cached", "--quiet"], instance, f); } catch (e) { if (e.code !== 1) throw e; something = true; }
    if (!something) return { commit: (await git(root, ["rev-parse", "HEAD"], instance, f)).trim(), repos, unreadable, withoutCommit: true };
  }
  await git(root, ["commit", "-q", ...(empty ? ["--allow-empty"] : []), "-m", message], instance, f);
  return { commit: (await git(root, ["rev-parse", "HEAD"], instance, f)).trim(), repos, unreadable };
}

/** Takes what lies in a repo or is unreadable out of the INDEX of the project repo (the files stay; see ownCommit) — `out` as from
 *  searchProject (unreadable folders with "/"). Also for the project repo of a copy (with its instance, in the copy container). */
export async function takeFromTheIndex(root, out, { instance = null, withoutDeadline = false, harden = false } = {}) {
  const paths = out.map((u) => u.replace(/\/$/, ""));
  for (let i = 0; i < paths.length; i += RM_PER_CALL) {
    await git(root, ["--literal-pathspecs", "rm", "-r", "--cached", "-f", "-q", "--ignore-unmatch", "--", ...paths.slice(i, i + RM_PER_CALL)], instance, { withoutDeadline, harden });
  }
}

// The repo `root` lies in, or null. git itself is asked FIRST (`rev-parse --show-toplevel`): it searches from the PHYSICAL path —
// a project folder that lies in a foreign repo through a link lies there for git, and an `init` would put a second repo inside.
// If git says "no repo" (exit 128), the ancestors of the physical and of the lexical path are walked on the file system (git stops
// at file system boundaries and foreign ownership, the file system walk does not — rather too strict than too lax). Any other
// failure of git throws: "unknown" is not "no repo".
async function enclosingRepo(root, instance = null, withoutDeadline = false, harden = false) {
  try {
    const top = (await git(root, ["rev-parse", "--show-toplevel"], instance, { withoutDeadline, harden })).trim();
    if (top) return top;
  } catch (e) {
    if (e.code !== 128) throw e;
  }
  for (const start of new Set([fs.realpathSync(root), root])) {
    for (let dir = path.dirname(start); ; dir = path.dirname(dir)) {
      if (hasGitEntry(dir)) return dir;
      if (path.dirname(dir) === dir) break;
    }
  }
  return null;
}

/**
 * Creates the project repo. Only if the project folder is not a repo and does not lie in one — else `created: false` with the
 * reason (projects that are repos themselves get none). Throws if the folder is missing or a step fails (then without leftover:
 * the new `.git` is removed again). `message` is that of the first commit — "State at relocation" for a relocation, the copy's
 * own message before a copy (stacks/code-snapshot.js).
 */
export async function createProjectRepo(projectPath, { instance = null, message = FIRST_COMMIT, withoutDeadline = false, harden = false } = {}) {
  const f = { withoutDeadline, harden };
  const root = path.resolve(String(projectPath || ""));
  if (!projectPath || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Project repo: the project folder ${root} is missing or not a folder.`);
  }
  if (hasGitEntry(root)) return { created: false, reason: "repo", repo: root };
  const enclosing = await enclosingRepo(root, instance, withoutDeadline, harden);
  if (enclosing) {
    return path.resolve(enclosing) === fs.realpathSync(root)
      ? { created: false, reason: "repo", repo: root }
      : { created: false, reason: "in-repo", repo: enclosing };
  }
  try {
    await git(root, ["init", "-q", "-b", BRANCH], instance, f);
    // The marker FIRST (PROJECT_REPO_CONFIG): if a later step fails, the repo is already recognisable as the own one.
    for (const [k, v] of PROJECT_REPO_CONFIG) await git(root, ["config", "--local", k, v], instance, f);
    const hook = path.join(root, PROJECT_REPO_HOOK);
    if (instance) writeInGit(hook, PRE_COMMIT, root, 0o755);
    else {
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.writeFileSync(hook, PRE_COMMIT, { mode: 0o755 });
      fs.chmodSync(hook, 0o755);
    }
    // `--allow-empty`: a project folder that consists only of code repos and dependencies still gets its first commit — the
    // way back recognises the repo by exactly it.
    const { commit, repos, unreadable } = await ownCommit(root, String(message || FIRST_COMMIT), { empty: true, instance, withoutDeadline, harden });
    return { created: true, commit, branch: BRANCH, repos, unreadable };
  } catch (e) {
    // With an instance the container cleans up, never B (gitFolderRemove). If that fails, `.git` stays and the message says so —
    // B then does NOT delete it again.
    const rest = await gitFolderRemove(root, instance, withoutDeadline);
    if (rest && e && typeof e === "object") {
      e.message = `${e.message} — the .git just created stayed behind (${rest}); with an instance B does not remove it itself`;
      e.gitStayed = path.join(root, ".git");
    }
    throw e;
  }
}

// Removes the `.git` in the project folder — the one just created (createProjectRepo) or the own one (removeProjectRepo). WITH an
// instance the delete runs in the container of the instance (`rm -rf` through commandRun — helper or project container, whose
// mounts show only the project): B would otherwise delete recursively and by path names (`fs.rmSync` is a JS rimraf in Node 22:
// lstat, rmdir, readdir, unlink per name) in a tree that the running project container writes at the same time — a subfolder
// swapped for a link between `rmdir` and `readdir` would make B delete its target in B (DB, login, other projects). A link in the
// container resolves only in the namespace of the project, and `rm -rf` does not follow it anyway. WITHOUT an instance `fs.rmSync`.
// → null (gone) or the reason why not; never throws.
async function gitFolderRemove(root, instance, withoutDeadline = false) {
  const target = path.join(root, ".git");
  if (!instance) { try { fs.rmSync(target, { recursive: true, force: true }); return null; } catch (e) { return String(e?.message || e); } }
  let r;
  try { r = await commandRun(instance, root, "rm", ["-rf", "--", target], withoutDeadline ? { withoutDeadline: true } : { timeout: GIT_CAP_MS }); } catch (e) { return String(e?.message || e); }
  if (r.code !== 0) return `rm in container ${instance.identifier || instance.projectId}: exit ${r.code ?? r.signal}${r.cap ? `, cap ${r.cap}` : ""} ${String(r.stderr || "").trim()}`.trim();
  return hasGitEntry(root) ? `after the rm in container ${instance.identifier || instance.projectId} this still exists: ${target}` : null;
}

// With an instance the project container writes `.git/config` — B then reads the marker only without a link (git.js isProjectRepo
// `safe`, anchor the root): a FIFO there would stall B's event loop, a link would read a file of B; both mean "no marker".
const markerRead = (instance, root) => (instance ? { safe: true, anchor: root } : undefined);

/** Does the project folder carry the own project repo (marker)? Read as with an instance — without a link (stacks/ asks here,
 *  not git.js). */
export const carriesProjectRepoMarker = (projectPath) => {
  const root = path.resolve(String(projectPath || ""));
  return isProjectRepo(root, markerRead(true, root));
};

/** An own commit of cbase in the project repo (before every copy and every return). Only with the marker. */
export async function commitProjectRepo(projectPath, message, { empty = false, onlyIfNeeded = false, instance = null, withoutDeadline = false, harden = false } = {}) {
  const root = path.resolve(String(projectPath || ""));
  if (!isProjectRepo(root, markerRead(instance, root))) throw new Error(`Project repo: ${root} carries no marker — cbase commits only into its own repo.`);
  const text = String(message || "").trim();
  if (!text) throw new Error("Project repo: commit message missing.");
  return ownCommit(root, text, { empty, onlyIfNeeded, instance, withoutDeadline, harden });
}

/**
 * The way back of a relocation: removes the project repo created in THIS relocation — only with the marker and only if HEAD is
 * exactly `commit` (the first commit from createProjectRepo). If someone has committed since, it stays: then it is no longer only
 * the own one. Only `.git` goes; the files of the project stay as they are. Never throws.
 */
export async function removeProjectRepo(projectPath, { commit, instance = null } = {}) {
  const root = path.resolve(String(projectPath || ""));
  if (!isProjectRepo(root, markerRead(instance, root))) return { removed: false, reason: "without-marker" };
  if (!/^[0-9a-f]{40,64}$/.test(String(commit || ""))) return { removed: false, reason: "without-commit" };
  let head = "";
  try { head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], instance)).trim(); } catch { /* no HEAD */ }
  if (head !== commit) return { removed: false, reason: "head-continue", head };
  // With an instance in the container, never in B (gitFolderRemove).
  const rest = await gitFolderRemove(root, instance);
  if (rest) return { removed: false, reason: "error", error: rest };
  return { removed: !hasGitEntry(root) };
}
