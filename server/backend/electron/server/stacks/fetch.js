// Fetch. Afterwards the commits of a copy lie in main without loss, without touching the checked-out branch of a code repo.
//
// NO GIT IN B. What the copy knows (refs, HEAD, worktrees, embedded repos, WIP, bundles, the commit in the project repo) is
// asked by a command INSIDE the running copy (`k.run`: runtime/git-run.js commandRun with its instance row, as agent — git
// may read the copy's configuration there); what goes into main is written by the return-path helper
// (stacks/returnPath.js) as agent. B checks every line before it is passed on (ref names like `refValid` of the code
// snapshot, ids hexadecimal, paths in form, no U+FFFD).
//
// copyFetch(copyId, { retrieve, home, system, data }) → result (REST fetch route of a copy, idempotent)
//   Only in ops mode, only for a copy in `ready` with its instance row `ready`, under the instance occupancy “copy-fetch” (a
//   clear-away or re-creation of the same copy never runs alongside: OCCUPIED, 409). fetchEverything in this order, ONE helper:
//     1. the upper layer per part (upperLists) and the new repos (newRepos: the search INSIDE the copy — projectRepo.js
//        searchProject with its instance — and per code repo the embedded ones from `ls-files --others`; plus an embedded
//        repo of the snapshot (`notLinked`, `embedded`) under which something lies in the upper layer — it shows through in
//        the copy including `.git`, and what happened there would otherwise live only in the layer; and EVERY folder into
//        whose `.git` the copy wrote — a repo inside a new repo, below an ignored folder, a named one);
//     2. per new repo the backup (WIP, see below) and `git bundle create - --all` INSIDE the copy as a stream into the
//        backup folder as `n<j>.bundle` (docker.js stdoutFile, cap with message BUNDLE_CAP). `j` is fixed per path (journal
//        section `fetch`, `fresh`: { rel: j }, written BEFORE the first bundle) — a second fetch overwrites the same bundle,
//        never a foreign one. A repo numbered earlier without a bundle that is no longer among the new ones is looked up
//        INSIDE the copy (REPO_EXISTS) — bundled, `gitfile` or `gone`;
//     3. the project repo (fetchProjectRepo): the commit entirely INSIDE the copy (stacks/project-repo-copy.js), then fetched
//        like a code repo, then its LFS objects (only this commit makes the clean filter run), then merged in the helper —
//        `main`, otherwise the detached tip above the start point `k.start` (with a base the copy's project repo is detached);
//     4. per code repo: only branches that are new or moved compared with the state at freeze time, plus a detached HEAD
//        that sits on no branch head and is not the start point of the copy (target `copy/<name>/detached`) — target
//        `refs/heads/copy/<name>/<b>` without `+`, rejected ⇒ `<b>-<n>` (stacks/returnPath.js fetchIntoMain). Plus (jobsFor)
//        every stash entry (`stash-<n>`), the HEAD of every detached linked worktree (`detached-<wt-id>`), new/moved tags
//        (`refs/tags/copy/<name>/…`, an annotated one as a tag object) and notes (`refs/notes/copy/<name>/…`). The contract
//        “only refs under `refs/heads/copy/<name>/`” holds for commits; tags and notes carry the same space `copy/<name>/`
//        under their own kind (refs/heads does not accept a tag object). “Stashes do not come along” means the direction
//        main → copy, not back;
//     5. LFS: new LFS objects of the copy, content-addressed, into main (returnPath.js copyLfs);
//     6. `retrieve: [<rel>]`: per new repo clone the bundle onto a FREE path (a path out of form, an occupied one or one
//        that is no backed-up repo is listed under `denied`).
//   Result: `{ repos: [{ part, rel, fetched, error }], projectRepo, newRepos, lfs, retrieved, denied, trap }` — `fetched`
//   per ref `{ source, target, oid, fallback, prior }` (fallback > 0 ⇒ fallback ref), `trap` the trap of the open changes
//   that came along: per fetched ref the paths of the tar from the freeze (open.paths + erase) that its commits change
//   since the start of the copy — in main they are still open, a merge runs into them.
//
// WIP INSIDE the copy, per target an index of its own `<gitdir>/cbase-wip.index` (GIT_INDEX_FILE): `read-tree HEAD`
//   (unborn: `--empty`), `add -u`, `add` of the list “untracked, not ignored, lies in the upper layer” (`ls-files --others
//   --exclude-standard` ∩ the upper layer from the return-path helper — mode `all` without the intersection, for a worktree
//   of the copy: it does not lie in the overlay), `write-tree`, `commit-tree -p HEAD --no-gpg-sign` with identity “cbase”
//   and a FIXED date (`time` — the same state yields the same id: a second run fetches nothing new), without hooks
//   (`core.hooksPath=/dev/null`), `update-ref refs/cbase/wip/<id>` (`clone` or `wt-<worktree>` — per target a ref of its
//   own: otherwise a worktree would overwrite the backup of the previous one). HEAD and index of the copy stay. Tree equal
//   to HEAD ⇒ no WIP.
//   The list goes through stdin as BYTES (returnPath.js nulBytes): a name of the layer that is not UTF-8 arrives the way
//   it lies in the copy.
//
// The building blocks (also for the clear-away, stacks/clearAway.js): copyContext, statusOfTheCopy, statusesOfTheCopy,
// jobsFor, trapOf, fetchedFrom, fetchRepo, partOf, upperLists, topUnder, newRepos, wip, saveNewRepos, backedUpRepos,
// fetchProjectRepo, fetchCodeRepos, fetchLfs, retrieveRepos, pathError, fetchEverything; the targets copyTarget,
// copyTagTarget, copyNoteTarget; the scripts COPY_STATUS, WIP, BUNDLE, REPO_EXISTS; wipMessageNew (the post-check of the
// clear-away recomputes the WIP of a new repo with the same message).
// Guard of the losslessness gaps: server/backend/test/stacks-lossless.test.js.
//
// Caps (ESTIMATED, NOT MEASURED): per command in the copy FETCH_CAP_MS (knob CBASE_COPY_FETCH_MS), per bundle BUNDLE_CAP
// bytes (knob CBASE_COPY_BUNDLE_CAP).
// Guards: server/backend/test/stacks-fetch.test.js; stdin as bytes: stacks-return-path-program.test.js.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from "../store.js";
import { DIRS } from "../app-state.js";
import { containerName, copyInstance } from "../projectbox/creation.js";
import { projectboxOps } from "../projectbox/ops.js";
import { execIn } from "../projectbox/docker.js";
import { withInstanceOccupancy } from "../projectbox/instance.js";
import { searchProject } from "../projectbox/projectRepo.js";
import { commandRun, containerStands } from "../runtime/git-run.js";
import { readSnapshot } from "./build.js";
import { refValid } from "./code-snapshot.js";
import { createBackup, dismissBackupFile } from "./objects.js";
import { copyLocation } from "./location.js";
import { DETACHED_SOURCE, commitInTheCopy, mergeProjectRepo } from "./project-repo-copy.js";
import { fetchIntoMain, clonesBundle, copyLfs, withReturnPathHelper, nameBytes, nameRelValid, nulBytes, relValid, layerList } from "./returnPath.js";
import { PERL_HELPERS } from "./prepare.js";
import { CopyError, copyJournal } from "./state.js";
import { T } from "../i18n.js";

export const FETCH_CAP_MS = 300_000;
export const BUNDLE_CAP = 2 * 1024 ** 3;
const count = (raw, preset) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : preset; };
export const fetchCapMs = () => count(process.env.CBASE_COPY_FETCH_MS, FETCH_CAP_MS);
const bundleCap = () => count(process.env.CBASE_COPY_BUNDLE_CAP, BUNDLE_CAP);
const HEX = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const last = (s, n = 3) => String(s || "").trim().split("\n").slice(-n).join(" | ").slice(0, 600);
const text = (e) => String(e?.message || e || "unknown").split("\n")[0].slice(0, 400);
export const copyTarget = (name, rest) => `refs/heads/copy/${name}/${rest}`;
export const copyTagTarget = (name, rest) => `refs/tags/copy/${name}/${rest}`;
export const copyNoteTarget = (name, rest) => `refs/notes/copy/${name}/${rest}`;

// ── The commands INSIDE the copy (perl, the same helpers as stacks/prepare.js) ──────────────────────────────────────────

// A name from git (path of an embedded repo, of a worktree) is BYTES. If it is not UTF-8 or carries `\n`/`\r`, it goes out
// as `<UPPER> <json>` — JSON text, every invalid byte 0x80–0xFF as `\udcXX` (surrogateescape, like the list of
// returnPath.js); B turns it back into exactly those bytes with nameBytes. Otherwise raw `<lower> <name>`.
export const NAME_HELPERS = String.raw`
my $U8 = qr/[\x00-\x7f]|[\xc2-\xdf][\x80-\xbf]|\xe0[\xa0-\xbf][\x80-\xbf]|[\xe1-\xec\xee\xef][\x80-\xbf]{2}|\xed[\x80-\x9f][\x80-\xbf]|\xf0[\x90-\xbf][\x80-\xbf]{2}|[\xf1-\xf3][\x80-\xbf]{3}|\xf4[\x80-\x8f][\x80-\xbf]{2}/;
sub raw_ok { my ($b) = @_; return $b !~ /[\n\r]/ && $b =~ /\A(?:$U8)*\z/; }
sub jname {
  my ($b) = @_; my $o = "";
  while ((pos($b) // 0) < length $b) {
    if ($b =~ /\G([\x00-\x7f])/gc) { my $c = $1; $o .= $c eq '"' ? '\"' : $c eq "\\" ? '\\\\' : (ord($c) < 0x20 || ord($c) == 0x7f) ? sprintf('\u%04x', ord $c) : $c; }
    elsif ($b =~ /\G($U8)/gc) { $o .= $1; }
    else { $b =~ /\G(.)/gcs; $o .= sprintf('\udc%02x', ord $1); }
  }
  return '"' . $o . '"';
}
sub set { my ($kind, $b) = @_; print(raw_ok($b) ? "$kind $b\0" : uc($kind) . " " . jname($b) . "\0"); }
`;

// The state of a repo: NUL-separated records `r <ref> <id>` (refs/heads), `t <ref> <id>` (refs/tags — the id of an
// annotated tag is that of the tag object), `n <ref> <id>` (refs/notes), `z <n> <id>` (the n-th stash entry, `stash@{n}` —
// only in the reflog of refs/stash), `s <symref|>`, `h <id|>`, `w <path>` (linked worktrees, not prunable) and right after
// it `x <0|1> <id|-> <wt-id>` (detached?, its HEAD, the name of its administrative folder below the repo's worktrees
// folder — empty if not readable), `e <rel>` or `g <rel>` (a non-ignored folder with `.git` — a folder or a
// gitfile/symlink). `w`, `e`, `g` for a name that is not UTF-8 or carries `\n`/`\r` come as `W <json>`/`E <json>`/`G <json>`
// (NAME_HELPERS). `l <n> <id>` per tip that ONLY a reflog holds (S = `rev-list --reflog --not --all`, tip = commit in S
// without a child in S, without the stash entries; oldest first — a new find does not shift the numbers of the old ones) —
// a `reset --hard` or a deleted branch of the copy would otherwise lose the commit when the copy is removed.
// Without stash, tags, notes and detached worktrees here, a stash without `pop`, a tag on a commit without a branch, notes
// and the commits of a detached worktree with a clean tree would be lost silently on removal.
export const COPY_STATUS = `${PERL_HELPERS}${NAME_HELPERS}
binmode STDOUT;
sub row { my @c = @_; open(my $p, "-|", @c) or die "$c[0]: $!\\n"; binmode $p; my $o = do { local $/; <$p> }; close $p;
  my $rc = $? >> 8; $o = "" unless defined $o; chomp $o; return ($rc, $o); }
my ($rc, $o) = row("git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags", "refs/notes");
exit 21 if $rc;
for (grep { length } split /\\n/, $o) { print((m{^refs/heads/} ? "r" : m{^refs/tags/} ? "t" : "n") . " $_\\0"); }
my %stash;
(undef, $o) = row("git", "rev-parse", "-q", "--verify", "refs/stash");
if (length $o) {
  my $s0 = $o;
  ($rc, $o) = row("git", "log", "-g", "--no-show-signature", "--format=%H", "refs/stash", "--");
  exit 27 if $rc;
  my @s = grep { length } split /\\n/, $o;
  @s = ($s0) unless @s;
  my $n = 0; print "z " . $n++ . " $_\\0" for @s;
  $stash{$_} = 1 for @s;
}
($rc, $o) = row("git", "rev-list", "--reflog", "--parents", "--reverse", "--not", "--all");
exit 28 if $rc;
{
  my (@order, %in, %parents);
  for my $z (grep { length } split /\\n/, $o) { my ($c, @p) = split / /, $z; push @order, $c; $in{$c} = 1; $parents{$_} = 1 for @p; }
  my $n = 0;
  for my $c (@order) { next if $parents{$c} || $stash{$c}; print "l " . $n++ . " $c\\0"; }
}
(undef, $o) = row("git", "symbolic-ref", "-q", "HEAD"); print "s $o\\0";
(undef, $o) = row("git", "rev-parse", "-q", "--verify", "HEAD"); print "h $o\\0";
($rc, $o) = row("git", "worktree", "list", "--porcelain", "-z");
exit 26 if $rc;
my ($first, $path, $prunable, $head_id, $detached) = (1, undef, 0, "-", 0);
for my $z (split /\\0/, $o, -1) {
  if ($z eq "") {
    if (defined $path) {
      unless ($first || $prunable) {
        my $id = "";
        if (open(my $g, "<", "$path/.git")) { my $t = do { local $/; <$g> }; close $g; $id = $1 if defined $t && $t =~ m{/worktrees/([^/\\n\\r]+?)[\\n\\r]*\\z}; }
        set("w", $path); print "x $detached $head_id $id\\0";
      }
      $first = 0;
    }
    undef $path; $prunable = 0; $head_id = "-"; $detached = 0; next;
  }
  if ($z =~ /^worktree (.*)\\z/s) { $path = $1; } elsif ($z =~ /^prunable/) { $prunable = 1; }
  elsif ($z =~ /^HEAD ([0-9a-f]+)\\z/) { $head_id = $1; } elsif ($z eq "detached") { $detached = 1; }
}
for my $e (nul("git", "ls-files", "-z", "--others", "--exclude-standard")) {
  next unless $e =~ m{/\\z};
  my $d = substr($e, 0, -1);
  set((-d "$d/.git" && ! -l "$d/.git") ? "e" : "g", $d);
}
`;

// WIP (header) — argv: mode (top|all), time (seconds), message, kind (clone|wt); stdin (NUL): FIRST the target (the repo
// or the worktree, absolute or relative to the cwd = project folder — as BYTES, the script changes into it itself; a cwd
// as text would lose a name that is not UTF-8), then the upper layer, relative to the repo. Output: `wip=<id>`/`empty`,
// `id=<clone|wt-…>`, `count=<n>`; `gitfile` (no `.git` folder of its own), `no-worktree`. A target it cannot change into
// is an error with its name (never skipped).
export const WIP = `${PERL_HELPERS}
my ($mode, $time, $msg, $kind) = @ARGV;
my @items = split /\\0/, input(), -1;
my $target = shift @items;
die "no target\\n" unless defined $target && length $target;
chdir $target or die "chdir $target: $!\\n";
my %top = map { $_ => 1 } grep { length } @items;
if ($kind eq "clone" && (! -d ".git" || -l ".git")) { print "gitfile\\n"; exit 0; }
my @h = ("-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false");
my $gd = with_stdin("", "git", "rev-parse", "--absolute-git-dir"); chomp $gd;
my $id = "clone";
if ($kind eq "wt") { if ($gd =~ m{/worktrees/([^/]+)\\z}) { $id = "wt-$1"; } else { print "no-worktree\\n"; exit 0; } }
my $idx = "$gd/cbase-wip.index";
unlink $idx;
$ENV{GIT_INDEX_FILE} = $idx;
my $head = "";
{ open(my $p, "-|", "git", "rev-parse", "-q", "--verify", "HEAD^{commit}") or die "rev-parse: $!\\n"; $head = do { local $/; <$p> }; close $p;
  $head = "" unless defined $head && $? == 0; chomp $head; }
if (length $head) { run("git", @h, "read-tree", $head); } else { run("git", @h, "read-tree", "--empty"); }
run("git", @h, "add", "-u");
my @files = grep { !m{/\\z} } nul("git", @h, "ls-files", "-z", "--others", "--exclude-standard");
@files = grep { $top{$_} } @files if $mode eq "top";
with_stdin(join("", map { "$_\\0" } @files), "git", @h, "--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul") if @files;
my $tree = with_stdin("", "git", @h, "write-tree"); chomp $tree;
my $old_tree = "";
if (length $head) { $old_tree = with_stdin("", "git", "rev-parse", "$head^{tree}"); chomp $old_tree; }
else { $old_tree = with_stdin("", "git", "hash-object", "-t", "tree", "--stdin"); chomp $old_tree; }
if ($tree eq $old_tree) { unlink $idx; print "empty\\nid=$id\\n"; exit 0; }
$ENV{GIT_AUTHOR_NAME} = $ENV{GIT_COMMITTER_NAME} = "cbase";
$ENV{GIT_AUTHOR_EMAIL} = $ENV{GIT_COMMITTER_EMAIL} = "cbase\\@cbase.invalid";
$ENV{GIT_AUTHOR_DATE} = $ENV{GIT_COMMITTER_DATE} = "$time +0000";
my $c = with_stdin($msg, "git", @h, "commit-tree", "--no-gpg-sign", $tree, (length $head ? ("-p", $head) : ())); chomp $c;
run("git", @h, "update-ref", "refs/cbase/wip/$id", $c);
unlink $idx;
print "wip=$c\\nid=$id\\ncount=" . scalar(@files) . "\\n";
`;

// The bundle of a new repo on stdout — argv: the project folder (text), the repo RELATIVE to it as HEX of its bytes
// (`docker exec` passes no stdin through, and an argv as text would lose a name that is not UTF-8), the cap in bytes. Above
// the cap exit 36 (B discards the half file), a failing `bundle` exit 30, a repo without any ref exit 37 (`git bundle`
// rejects an empty one — and there is nothing to lose in it).
export const BUNDLE = String.raw`
use strict; use warnings;
my ($root, $hex, $cap) = @ARGV;
exit 38 unless defined $hex && $hex =~ /\A(?:[0-9a-f]{2})+\z/;
chdir $root or exit 39;
my $d = pack("H*", $hex);
open(my $c, "-|", "git", "-C", $d, "for-each-ref", "--count=1", "--format=x") or exit 31;
my $first_ref = do { local $/; <$c> }; close $c;
exit 30 if $? >> 8;
exit 37 unless defined $first_ref && length $first_ref;
open(my $p, "-|", "git", "-C", $d, "bundle", "create", "-", "--all") or exit 31;
binmode $p; binmode STDOUT;
my ($n, $buf) = (0, "");
while (1) { my $k = read($p, $buf, 1 << 20); last unless $k; $n += $k; if ($n > $cap) { close $p; exit 36; } print STDOUT $buf; }
close $p;
exit(($? >> 8) ? 30 : 0);
`;

// ── The context ─────────────────────────────────────────────────────────────────────────────────────────────────────

const error = (msg, code = "COPY_FETCH", status = 500) => new CopyError(msg, { code, status });

/** Instance, location, snapshot, project folder, start point per repo — and `run`: a command INSIDE the copy. */
export function copyContext(copy, { data = null } = {}) {
  const pid = String(copy.projectId);
  const instance = copyInstance(copy.name);
  const projectPath = store.getProject(pid)?.path;
  if (!projectPath) throw error(T`Project ${pid} has no path`);
  const d = data || DIRS.data;
  const location = copyLocation({ data: d, projectId: pid, name: copy.name });
  const snapshot = readSnapshot(location);
  // The start point per repo: the base of the preparation, otherwise the HEAD of the snapshot.
  const prepared = new Map((copy.journal?.data?.prepare?.result || []).map((e) => [e.part, e.base]));
  const start = new Map(snapshot.repos.map((r) => [r.part, HEX.test(String(prepared.get(r.part) || "")) ? prepared.get(r.part) : r.head?.oid || null]));
  const k = {
    copy, pid, name: copy.name, instance, projectPath, location, snapshot, start, data: d,
    container: containerName(pid, instance),
    inst: () => store.projectInstance(pid, instance),
    pathOf: (rel) => (rel === "." ? projectPath : path.join(projectPath, rel)),
  };
  k.run = (cwd, cmd, args, opts) => inTheCopy(k, cwd, cmd, args, opts);
  return k;
}

// A command INSIDE the copy (as agent, commandRun with its instance row); if the container is stopped, `COPY_STANDS`.
async function inTheCopy(k, cwd, cmd, args, { stdin, what } = {}) {
  const inst = k.inst();
  if (!inst?.containerId) throw error(T`Copy ${k.pid}/${k.instance}: no instance row with a container`, "COPY_STANDS");
  const r = await commandRun(inst, cwd, cmd, args, {
    timeout: fetchCapMs(), maxBuffer: 64 * 1024 * 1024, env: { GIT_TERMINAL_PROMPT: "0" }, envAlways: ["GIT_TERMINAL_PROMPT"],
    ...(stdin === undefined ? {} : { stdin }),
  });
  if (containerStands(r)) throw error(T`Copy ${k.pid}/${k.instance} is not running (${last(r.stderr, 1)}) — ${what || cmd} needs it`, "COPY_STANDS");
  return r;
}

// ── The state of the copy ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The output of COPY_STATUS, read (pure, exported for the guard). `E`/`G`/`W` with a JSON name (bytes in surrogateescape
 * form) — `e`/`g` from it are checked by nameRelValid (a surrogate is allowed, U+FFFD never); a worktree whose path cannot
 * be passed as text becomes a FINDING (`findings`) and is skipped for the backup of its open work — its HEAD (record `x`)
 * still counts (wtHeads, `path: null`) instead of the whole state being discarded. The U+FFFD block applies to the
 * lower-case form (there it would mean: git passed on something raw that was not UTF-8).
 */
export function stateFromOutput(stdout, where) {
  const st = { refs: new Map(), tags: new Map(), notes: new Map(), stash: [], reflog: [], symref: null, head: null, worktrees: [], wtHeads: [], embedded: [], gitfile: [], findings: [] };
  const broken = (s) => error(T`${where}: unexpected line ${JSON.stringify(String(s).slice(0, 120))} from the copy — not taken over`);
  const SPACE = { r: ["refs/heads/", st.refs], t: ["refs/tags/", st.tags], n: ["refs/notes/", st.notes] };
  const SKIPPED = Symbol("skipped");
  let lastWt = null;
  for (const s of String(stdout || "").split("\0")) {
    if (!s) continue;
    if (s[1] !== " ") throw broken(s);
    if ("EGW".includes(s[0])) {
      let name = null;
      try { name = JSON.parse(s.slice(2)); } catch { /* below */ }
      if (typeof name !== "string") throw broken(s);
      if (s[0] === "W") {
        if (!path.isAbsolute(name) || name.includes("\0")) throw broken(s);
        st.findings.push({ worktree: name, reason: T("path is not UTF-8 or carries a line break — its open work is not backed up (its HEAD is)") });
        lastWt = SKIPPED;
        continue;
      }
      if (!nameRelValid(name)) throw broken(s);
      (s[0] === "E" ? st.embedded : st.gitfile).push(name);
      continue;
    }
    if (s.includes("\ufffd")) throw broken(s);
    const value = s.slice(2);
    switch (s[0]) {
      case "r": case "t": case "n": {
        const [space, target] = SPACE[s[0]];
        const [n, o, ...rest] = value.split(" ");
        if (rest.length || !refValid(n) || !n.startsWith(space) || !HEX.test(o || "")) throw broken(s);
        target.set(n, o);
        break;
      }
      case "z": {
        const [n, o, ...rest] = value.split(" ");
        if (rest.length || n !== String(st.stash.length) || !HEX.test(o || "")) throw broken(s);
        st.stash.push(o);
        break;
      }
      case "s": if (value && !refValid(value)) throw broken(s); st.symref = value || null; break;
      case "h": if (value && !HEX.test(value)) throw broken(s); st.head = value || null; break;
      case "w": if (!path.isAbsolute(value) || /[\n\r]/.test(value)) throw broken(s); st.worktrees.push(value); lastWt = value; break;
      case "l": {
        const [n, o, ...rest] = value.split(" ");
        if (rest.length || n !== String(st.reflog.length) || !HEX.test(o || "")) throw broken(s);
        st.reflog.push(o);
        break;
      }
      case "x": {
        const m = /^([01]) (-|[0-9a-f]{40}|[0-9a-f]{64}) ([^\n\r/]*)$/.exec(value);
        if (!m || lastWt === null) throw broken(s);
        st.wtHeads.push({ path: lastWt === SKIPPED ? null : lastWt, detached: m[1] === "1", head: m[2] === "-" ? null : m[2], id: m[3] });
        lastWt = null;
        break;
      }
      case "e": case "g": if (!relValid(value)) throw broken(s); (s[0] === "e" ? st.embedded : st.gitfile).push(value); break;
      default: throw broken(s);
    }
  }
  return st;
}

export async function statusOfTheCopy(k, repo) {
  const r = await k.run(k.pathOf(repo.rel), "perl", ["-e", COPY_STATUS], { what: T`the state of ${repo.rel}` });
  if (r.code !== 0) throw error(T`${repo.rel}: state in the copy cannot be read (exit ${r.code ?? r.signal}): ${last(r.stderr)}`);
  return stateFromOutput(r.stdout, repo.rel);
}

/** The state per repo INSIDE the copy (Map part → state). */
export async function statusesOfTheCopy(k) {
  const statuses = new Map();
  for (const repo of k.snapshot.repos) statuses.set(repo.part, await statusOfTheCopy(k, repo));
  return statuses;
}

/**
 * The fetch jobs of a repo — new and moved branches, a detached HEAD outside every branch head. Also what would otherwise
 * hang only in the copy (header, item 4):
 *   - every stash entry (`stash@{n}`, the commit brings its index and untracked parents) → `copy/<name>/stash-<n>`;
 *   - every tip that only a reflog holds (COPY_STATUS `l`) → `copy/<name>/reflog-<n>` (`onlyNew` like a stash);
 *   - the HEAD of every DETACHED linked worktree that sits on no branch head and is not the start point →
 *     `copy/<name>/detached-<wt-id>` (without a readable name `detached-wt<i>`);
 *   - new and moved tags → `refs/tags/copy/<name>/<tag>` (an annotated tag as a tag object — git puts nothing meant as a
 *     commit under refs/heads, and message and signature stay);
 *   - new and moved notes → `refs/notes/copy/<name>/<ref>` (readable with `git notes --ref=copy/<name>/<ref>`).
 *   Stash and tags `onlyNew` (a backup never pushes anything forward — occupied ⇒ fallback ref); notes like branches.
 */
export function jobsFor(k, repo, state) {
  const old = new Map((repo.refs || []).map((r) => [r.name, r.oid]));
  const start = k.start.get(repo.part) || null;
  const jobs = [];
  for (const [n, oid] of state.refs) {
    if (old.get(n) === oid) continue;
    jobs.push({ source: n, target: copyTarget(k.name, n.slice("refs/heads/".length)), oid, base: old.get(n) || start });
  }
  const headers = new Set(state.refs.values());
  if (!state.symref && state.head && state.head !== start && !headers.has(state.head)) {
    jobs.push({ source: DETACHED_SOURCE, target: copyTarget(k.name, "detached"), oid: state.head, base: start });
  }
  (state.stash || []).forEach((oid, i) => {
    jobs.push({ source: `refs/cbase/stash-${i}`, target: copyTarget(k.name, `stash-${i}`), oid, onlyNew: true });
  });
  // Tips that only a reflog holds (COPY_STATUS `l`) — fetched new like stashes, never pushed forward.
  (state.reflog || []).forEach((oid, i) => {
    jobs.push({ source: `refs/cbase/reflog-${i}`, target: copyTarget(k.name, `reflog-${i}`), oid, onlyNew: true });
  });
  const taken = new Set([state.head].filter(Boolean));
  (state.wtHeads || []).forEach((w, i) => {
    if (!w.detached || !w.head || w.head === start || headers.has(w.head) || taken.has(w.head)) return;
    taken.add(w.head);
    const id = w.id && refValid(copyTarget(k.name, `detached-${w.id}`)) && refValid(`refs/cbase/detached-${w.id}`) ? w.id : `wt${i}`;
    jobs.push({ source: `refs/cbase/detached-${id}`, target: copyTarget(k.name, `detached-${id}`), oid: w.head, base: start });
  });
  for (const [n, oid] of state.tags || []) {
    if (old.get(n) === oid) continue;
    jobs.push({ source: n, target: copyTagTarget(k.name, n.slice("refs/tags/".length)), oid, onlyNew: true });
  }
  for (const [n, oid] of state.notes || []) {
    if (old.get(n) === oid) continue;
    jobs.push({ source: n, target: copyNoteTarget(k.name, n.slice("refs/notes/".length)), oid });
  }
  return jobs;
}

/** The trap of a fetched ref: the paths of the tar (open.paths + erase) that its commits change since the start. */
export function trapOf(repo, e) {
  const open = new Set([...(repo.open?.paths || []), ...(repo.open?.erase || [])]);
  if (!open.size || !Array.isArray(e.paths)) return [];
  return e.paths.filter((p) => open.has(p)).sort();
}

/** The results of fetchIntoMain in the form of the result: fetched, error, trap. */
export function fetchedFrom(repo, results) {
  const fetched = [];
  const errorList = [];
  const trap = [];
  for (const e of results) {
    if (e.ok) {
      fetched.push({ source: e.source, target: e.target, oid: e.oid, fallback: e.fallback, prior: e.prior });
      const f = trapOf(repo, e);
      if (f.length) trap.push({ rel: repo.rel, target: e.target, paths: f });
    } else errorList.push({ source: e.source, notice: e.notice || "unknown" });
  }
  return { fetched, error: errorList, trap };
}

/** Fetches the jobs of a repo into main — the refs for it are exactly the sources of the jobs. */
export async function fetchRepo(k, { helperInst, repo, jobs }) {
  const results = await fetchIntoMain({
    helperInst, location: k.location, part: repo.part, mainPath: k.pathOf(repo.rel),
    refs: jobs.map((a) => [a.source, a.oid]), jobs,
  });
  return { results, ...fetchedFrom(repo, results) };
}

/** Step 4 for every code repo (not the project repo). */
export async function fetchCodeRepos(k, { helperInst, statuses }) {
  const out = [];
  for (const repo of k.snapshot.repos.filter((r) => !r.projectRepo)) {
    const state = statuses.get(repo.part) || await statusOfTheCopy(k, repo);
    const { results: _e, ...r } = await fetchRepo(k, { helperInst, repo, jobs: jobsFor(k, repo, state) });
    out.push({ part: repo.part, rel: repo.rel, ...r, ...(state.findings?.length ? { findings: state.findings } : {}) });
  }
  return out;
}

// ── The upper layer, new repos ──────────────────────────────────────────────────────────────────────────────────────

export const under = (rel, top) => top === "." || rel === top || rel.startsWith(`${top}/`);
export const relTo = (rel, top) => (top === "." ? rel : rel === top ? "." : rel.slice(top.length + 1));
const full = (partRel, x) => (partRel === "." ? x : `${partRel}/${x}`);

/** The part of the snapshot in whose upper layer a path (relative to the project folder) lies: the deepest repo, otherwise p. */
export function partOf(k, rel) {
  let best = { part: "p", rel: "." };
  for (const r of k.snapshot.repos) {
    if (r.rel !== "." && under(rel, r.rel) && (best.rel === "." || r.rel.length > best.rel.length)) best = r;
  }
  return best;
}

/**
 * Per part the upper layer (returnPath.js layerList), every entry `{ part, rel, inPart }` — `rel` relative to the PROJECT
 * FOLDER, `inPart` relative to the part —, without the `.git` of the part and without the mount points of other parts.
 * Entries with a path component `.git` (the `.git` of a new or embedded repo) are not in `files` but yield `gitInside` (the
 * folders into whose `.git` the copy wrote). `parts`: `{ part, rel, path }` per listed part. `depIncomplete`: the
 * dependency folders in which the search for `.git` stopped at the cap.
 */
export async function upperLists(k, helper) {
  const out = { parts: [], files: [], dependent: [], deleted: [], opaque: [], special: [], unreadable: [], depIncomplete: [], gitInside: new Set() };
  const parts = [{ part: "p", rel: "." }, ...k.snapshot.repos.filter((r) => r.part !== "p")];
  for (const t of parts) {
    const filePath = k.location.root.layer(t.part);
    if (!fs.existsSync(filePath)) continue;
    const inner = k.snapshot.repos.filter((r) => r.part !== t.part && r.rel !== t.rel && under(r.rel, t.rel)).map((r) => relTo(r.rel, t.rel));
    const l = await layerList(helper, filePath, { without: [".git", ...inner] });
    out.parts.push({ part: t.part, rel: t.rel, path: filePath });
    for (const kind of ["dependent", "deleted", "opaque", "special", "unreadable", "depIncomplete"]) out[kind].push(...l[kind].map((x) => ({ part: t.part, rel: full(t.rel, x), inPart: x })));
    // A repo in a dependency folder (record `i` of the list) — like a `.git` the copy wrote into.
    for (const x of l.gitInside || []) out.gitInside.add(full(t.rel, x));
    for (const x of l.files) {
      const stages = x.split("/");
      const g = stages.indexOf(".git");
      if (g >= 0) { out.gitInside.add(full(t.rel, stages.slice(0, g).join("/") || ".")); continue; }
      out.files.push({ part: t.part, rel: full(t.rel, x), inPart: x });
    }
  }
  return out;
}

/** The files of the upper layer below `rel` (relative to the project folder) — relative to `rel`. */
export function topUnder(listen, rel) {
  return listen.files.filter((d) => d.rel !== rel && under(d.rel, rel)).map((d) => relTo(d.rel, rel));
}

/**
 * The new repos of the copy (header, step 1): relative to the project folder, sorted — without the known ones. Also EVERY
 * folder into whose `.git` the copy wrote (`gitInside` of upperLists) — the search does not descend into a repo it
 * found, and `ls-files --others` not into an ignored folder: a repo INSIDE a new repo (`new/sub`) or below an ignored
 * folder of a code repo (`app/vendor/lib`) would otherwise be in no bundle, and its commits would be lost on removal. The
 * exception of the named ones (`notLinked`) does not apply to these: what was written there lies nowhere else.
 */
export async function newRepos(k, { statuses, listen }) {
  const known = new Set(k.snapshot.repos.map((r) => r.rel));
  const named = new Map((k.snapshot.notLinked || []).map((n) => [n.rel, n.reason]));
  const candidates = new Set();
  const written = new Set();
  // The form like that of the upper layer (a name that is not UTF-8 comes in surrogateescape form and goes on as bytes —
  // nameRelValid), U+FFFD never; what is not in form is rejected LOUDLY, never skipped silently (it would otherwise be
  // missing in the bundle, and the removal would take its commits along).
  const inForm = (rel, whereFrom) => {
    if (nameRelValid(rel)) return true;
    throw error(T`new repo ${JSON.stringify(String(rel).slice(0, 200))} (${whereFrom}) is not a path in form — not backed up, backup pending`, "COPY_BACKUP");
  };
  for (const rel of listen.gitInside || []) if (rel !== "." && inForm(rel, T("upper layer")) && !known.has(rel)) { candidates.add(rel); written.add(rel); }
  const search = await searchProject(k.projectPath, { instance: k.inst() });
  for (const rel of search.repos) if (inForm(rel, "Search") && !known.has(rel)) candidates.add(rel);
  const gitfile = [];
  for (const repo of k.snapshot.repos) {
    const st = statuses.get(repo.part);
    for (const x of st?.embedded || []) if (!known.has(full(repo.rel, x))) candidates.add(full(repo.rel, x));
    for (const x of st?.gitfile || []) if (!known.has(full(repo.rel, x))) gitfile.push(full(repo.rel, x));
  }
  // An embedded repo of the snapshot that the copy touched (files or `.git` in the upper layer) is to be backed up like a
  // new one; one it did not touch lies unchanged in main.
  const touched = (rel) => listen.gitInside.has(rel) || listen.files.some((d) => d.rel !== rel && under(d.rel, rel));
  const fresh = [...candidates].filter((rel) => written.has(rel) || !named.has(rel) || (named.get(rel) === "embedded" && touched(rel)));
  return { fresh: fresh.sort(), gitfile: [...new Set(gitfile)].filter((rel) => !named.has(rel)).sort() };
}

export async function wip(k, { cwd, kind = "clone", mode = "top", top = [], time, message }) {
  // The names as BYTES (nulBytes) — a name of the layer that is not UTF-8 must arrive with the same bytes that `ls-files
  // -z` names INSIDE the copy, otherwise it is silently missing in the backup. The target itself (`cwd`, the repo or the
  // worktree) also goes first on stdin as bytes, the script changes into it; the command runs in the project folder.
  // If the target lies below the project folder (every repo, a worktree there), the command runs IN the project folder and
  // the target is relative; a worktree outside stays its own cwd (target “.”) — its path came as text from `worktree list`.
  const inProject = cwd === k.projectPath || cwd.startsWith(`${k.projectPath}/`);
  const target = inProject ? path.relative(k.projectPath, cwd) || "." : ".";
  const r = await k.run(inProject ? k.projectPath : cwd, "perl", ["-e", WIP, mode, String(time), message, kind], { stdin: nulBytes([target, ...top]), what: T("the backup (WIP)") });
  if (r.code !== 0) throw error(T`Backup (WIP) in ${cwd} failed (exit ${r.code ?? r.signal}): ${last(r.stderr)}`, "COPY_BACKUP");
  const z = Object.fromEntries(String(r.stdout).split("\n").filter(Boolean).map((l) => { const i = l.indexOf("="); return i < 0 ? [l, true] : [l.slice(0, i), l.slice(i + 1)]; }));
  if (z.gitfile || z["no-worktree"]) return { without: z.gitfile ? "gitfile" : "no-worktree" };
  const id = String(z.id || "");
  if (!refValid(`refs/cbase/wip/${id}`)) throw error(T`Backup (WIP) in ${cwd}: unexpected identifier ${JSON.stringify(id)}`, "COPY_BACKUP");
  if (z.empty) return { id, empty: true };
  if (!HEX.test(String(z.wip || ""))) throw error(T`Backup (WIP) in ${cwd}: no id returned`, "COPY_BACKUP");
  return { id, oid: z.wip, count: Number(z.count || 0) };
}

const fetchStatus = (k) => store.stackCopy(k.copy.id)?.journal?.data?.fetch || {};

// What lies at a path of the copy (relative to the project folder) — stdin (NUL) the paths as bytes, output (NUL)
// `<kind> <i>` (the INDEX of the path in the input, never the name — a name that is not UTF-8 would come back as U+FFFD):
// `d` a `.git` folder (a repo), `g` a `.git` that is not a folder (gitfile, symlink), `n` no `.git` (gone or no repo any more).
export const REPO_EXISTS = `${PERL_HELPERS}
binmode STDOUT;
my $i = 0;
for my $r (grep { length } split /\\0/, input()) {
  my $g = "$r/.git";
  my $a = (-l $g) ? "g" : (-d $g) ? "d" : (-e $g) ? "g" : "n";
  print "$a " . $i++ . "\\0";
}
`;

async function reposExist(k, rels) {
  const r = await k.run(k.projectPath, "perl", ["-e", REPO_EXISTS], { stdin: nulBytes(rels), what: T("the check of disappeared repos") });
  if (r.code !== 0) throw error(T`disappeared repos cannot be checked (exit ${r.code ?? r.signal}): ${last(r.stderr)} — backup pending`, "COPY_BACKUP");
  const out = new Map();
  for (const s of String(r.stdout || "").split("\0").filter(Boolean)) {
    const m = /^([dgn]) (0|[1-9][0-9]*)$/.exec(s);
    if (!m || Number(m[2]) >= rels.length) throw error(T`Check of disappeared repos: unexpected line ${JSON.stringify(s.slice(0, 120))} — not taken over`, "COPY_BACKUP");
    out.set(rels[Number(m[2])], m[1]);
  }
  for (const rel of rels) if (!out.has(rel)) throw error(T`Check of disappeared repos: ${rel} is missing in the answer — backup pending`, "COPY_BACKUP");
  return out;
}

const bundleExists = (k, j) => { try { const st = fs.lstatSync(k.location.bundle(Number(j))); return st.isFile() && st.size > 0; } catch { return false; } };

/** The message of the WIP backup of a new repo — ONE place for saveNewRepos and the post-check of the clear-away
 *  (stacks/clearAway.js): the same message and the same date yield the same id for the same state. It is a commit message
 *  in the user's repo and keeps its wording. */
export const wipMessageNew = (k, rel) => `cbase: open work of copy ${k.name} (repo ${rel})`;

/**
 * Step 2: per new repo WIP and bundle (header). `time` is the fixed date of the WIP commits.
 * A repo that an earlier fetch numbered but never bundled (its bundle or an earlier one hit the cap, the copy was stopped)
 * and that is no longer among the new ones (deleted, renamed, no longer touched) is looked up INSIDE the copy: if a `.git`
 * folder still lies there, it is bundled; a `.git` that is not a folder needs none (“gitfile”); if it is missing, it needs
 * none (“gone” — deleted it is a whiteout in the layer report, renamed it is in a bundle of its own under the new name).
 * Otherwise the removal (“bundle missing”) would block the copy forever.
 */
export async function saveNewRepos(k, { listen, fresh, time }) {
  const state = fetchStatus(k);
  if (!fresh.length && !Object.keys(state.fresh || {}).length) return [];
  const numbers = { ...(state.fresh || {}) };
  let next = Math.max(-1, ...Object.values(numbers).map(Number)) + 1;
  for (const rel of fresh) if (!(rel in numbers)) numbers[rel] = next++;
  // First the numbers into the journal, then the bundles (an abort in between shifts no number).
  await copyJournal(k.copy.id).note({ fetch: { ...state, fresh: numbers } });
  createBackup(k.location);
  const out = [];
  const withoutBundle = { ...(state.withoutBundle || {}) };
  const toSave = [...fresh];
  const open = Object.keys(numbers).filter((rel) => !fresh.includes(rel) && !withoutBundle[rel] && !bundleExists(k, numbers[rel])).sort();
  if (open.length) {
    const found = await reposExist(k, open);
    for (const rel of open) {
      if (found.get(rel) === "d") { toSave.push(rel); continue; }
      withoutBundle[rel] = found.get(rel) === "g" ? "gitfile" : "gone";
      out.push({ rel, without: withoutBundle[rel] });
    }
  }
  for (const rel of toSave) {
    delete withoutBundle[rel];
    const w = await wip(k, { cwd: k.pathOf(rel), kind: "clone", mode: "top", top: topUnder(listen, rel), time, message: wipMessageNew(k, rel) });
    if (w.without) { withoutBundle[rel] = w.without; out.push({ rel, without: w.without }); continue; }
    const file = k.location.bundle(Number(numbers[rel]));
    const cap = bundleCap();
    try {
      // The repo as hex of its bytes (BUNDLE), never as text.
      await execIn(k.container, ["perl", "-e", BUNDLE, k.projectPath, nameBytes(rel).toString("hex"), String(cap)], { user: "agent", stdoutFile: file, capMs: fetchCapMs() });
    } catch (e) {
      dismissBackupFile(k.location, file);
      if (e?.code === 37) { withoutBundle[rel] = "empty"; out.push({ rel, without: "empty" }); continue; }
      if (e?.code === 36) throw error(T`Bundle of the repo ${rel} above ${cap} bytes (cap, estimated, not measured; knob CBASE_COPY_BUNDLE_CAP) — backup pending`, "COPY_CAP");
      throw error(T`Bundle of the repo ${rel} failed: ${last(e?.stderr || e?.message)} — backup pending`, "COPY_BACKUP");
    }
    out.push({ rel, bundle: file, size: fs.statSync(file).size, wip: w.oid || null });
  }
  // What needs no bundle (a repo without a ref, a `.git` that is not a folder) is in the journal — the clear-away only
  // removes once every other bundle is there (backedUpRepos).
  await copyJournal(k.copy.id).note({ fetch: { ...fetchStatus(k), fresh: numbers, withoutBundle } });
  return out;
}

/** The bundles the journal knows: `[{ rel, bundle, present, without }]` — for the clear-away (remove only when each is there;
 *  `without` = needs none: “empty”, “gitfile”). */
export function backedUpRepos(k) {
  const h = fetchStatus(k);
  return Object.entries(h.fresh || {}).map(([rel, j]) => {
    const bundle = k.location.bundle(Number(j));
    let present = false;
    try { const st = fs.lstatSync(bundle); present = st.isFile() && st.size > 0; } catch { /* missing */ }
    return { rel, bundle, present, without: h.withoutBundle?.[rel] || null };
  }).sort((a, b) => a.rel.localeCompare(b.rel));
}

/** The reason why a named path is not in form — or null. */
export function pathError(rel) {
  if (typeof rel !== "string" || !relValid(rel)) return T("not a relative path in form (without `..`, `.`, empty components, line break)");
  if (rel.split("/").includes(".git")) return T("a path in `.git` is never retrieved");
  return null;
}

/** Per named backed-up repo clone the bundle onto a free path. */
export async function retrieveRepos(k, { helperInst, rels }) {
  const backedUp = new Map(backedUpRepos(k).map((g) => [g.rel, g]));
  const retrieved = [];
  const denied = [];
  for (const rel of rels) {
    const f = pathError(rel);
    if (f) { denied.push({ rel: String(rel), reason: f }); continue; }
    const g = backedUp.get(rel);
    if (!g) { denied.push({ rel, reason: T("not a backed-up repo of the copy (no bundle)") }); continue; }
    if (!g.present) { denied.push({ rel, reason: T("the bundle is missing") }); continue; }
    const r = await clonesBundle({ helperInst, projectPath: k.projectPath, bundle: g.bundle, rel });
    if (r.cloned) retrieved.push({ rel, kind: "repo", bundle: g.bundle });
    else denied.push({ rel, reason: r.reason === "occupied" ? T("occupied in main — not overwritten") : r.reason === "reference" ? T("a level in main is not a folder (symlink?)") : T`Cloning failed: ${r.notice || r.reason}` });
  }
  return { retrieved, denied };
}

export async function fetchLfs(k, { helperInst }) {
  const out = [];
  for (const repo of k.snapshot.repos) {
    const r = await copyLfs({ helperInst, location: k.location, part: repo.part, mainPath: k.pathOf(repo.rel) });
    if (r.copied || r.existing || r.denied.length) out.push({ part: repo.part, rel: repo.rel, ...r });
  }
  return out;
}

/**
 * Step 3: the project repo — null without a project repo in the snapshot. The commit INSIDE the copy (`add -u` + list) runs
 * through a clean filter — if the project carries `filter=lfs`, the LFS object comes into being ONLY HERE (in the part's
 * upper layer, below `.git/lfs/objects`). Hence the LFS copy right after the fetch and BEFORE the merge (the merge in main
 * then already finds the object) — for the fetch AND the clear-away, whose LFS passes (steps 1, 2) lie before this commit;
 * otherwise the content would disappear with the removal and main would hold only the pointer. Content-addressed, so
 * idempotent. `lfs` in the result only if there was something.
 */
export async function fetchProjectRepo(k, { helperInst, listen }) {
  const repo = k.snapshot.repos.find((r) => r.projectRepo);
  if (!repo) return null;
  const c = await commitInTheCopy(k, { top: topUnder(listen, repo.rel) });
  const state = await statusOfTheCopy(k, repo);
  const { results, fetched, error: f, trap } = await fetchRepo(k, { helperInst, repo, jobs: jobsFor(k, repo, state) });
  const lfs = await copyLfs({ helperInst, location: k.location, part: repo.part, mainPath: k.pathOf(repo.rel) });
  const z = await mergeProjectRepo(k, { helperInst, results, start: k.start?.get(repo.part) || null });
  return { part: repo.part, rel: repo.rel, copyCommit: c.commit, fetched, error: f, trap, ...(lfs.copied || lfs.existing || lfs.denied.length ? { lfs } : {}), ...z };
}

// ── Fetch (REST) ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The whole fetch (header) — without occupancy (the caller holds it). `time`: the date of the WIP commits (seconds). */
export async function fetchEverything(k, { retrieve = [], home, system, time = Math.floor(Date.now() / 1000) } = {}) {
  const statuses = await statusesOfTheCopy(k);
  return withReturnPathHelper({ copy: k.copy, location: k.location, projectPath: k.projectPath, snapshot: k.snapshot, home, system }, async ({ helper, helperInst }) => {
    const listen = await upperLists(k, helper);
    const { fresh, gitfile } = await newRepos(k, { statuses, listen });
    const backedUp = await saveNewRepos(k, { listen, fresh, time });
    const projectRepo = await fetchProjectRepo(k, { helperInst, listen });
    const repos = await fetchCodeRepos(k, { helperInst, statuses });
    const lfs = await fetchLfs(k, { helperInst });
    const r = await retrieveRepos(k, { helperInst, rels: retrieve });
    return {
      repos: repos.map(({ trap: _f, ...x }) => x),
      projectRepo: projectRepo ? (({ trap: _f, ...x }) => x)(projectRepo) : null,
      // Per rel ONE entry — a backed-up one goes first, a gitfile entry is only added if its rel is still missing (a repo
      // first bundled and then turned into a gitfile would otherwise be listed twice).
      newRepos: [...backedUp, ...gitfile.filter((rel) => !backedUp.some((g) => g.rel === rel)).map((rel) => ({ rel, without: "gitfile" }))],
      lfs, retrieved: r.retrieved, denied: r.denied,
      trap: [...repos.flatMap((x) => x.trap), ...(projectRepo?.trap || [])],
      // The dependency folders in which the search for repos stopped at the cap (returnPath.js) — a repo in there is not
      // bundled. The fetch still goes through and says so; the clear-away stops at it.
      ...(listen.depIncomplete.length ? { depSearchIncomplete: listen.depIncomplete.map((x) => x.rel) } : {}),
    };
  });
}

export async function copyFetch(copyId, { retrieve = [], home = os.homedir(), system = null, data = null } = {}) {
  if (!projectboxOps()) throw new CopyError(T`copies exist only in server mode`, { code: "NO_OPS", status: 404 });
  if (!Array.isArray(retrieve) || retrieve.some((r) => typeof r !== "string")) throw new CopyError(T("`retrieve` is a list of paths"), { code: "COPY_BODY", status: 400 });
  const copy = store.stackCopy(copyId);
  if (!copy) throw new CopyError(T`no copy ${copyId}`, { code: "COPY_MISSING", status: 404 });
  const instance = copyInstance(copy.name);
  if (copy.state !== "ready") throw new CopyError(T`the copy ${copy.projectId}/${instance} is in “${copy.state}” — fetching works from a ready copy (the clear-away fetches itself)`, { code: "COPY_STATE", status: 409 });
  const inst = store.projectInstance(copy.projectId, instance);
  if (inst?.state !== "ready") throw new CopyError(T`the instance ${copy.projectId}/${instance} is ${inst ? T`in “${inst.state}”` : T("missing##instance")}`, { code: "COPY_STATE", status: 409 });
  try {
    return await withInstanceOccupancy(copy.projectId, instance, "copy-fetch", () => fetchEverything(copyContext(copy, { data }), { retrieve, home, system }));
  } catch (e) {
    if (e?.code === "OCCUPIED") throw new CopyError(text(e), { code: "OCCUPIED", status: 409 });
    throw e;
  }
}
