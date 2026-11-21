// The project repo of a copy on the return path. Two halves, both called by stacks/fetch.js (fetchProjectRepo) — this
// module does not import fetch.js (no import cycle): it is handed the context `k` (fetch.js copyContext, with `k.run` =
// a command IN the copy).
//
// commitInTheCopy(k, { top }) → { commit, empty, repos } — the commit entirely IN the copy:
//   1. `upkeepExclude(…, { instance: copy, inContainer: true })`: search AND writing of `info/exclude` in the copy
//      container (projectbox/projectRepo.js EXCLUDE_PROGRAM) — with `fs` in the user container that would be the main
//      instance's file;
//   2. the found repos (also new ones of the copy) and unreadable entries out of the index (projectRepo.js
//      takeFromTheIndex, in the copy);
//   3. IN the copy (PR_SCRIPT): `add -u`, then `add` of the list "untracked, not ignored, lies in the upper layer of the
//      project folder" — never `add -A` (files of the main instance shining through would come along); `commit` WITH
//      the hook PRE_COMMIT (mode 160000) from its own `core.hooksPath` in a throwaway folder of the copy (the hook in
//      the copy's repo is foreign data — the copy could have emptied it), identity "cbase" as environment, without
//      signature. If the hook refuses: `CopyError` COPY_PROJECT_REPO_HOOK with its message — nothing is fetched.
//      Nothing staged: no commit (`empty: true`).
// mergeProjectRepo(k, { helperInst, results, start }) → { mainCommit, together } — in the return-path helper:
//   the fetched state of `refs/heads/main` of the copy (target `copy/<name>/main` or its fallback ref) is merged with
//   `merge --no-edit` after a commit in the main instance (commitProjectRepo with the helper instance, only if needed)
//   — before that the helper checks whether one of the commits the merge would bring carries a gitlink (then NEVER:
//   `together.gitlinks`); a conflict ⇒ `merge --abort`, the branch stays (`together.merged: false` with a notice).
//   Already an ancestor of HEAD ⇒ `together.already`. Per project folder only ONE merge runs at a time (a promise chain
//   per path — two copies of the same project would otherwise collide at the main instance's `index.lock`).
//   If a fetched `main` is missing, the detached tip is merged likewise (source DETACHED_SOURCE, target
//   `copy/<name>/detached`, `together.detached: true`). With a base the copy's project repo is detached on the state
//   before the commit "State before copy" (prepare.js), and commitInTheCopy commits there — without this path, what was
//   created in the copy's project root would never reach the main instance. Only if the tip descends from the copy's
//   start point `start` (fetch.js copyContext `k.start`; returnPath.js `fromOf`), otherwise `merged: false` with a notice,
//   the ref stays; without `start` likewise. The same gitlink check, the same abort on conflict. If the copy moved
//   `main` AND committed on a detached HEAD, only `main` counts (the tip stays on its ref).
//   The jobs and the fetch itself are done by fetch.js (the same path as for the code repos).
// Guards: server/backend/test/stacks-fetch.test.js; stdin as bytes: stacks-return-path-program.test.js.
import { T } from "../i18n.js";
import { PRE_COMMIT, BRANCH, commitProjectRepo, takeFromTheIndex, upkeepExclude } from "../projectbox/projectRepo.js";
import { mergeTogether, nulBytes } from "./returnPath.js";
import { PERL_HELPERS } from "./prepare.js";
import { CopyError } from "./state.js";

const HEX = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const last = (s, n = 8) => String(s || "").trim().split("\n").slice(-n).join("\n").slice(0, 1500);

// argv: message, text of the hook; stdin (NUL): the upper layer of the project folder, relative to it.
// Output `empty` or `commit=<id>`; the hook refuses ⇒ exit 40 (its message on stderr).
export const PR_SCRIPT = `${PERL_HELPERS}
my ($msg, $hooktext) = @ARGV;
my %top = map { $_ => 1 } grep { length } split /\\0/, input();
my $dir = File::Temp::tempdir("cbase-hook-XXXXXX", TMPDIR => 1, CLEANUP => 1);
open(my $h, ">", "$dir/pre-commit") or die "hook: $!\\n"; binmode $h; print $h $hooktext; close($h) or die "hook: $!\\n";
chmod(0755, "$dir/pre-commit") or die "hook: $!\\n";
my @h = ("-c", "core.hooksPath=$dir", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "commit.gpgsign=false");
run("git", @h, "add", "-u");
my @list = grep { !m{/\\z} && $top{$_} } nul("git", @h, "ls-files", "-z", "--others", "--exclude-standard");
with_stdin(join("", map { "$_\\0" } @list), "git", @h, "--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul") if @list;
my $rc = system("git", @h, "diff", "--cached", "--quiet") >> 8;
if ($rc == 0) { print "empty\\n"; exit 0; }
die "diff --cached: Exit $rc\\n" unless $rc == 1;
$ENV{GIT_AUTHOR_NAME} = $ENV{GIT_COMMITTER_NAME} = "cbase";
$ENV{GIT_AUTHOR_EMAIL} = $ENV{GIT_COMMITTER_EMAIL} = "cbase\\@cbase.invalid";
system("git", @h, "commit", "-q", "--no-gpg-sign", "-m", $msg) == 0 or exit 40;
my $c = with_stdin("", "git", "rev-parse", "HEAD"); chomp $c;
print "commit=$c\\n";
`;

export async function commitInTheCopy(k, { top = [] } = {}) {
  const inst = k.inst();
  if (!inst?.containerId) throw new CopyError(T`Copy ${k.pid}/${k.instance}: no instance row with a container`, { code: "COPY_STANDS", status: 500 });
  const { repos, unreadable } = await upkeepExclude(k.projectPath, { instance: inst, inContainer: true });
  await takeFromTheIndex(k.projectPath, [...repos, ...unreadable], { instance: inst });
  const r = await k.run(k.projectPath, "perl", ["-e", PR_SCRIPT, `cbase: state of copy ${k.name}`, PRE_COMMIT], {
    stdin: nulBytes(top), what: T("the commit in the copy's project repo"), // names as bytes (returnPath.js nulBytes)
  });
  if (r.code === 40) {
    throw new CopyError(T`Project repo of the copy ${k.name}: the hook refuses the commit — nothing fetched:\n${last(r.stderr)}`, { code: "COPY_PROJECT_REPO_HOOK", status: 409 });
  }
  if (r.code !== 0) throw new CopyError(T`Project repo of the copy ${k.name}: commit failed (exit ${r.code ?? r.signal}): ${last(r.stderr, 3)}`, { code: "COPY_PROJECT_REPO", status: 500 });
  const out = String(r.stdout || "").trim();
  if (out === "empty") return { commit: null, empty: true, repos };
  const m = /^commit=([0-9a-f]+)$/.exec(out);
  if (!m || !HEX.test(m[1])) throw new CopyError(T`Project repo of the copy ${k.name}: unexpected output ${JSON.stringify(out.slice(0, 120))}`, { code: "COPY_PROJECT_REPO", status: 500 });
  return { commit: m[1], empty: false, repos };
}

// Commit and merge into the main instance's project repo run ONE AFTER ANOTHER per project folder — two copies of the
// same project that are fetched or cleared away at the same time would otherwise collide at the main instance's
// `index.lock`. A promise chain per path that cleans up after itself.
const queue = new Map();
const waiting = new Map();
/** How many merges of this project folder still wait for their predecessor (insight for the guard stacks-fetch). */
export const waitingMerges = (projectPath) => waiting.get(projectPath) || 0;
async function sequential(key, fn) {
  const prior = queue.get(key) || Promise.resolve();
  waiting.set(key, (waiting.get(key) || 0) + 1);
  const go = () => { const n = (waiting.get(key) || 1) - 1; if (n) waiting.set(key, n); else waiting.delete(key); return fn(); };
  const run = prior.then(go, go);
  const end = run.then(() => {}, () => {});
  queue.set(key, end);
  try { return await run; } finally { if (queue.get(key) === end) queue.delete(key); }
}

export function mergeProjectRepo(k, opts) {
  return sequential(k.projectPath, () => merge(k, opts));
}

/** The source under which fetch.js jobsFor fetches the detached tip (target `copy/<name>/detached`). */
export const DETACHED_SOURCE = "refs/cbase/detached";

async function merge(k, { helperInst, results, start = null }) {
  // What is merged: the copy's `main`, otherwise its detached tip (with a base the copy's project repo is detached, and
  // cbase committed there), which may only sit on top of the start point `start`.
  const main = results.find((e) => e.ok && e.source === `refs/heads/${BRANCH}`);
  const detachedRef = main ? null : results.find((e) => e.ok && e.source === DETACHED_SOURCE);
  const source = main || detachedRef;
  if (!source) return { mainCommit: null, together: null };
  const mark = detachedRef ? { detached: true } : {};
  if (detachedRef && !HEX.test(String(start || ""))) {
    return { mainCommit: null, together: { target: detachedRef.target, ...mark, merged: false, notice: T("not merged: the copy has no start point in the project repo — the detached tip stays on its ref") } };
  }
  const check = await mergeTogether({ helperInst, projectPath: k.projectPath, target: source.target, oid: source.oid, onlyCheck: true, ...(detachedRef ? { fromOf: start } : {}) });
  if (check.already) return { mainCommit: null, together: { target: source.target, ...mark, already: true } };
  if (check.foreign) return { mainCommit: null, together: { target: source.target, ...mark, merged: false, notice: T`not merged: the detached tip ${check.notice || T("does not descend from the copy's start point")} — it stays on its ref` } };
  if (check.gitlinks) return { mainCommit: null, together: { target: source.target, ...mark, merged: false, gitlinks: check.gitlinks } };
  const h = await commitProjectRepo(k.projectPath, `cbase: state before merging the copy ${k.name}`, { onlyIfNeeded: true, instance: helperInst });
  const r = await mergeTogether({ helperInst, projectPath: k.projectPath, target: source.target, oid: source.oid });
  return {
    mainCommit: h.withoutCommit ? null : h.commit,
    together: r.already ? { target: source.target, ...mark, already: true } : { target: source.target, ...mark, merged: r.merged === true, ...(r.notice ? { notice: r.notice } : {}) },
  };
}
