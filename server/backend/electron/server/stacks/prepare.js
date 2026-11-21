// The preparation of a copy. One step of the build (stacks/build.js) between creation and start: the copy container is
// in `phase=prepare`, its entrypoint has mounted the overlays and waits for `.prepared` — dockerd does not run yet, the
// stack never sees the half state.
//
// NO GIT IN THE USER CONTAINER. Every command runs via runtime/git-run.js commandRun with the copy's instance row as
// agent IN the copy container, at the original path (the overlays are there). The user container only reads the
// snapshot and the tar (via the descriptor, without following a symlink) and only writes `.prepared` into the copy's
// root (never below the layer, objects or work folders; the path guard in server/backend/test/stacks-creation.test.js).
//
// prepareCopy({ copy, inst, location, projectPath, snapshot, base, note, ownRoots }) → { repos: [..], passes }
//   Four passes over ALL repos, each in the order of the snapshot (the project repo `p` first). Only when every repo has
//   a valid `.git` may an `ls-files` run: before that git would see a code repo in the project folder as an ordinary
//   folder, and its files would fall into the delete passes as "untracked".
//     1. SET UP (one perl per repo, input NUL-separated via stdin): `git init --template=` over the linked objects
//        folder (sha256 if the ids are); the configuration BUNDLED as text at the end of `.git/config` (one `config`
//        per key is costly) — in the project repo first PROJECT_REPO_CONFIG (marker, identity, hooksPath, gpgsign —
//        projectbox/projectRepo.js, the same list as createProjectRepo), then `remote.*`/`branch.*` of the snapshot; in
//        the project repo the hook PRE_COMMIT (0755); `info/exclude`; the refs: EVERY target id first through `git
//        cat-file --batch-check` — if one is missing, the command ends with 35 and names it, the user container names
//        EVERY ref that points to it (`COPY_REF_MISSING`), and nothing is written —, then ONE `update-ref --no-deref
//        --stdin` (a detached HEAD goes along as `update HEAD <id>`); last `symbolic-ref` for HEAD and every symbolic
//        ref (`refs/remotes/<r>/HEAD`). Not `refs/stash` (open work comes as a tar, not as a stash).
//     2. CHECKOUT (perl): `base` — a string applies per repo that knows it as a commit (`rev-parse --verify
//        <b>^{commit}`, `checkout -f --detach`), the others stand on the HEAD of the snapshot (`checkout -f`); if none
//        knows it ⇒ error. `{ <rel>: <ref> }` only applies to the named repos, an unknown `rel` or a ref its repo does
//        not know ⇒ error. Without a base HEAD; an unborn HEAD stays empty. Then the delete list of the snapshot
//        (stdin): the tracked files that were missing in the main instance — BEFORE the tar (a folder of the tar in
//        the place of a deleted file).
//        THE PROJECT REPO WITH A BASE: the commit "State before copy <name>" takes the open changes of the project root
//        into the main instance BEFORE the refs are read — resolved against the refs of the snapshot, `base: "main"`
//        would carry them into the copy (against "with a base no open changes come along anywhere"). The snapshot
//        therefore carries `beforeCopy` at the project repo (code-snapshot.js: HEAD and the resolved base BEFORE the
//        commit, read in the clone helper), and `checkoutArgs` takes it: if the project repo knew the base before, it
//        stands detached on THIS id, otherwise detached on the HEAD from before (argument `state`, output
//        `state=<id>`) — never on that commit. The commit itself stays in the main instance, the refs of the copy keep
//        matching the snapshot. Without `beforeCopy` (a code repo, no base, an older snapshot) as usual. What is
//        created in the copy's project root is therefore committed by cbase on fetch/clear-away onto the DETACHED
//        HEAD; project-repo-copy.js merges this tip if no `main` came.
//     3. TAR (only without a base, only with open changes): `tar -x --no-same-owner --exclude=.git -f -` (TAR_UNPACK),
//        the tar of the part from the open folder as a stream via stdin (never whole in memory). `--exclude=.git`: the
//        tar was written by the clone helper, in which hooks of the main instance ran — a legitimate one never carries
//        a `.git` entry. A `.git/config` with `core.fsmonitor` would otherwise let code of the main instance run in the
//        copy's POST WORK while the objects folder is mounted raw. GNU tar and bsdtar both read the pattern unanchored
//        and with everything below.
//     4. POST WORK (perl): delete passes until empty — every file from `ls-files -z --others --exclude-standard` that
//        is not in the upper layer (it shines through from the main instance) is deleted; an entry ending in `/` is an
//        embedded repo and stays, likewise everything below a `notLinked` of the snapshot (except gone ones,
//        `exceptionsFor` — in the copy its gitfile is invalid, git would list its files one by one). A `.gitignore`
//        shining through hides in the first pass what it ignores — hence until empty, cap DELETE_CAP (10) with a
//        message. Then the check "every tracked file is in the upper layer" (`ls-files -z -s`, without gitlinks 160000
//        and without the delete list) — otherwise an error with the first 50 paths.
//   COPY FROM A COPY (snapshot with `template` — stacks/code-snapshot.js templateSnapshot): the upper layers of the
//     template came whole, every repo already has its `.git` with index, reflogs, stashes and configuration. Hence NO
//     SET UP (a second `git init` would append the configuration twice), no TAR (the open changes are in the layer)
//     and no POST WORK (the delete passes of the template are whiteouts in the layer; what the main instance created
//     since shines through into both alike — the new copy shows the state of the template).
//     FIRST per repo FOREIGN WORKTREES: with the layer came the template's worktree administration under .git, and the
//     new copy sees the template's worktrees in the runtime folder rw (the runtime folder is mounted in every project
//     container) — git would take them for its own (`checkout` of a branch checked out there refused, fetch and
//     clear-away would back up foreign work under the own name). Every administration folder whose worktree is not
//     below an own root (`ownRoots`: the targets of the overlays, from the build out of the creation; without them the
//     project folder) drops — also one at ANOTHER place of the template; one in the project folder came with the layer
//     and stays (perl, without git; `worktreesTheTemplate`).
//     Without `base` nothing else happens but `.prepared`. WITH `base` ("no open changes anywhere"): CHECKOUT as above
//     (without delete list), then per repo `git clean -f -d -q` (TIDY) — untracked files of the template drop, ignored
//     ones and embedded repos stay (git only deletes a repo with a double -f), likewise everything below a `notLinked`
//     (exceptionsFor, as an anchored ignore pattern `-e /<rel>/` with escaped special characters, ignorePattern — an
//     `:(exclude)` path protects nothing if its parent folder is already untracked: clean then deletes the whole
//     folder). Per repo the result then carries `tidied: true`.
//   Last `.prepared` (0644, `wx`) in the copy's root: the entrypoint unmounts the raw roots and starts dockerd.
//   Per repo → { part, rel, base: <id> | null (HEAD) | "empty", applied, deleted, tar, passes, deletedAfter, from a
//   template worktreesTheTemplate } — `base` is the id the repo stands detached on (stacks/fetch.js takes it as start
//   point), `applied` says whether the base applied there: in the project repo with a base it stands detached (on the
//   state before the commit "State before copy") even if it does not know it — `base` is then this id, `applied` false. The
//   same list is in the journal before `.prepared` (section `prepare`, `result`). If a command fails, it THROWS
//   `CopyError` (`code` COPY_PREPARE, COPY_REF_MISSING, COPY_BASE, COPY_CAP, COPY_NOT_TOP); the dismantling is done by
//   the build.
// exceptionsFor(r, notLinked)  PURE: the excluded folders of the POST WORK of a repo (see there).
// baseOfTheRepo(base, rel)  PURE: the base of ONE repo — `{ text, required }` or null; a string without the form of a
//   ref or a base that is neither string nor object THROWS (COPY_BASE 400). A `rel` the object does not name is null
//   (that every named repo exists is only checked by basePerRepo). code-snapshot.js asks the project repo (`.`) with it.
// checkoutArgs(r, b)  PURE: the arguments of the CHECKOUT of a repo `{ text, required, state }` (see step 2).
// configText(entries)  PURE: `[[key, value | null]]` as text in the format of `.git/config` (section, subsection in
//   quotes, value in quotes with `\\` `\"` `\n` `\t` `\b`; `null` = a key without a value) — in the order of the
//   list, a new header only on a change. A key outside the form THROWS.
//
// Cap (ESTIMATED, NOT MEASURED): per command PREPARE_CAP_MS (setting CBASE_COPY_PREPARE_MS).
// Guard: server/backend/test/stacks-creation.test.js.
import fs from "node:fs";
import path from "node:path";
import { T } from "../i18n.js";
import { PRE_COMMIT, PROJECT_REPO_HOOK, PROJECT_REPO_CONFIG } from "../projectbox/projectRepo.js";
import { realRoots, openFileWithoutReference } from "../runtime/real-path.js";
import { commandRun } from "../runtime/git-run.js";
import { CopyError } from "./state.js";

export const DELETE_CAP = 10;
export const TAR_UNPACK = Object.freeze(["-x", "--no-same-owner", "--exclude=.git", "-f", "-"]); // step 3, see head
export const PREPARE_CAP_MS = 300_000;
const capMs = () => {
  const n = Number(process.env.CBASE_COPY_PREPARE_MS);
  return Number.isInteger(n) && n > 0 ? n : PREPARE_CAP_MS;
};
const STASH = "refs/stash";
const HEX = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

// ── The commands in the container ───────────────────────────────────────────────────────────────────────────────────

// Helpers of the perl commands: `run` (a command, exit ≠ 0 aborts), `with_stdin` (a command with a file as stdin, its
// output), `nul` (the NUL-separated entries of an output). Exported for the perl commands of the return path in the
// copy (stacks/fetch.js) — the same helpers, not rebuilt.
export const PERL_HELPERS = String.raw`
use strict; use warnings; use File::Temp qw(tempfile);
sub run { system(@_) == 0 or die "$_[0] $_[1]: Exit " . ($? >> 8) . "\n"; }
sub with_stdin {
  my ($text, @cmd) = @_;
  my ($fh, $tmp) = tempfile(UNLINK => 1); binmode $fh; print $fh $text; close($fh) or die "tmp: $!\n";
  open(my $saved_stdin, "<&", \*STDIN) or die "stdin: $!\n"; open(STDIN, "<", $tmp) or die "$tmp: $!\n";
  open(my $p, "-|", @cmd) or die "$cmd[0]: $!\n"; binmode $p; my $o = do { local $/; <$p> }; close $p; my $rc = $?;
  open(STDIN, "<&", $saved_stdin) or die "stdin: $!\n";
  die "$cmd[1] $cmd[2]: Exit " . ($rc >> 8) . "\n" if $rc;
  return defined $o ? $o : "";
}
sub nul { my @cmd = @_; open(my $p, "-|", @cmd) or die "$cmd[0]: $!\n"; binmode $p; my $o = do { local $/; <$p> }; close $p;
  die "$cmd[1] $cmd[2]: Exit " . ($? >> 8) . "\n" if $?; return grep { length } split /\0/, (defined $o ? $o : ""); }
sub input { binmode STDIN; my $in = do { local $/; <STDIN> }; return defined $in ? $in : ""; }
`;

// 1. SET UP — stdin: fmt, pr, hook path, hook, config, exclude, n, (ref, id)*, m, (name, target)* — NUL-separated.
const SET_UP = `${PERL_HELPERS}
my @f = split /\\0/, input(), -1;
my ($fmt, $pr, $hook_path, $hook, $config_text, $exclude, $n_upd) = splice(@f, 0, 7);
die "Incomplete input\\n" unless defined $n_upd && $n_upd =~ /^\\d+$/;
my @upd = map { [splice(@f, 0, 2)] } 1 .. $n_upd;
my $ns = shift @f; die "Incomplete input\\n" unless defined $ns && $ns =~ /^\\d+$/;
my @sym = map { [splice(@f, 0, 2)] } 1 .. $ns;
run("git", "init", "-q", "--template=", ($fmt eq "sha256" ? ("--object-format=sha256") : ()));
if (length $config_text) { open(my $k, ">>", ".git/config") or die ".git/config: $!\\n"; binmode $k; print $k $config_text; close($k) or die ".git/config: $!\\n"; }
if ($pr eq "1") {
  my ($d) = $hook_path =~ m{^(.*)/[^/]+$}; mkdir $d;
  open(my $h, ">", $hook_path) or die "$hook_path: $!\\n"; binmode $h; print $h $hook; close($h) or die "$hook_path: $!\\n";
  chmod(0755, $hook_path) or die "$hook_path: $!\\n";
}
if (length $exclude) { mkdir ".git/info"; open(my $e, ">", ".git/info/exclude") or die "exclude: $!\\n"; binmode $e; print $e $exclude; close($e) or die "exclude: $!\\n"; }
if (@upd) {
  my %ids = map { $_->[1] => 1 } @upd;
  my @missing = map { /^(\\S+) missing$/ ? $1 : () } split /\\n/, with_stdin(join("", map { "$_\\n" } sort keys %ids), "git", "cat-file", "--batch-check");
  if (@missing) { print "missing=$_\\n" for @missing; exit 35; }
  with_stdin(join("", map { "update $_->[0] $_->[1]\\n" } @upd), "git", "update-ref", "--no-deref", "--stdin");
}
run("git", "symbolic-ref", $_->[0], $_->[1]) for @sym;
print "set up\\n";
`;

// 2. CHECKOUT — argv: base ("" = none), required (0|1), state ("" = none: without a hit of the base, detached onto this
// commit instead of HEAD — if it is none, abort); stdin: the delete list (NUL). Output `base=<id>|-|empty|unknown` or
// `state=<id>`.
// LFS (checked and deliberately NOT changed): the checkout runs via `docker exec` in the copy container, i.e. with
// `GIT_LFS_SKIP_SMUDGE=1` from the ENV of the project-box image (commandRun sets no LFS variable), and therefore writes
// the pointer for `filter=lfs`. Unlike the merge of the return path (returnPath.js `merge`) the objects are NOT local
// here: the copy's `.git` is new (`git init` over the linked `objects`), the upper layer's `.git` is opaque and hides
// `.git/lfs` of the main instance. `GIT_LFS_SKIP_SMUDGE=0` would let git-lfs reach into the network here — the copy
// container has one —, without access, and with `filter.lfs.required` the preparation would fail at a private LFS
// remote. The content only gets into the copy with a `git lfs pull` with access (open).
const CHECKOUT = `${PERL_HELPERS}
my ($base, $required, $state) = @ARGV;
$state = "" unless defined $state;
sub commit_of {
  open(my $p, "-|", "git", "rev-parse", "-q", "--verify", "$_[0]^{commit}") or die "rev-parse: $!\\n";
  my $oid = do { local $/; <$p> }; close $p; my $ok = $? == 0;
  $oid = "" unless defined $oid; chomp $oid;
  return ($ok && $oid =~ /^[0-9a-f]{40}([0-9a-f]{24})?$/) ? $oid : "";
}
my $target = "";
if (length $base) {
  $target = commit_of($base);
  if (!length $target && $required eq "1") { print "base=unknown\\n"; exit 36; }
}
if (length $target) { run("git", "checkout", "-q", "-f", "--detach", $target); print "base=$target\\n"; }
elsif (length $state) {
  my $s = commit_of($state); die "state $state: no commit in the copy\\n" unless length $s;
  run("git", "checkout", "-q", "-f", "--detach", $s); print "state=$s\\n";
}
elsif (length commit_of("HEAD")) { run("git", "checkout", "-q", "-f"); print "base=-\\n"; }
else { print "base=empty\\n"; }
my $n = 0;
for my $p (grep { length } split /\\0/, input()) { if (-l $p || (-e $p && !-d _)) { unlink($p) or die "unlink $p: $!\\n"; $n++; } }
print "deleted=$n\\n";
`;

// 4. POST WORK — argv: the upper layer (path in the copy), the cap; stdin (NUL): the number n, n paths of the delete
// list, then the excluded folders (a repo without a snapshot of its own — in the copy its gitfile is invalid, git would
// list its files one by one, and they shine through from the main instance on purpose; relative to the repo).
const POST_WORK = `${PERL_HELPERS}
my ($layer, $cap) = @ARGV;
my @items = grep { length } split /\\0/, input();
my $nl = shift @items; die "Incomplete input\\n" unless defined $nl && $nl =~ /^\\d+$/ && $nl <= @items;
my %del = map { $_ => 1 } splice(@items, 0, $nl);
my %excluded = map { $_ => 1 } @items;
my $is_excluded = sub { my @t = split m{/}, $_[0]; my $p = ""; for my $i (0 .. $#t) { $p = $i ? "$p/$t[$i]" : $t[$i]; return 1 if $excluded{$p}; } return 0; };
my $on_top = sub { my $p = "$layer/$_[0]"; return (-l $p || -e $p); };
my ($passes, $gone) = (0, 0);
while (1) {
  my @rest = grep { !m{/$} && !$on_top->($_) && !$is_excluded->($_) } nul("git", "ls-files", "-z", "--others", "--exclude-standard");
  last unless @rest;
  if ($passes >= $cap) { print "cap=" . scalar(@rest) . "\\n"; print "rest=$_\\n" for @rest[0 .. ($#rest < 19 ? $#rest : 19)]; exit 37; }
  $passes++;
  for my $p (@rest) { unlink($p) or die "unlink $p: $!\\n"; $gone++; }
}
print "passes=$passes\\ndeleted=$gone\\n";
my @missing;
for my $e (nul("git", "ls-files", "-z", "-s")) {
  my ($mode, $path) = $e =~ /^(\\d+) \\S+ \\d+\\t(.*)$/s or next;
  next if $mode eq "160000" || $del{$path};
  push @missing, $path unless $on_top->($path);
}
if (@missing) { print "missing=" . scalar(@missing) . "\\n"; print "path=$_\\n" for @missing[0 .. ($#missing < 49 ? $#missing : 49)]; exit 38; }
`;

// 0. FOREIGN WORKTREES (only from a template) — argv: the copy's own roots (the targets of its overlays, original
// paths: the project folder with repos and `~/.local`). Without git (the configuration came from the template), only
// perl in the repo. Per administration folder of a worktree under .git: where its worktree is, `gitdir` says (the path
// of its `.git` file — absolute, or with worktree.useRelativePaths relative to the administration folder). If the
// worktree (real path) is below an own root, it came with the layer and is this copy's copy — it stays. Otherwise it
// belongs to the TEMPLATE: the template's worktrees in the runtime folder (every project container mounts it rw — the
// worktree would be visible here and git would take it for its own), another place the template saw, or one that does
// not exist here; then ONLY the administration folder drops (a symlink instead of a folder likewise, without following
// it; `gitdir` only read as a file, never via a symlink or a FIFO). `git worktree prune` would only take missing ones,
// `git worktree remove` would delete the template's worktree itself. Output `removed=<n>`, `kept=<n>`.
const FOREIGN_WORKTREES = `${PERL_HELPERS}
use Cwd qw(realpath); use File::Path qw(remove_tree);
my @roots = grep { defined } map { realpath($_) } @ARGV;
die "no own root readable\\n" unless @roots;
my $is_own = sub { my $p = shift; for my $w (@roots) { return 1 if $p eq $w || index($p, $w eq "/" ? "/" : "$w/") == 0; } return 0; };
my $admin = ".git/worktrees";
my ($gone, $kept) = (0, 0);
if (-l $admin) { unlink($admin) or die "unlink $admin: $!\\n"; $gone++; }
elsif (-d $admin) {
  opendir(my $d, $admin) or die "$admin: $!\\n";
  my @ids = sort grep { $_ ne "." && $_ ne ".." } readdir($d);
  closedir($d);
  for my $id (@ids) {
    my $e = "$admin/$id";
    my $g = "$e/gitdir";
    my $wt;
    if (!-l $e && -d $e && !-l $g && -f $g && open(my $f, "<", $g)) {
      my $z = do { local $/; <$f> }; close $f;
      $z = "" unless defined $z; $z =~ s/\\r?\\n\\z//;
      if (length $z) {
        my $p = $z =~ m{^/} ? $z : "$e/$z";
        $p =~ s{/+[^/]+/*\\z}{};
        $wt = realpath($p) if length $p;
      }
    }
    if (defined $wt && $is_own->($wt)) { $kept++; next; }
    remove_tree($e, { error => \\my $error });
    die "$e: " . join(", ", map { values %$_ } @$error) . "\\n" if @$error;
    $gone++;
  }
}
print "removed=$gone\\nbehalten=$kept\\n";
`;

/** The perl commands (head) — for the guards that also run them without a container against real repos. */
export const SCRIPTS = Object.freeze({ setUp: SET_UP, checkout: CHECKOUT, postWork: POST_WORK, foreignWorktrees: FOREIGN_WORKTREES });

// ── Pure helpers ────────────────────────────────────────────────────────────────────────────────────────────────────

const valueEsc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\x08/g, "\\b");

export function configText(entries) {
  const rows = [];
  let header = null;
  for (const [k, v] of entries) {
    const s = String(k);
    const a = s.indexOf(".");
    const b = s.lastIndexOf(".");
    const section = s.slice(0, a);
    const name = s.slice(b + 1);
    const under = a === b ? null : s.slice(a + 1, b);
    if (a <= 0 || !/^[A-Za-z0-9-]+$/.test(section) || !/^[A-Za-z][A-Za-z0-9-]*$/.test(name) || (under !== null && /[\n\0]/.test(under))) {
      throw new CopyError(T`Configuration: key ${JSON.stringify(s.slice(0, 120))} does not have the form <section>[.<sub>].<name>`, { code: "COPY_PREPARE", status: 500 });
    }
    if (v !== null && /\0/.test(String(v))) throw new CopyError(T`Configuration: ${s} carries a NUL`, { code: "COPY_PREPARE", status: 500 });
    const h = under === null ? `[${section}]` : `[${section} "${under.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"]`;
    if (h !== header) { rows.push(h); header = h; }
    rows.push(v === null ? `\t${name}` : `\t${name} = "${valueEsc(v)}"`);
  }
  return rows.length ? `${rows.join("\n")}\n` : "";
}

// A base string: no control characters, no leading "-" (an option for rev-parse), not empty, at most 256 characters.
function baseText(b, where) {
  const t = typeof b === "string" ? b : "";
  if (!t || t.length > 256 || t.startsWith("-") || /[\0-\x1f\x7f]/.test(t)) {
    throw new CopyError(T`base ${where}: ${JSON.stringify(String(b).slice(0, 80))} is not a ref (empty, too long, begins with "-" or carries control characters)`, { code: "COPY_BASE", status: 400 });
  }
  return t;
}

/** Per repo the base: `{ text, required }` or null (HEAD). An object names repos by their `rel` — an unknown one throws. */
export function basePerRepo(base, repos) {
  const byKey = new Map(repos.map((r) => [r.rel, null]));
  if (base === null || base === undefined || base === "") return byKey;
  if (typeof base === "string") {
    const t = baseText(base, T("(string)"));
    for (const r of repos) byKey.set(r.rel, { text: t, required: false });
    return byKey;
  }
  if (typeof base !== "object" || Array.isArray(base)) throw new CopyError(T("base is neither a string nor { <rel>: <ref> }"), { code: "COPY_BASE", status: 400 });
  for (const [rel, ref] of Object.entries(base)) {
    if (!byKey.has(rel)) throw new CopyError(T`base names the repo "${rel}" — the snapshot does not know it (${[...byKey.keys()].join(", ") || T("no repos")})`, { code: "COPY_BASE", status: 400 });
    byKey.set(rel, { text: baseText(ref, T`for "${rel}"`), required: true });
  }
  return byKey;
}

/** The base of ONE repo (head) — `{ text, required }` or null. Checks the form like basePerRepo, not the repo list. */
export function baseOfTheRepo(base, rel) {
  if (base === null || base === undefined || base === "") return null;
  if (typeof base === "string") return { text: baseText(base, T("(string)")), required: false };
  if (typeof base !== "object" || Array.isArray(base)) throw new CopyError(T("base is neither a string nor { <rel>: <ref> }"), { code: "COPY_BASE", status: 400 });
  return Object.prototype.hasOwnProperty.call(base, rel) ? { text: baseText(base[rel], T`for "${rel}"`), required: true } : null;
}

/**
 * The arguments of the CHECKOUT of a repo (head, step 2) → `{ text, required, state }`; `b` from basePerRepo. Without
 * `beforeCopy` as usual (`state` empty = HEAD of the snapshot). With `beforeCopy` (only at the project repo, only with a
 * base — code-snapshot.js read HEAD and the base BEFORE the commit "State before copy"): `text` = the id resolved then,
 * which MUST resolve (`required`: if it is missing, that is an error, not a fallback), `state` = the HEAD before; if
 * the repo did not know the base then, `text` empty — with `required` (object form) an error COPY_BASE as in the
 * CHECKOUT itself. An unborn HEAD before leaves `state` empty. Throws CopyError.
 */
export function checkoutArgs(r, b) {
  const vk = r?.beforeCopy;
  if (vk === undefined || vk === null) return { text: b ? b.text : "", required: Boolean(b?.required), state: "" };
  const where = r?.rel === "." ? T("project folder") : String(r?.rel ?? "");
  const idOrNull = (x) => x === null || (typeof x === "string" && HEX.test(x));
  if (!r.projectRepo || typeof vk !== "object" || !idOrNull(vk.head) || !idOrNull(vk.base) || !(vk.text === null || typeof vk.text === "string")) {
    throw new CopyError(T`${where}: snapshot: beforeCopy ${JSON.stringify(vk).slice(0, 200)} is not valid (only at the project repo, ids or null)`, { code: "COPY_PREPARE", status: 500 });
  }
  if (vk.text !== (b ? b.text : null)) {
    throw new CopyError(T`${where}: snapshot: beforeCopy was read for the base ${JSON.stringify(vk.text)}, the copy carries ${JSON.stringify(b ? b.text : null)} — nothing is guessed`, { code: "COPY_PREPARE", status: 500 });
  }
  if (b && !vk.base && b.required) {
    throw new CopyError(T`base: the repo "${r.rel}" did not know "${b.text}" as a commit before the commit "State before copy"`, { code: "COPY_BASE", status: 409 });
  }
  return b && vk.base ? { text: vk.base, required: true, state: vk.head || "" } : { text: "", required: false, state: vk.head || "" };
}

const nul = (list) => (list.length ? `${list.join("\0")}\0` : "");

/**
 * The folders the delete passes of a repo skip: every `notLinked` of the snapshot except gone ones that is BELOW the
 * repo, relative to it. In the copy the gitfile of a worktree or submodule is invalid (its gitdir was in the `.git` of
 * the main instance), git would see the files in it one by one as untracked — but they shine through from the main
 * instance on purpose. A `rel` that does not have the form of a path THROWS.
 */
export function exceptionsFor(r, notLinked) {
  const out = [];
  for (const x of notLinked || []) {
    const rel = String(x?.rel ?? "");
    if (!rel || rel.startsWith("/") || /[\0\n\r]/.test(rel) || rel.split("/").some((t) => !t || t === "." || t === "..")) {
      if (rel === ".") continue; // the project folder itself (a gitfile as `.git`): nothing below to exclude
      throw new CopyError(T`Snapshot: notLinked ${JSON.stringify(rel.slice(0, 120))} is not a relative path`, { code: "COPY_PREPARE", status: 500 });
    }
    if (x.reason === "gone") continue;
    if (r.rel === ".") out.push(rel);
    else if (rel.startsWith(`${r.rel}/`)) out.push(rel.slice(r.rel.length + 1));
  }
  return [...new Set(out)].sort();
}
/** A relative path as an anchored ignore pattern for `git clean -e` (special characters escaped, a folder with "/"). */
export const ignorePattern = (rel) => `/${String(rel).replace(/[\\*?[\]!#]/g, "\\$&").replace(/ $/, "\\ ")}/`;
const rowsFrom = (text, key) => String(text || "").split("\n").filter((z) => z.startsWith(`${key}=`)).map((z) => z.slice(key.length + 1));
const shortId = (id) => String(id).slice(0, 12);

function checkRepo(r) {
  const where = r.rel === "." ? T("project folder") : r.rel;
  if (!/^(p|r(0|[1-9][0-9]*))$/.test(String(r.part))) throw new CopyError(T`Snapshot: part "${r.part}" is not one`, { code: "COPY_PREPARE", status: 500 });
  for (const ref of r.refs || []) {
    if (/[\s\0]/.test(ref.name) || !(ref.name === "HEAD" || ref.name.startsWith("refs/"))) throw new CopyError(T`${where}: ref ${JSON.stringify(ref.name)} is not one`, { code: "COPY_PREPARE", status: 500 });
    if (!ref.symref && !HEX.test(String(ref.oid))) throw new CopyError(T`${where}: ref ${ref.name} without an id`, { code: "COPY_PREPARE", status: 500 });
  }
  if (r.head?.oid && !HEX.test(r.head.oid)) throw new CopyError(T`${where}: HEAD id is not one`, { code: "COPY_PREPARE", status: 500 });
  if (!r.head?.symref && !r.head?.oid) throw new CopyError(T`${where}: HEAD without a ref and without an id`, { code: "COPY_PREPARE", status: 500 });
  if (/\0/.test(String(r.exclude || ""))) throw new CopyError(T`${where}: info/exclude carries a NUL`, { code: "COPY_PREPARE", status: 500 });
  if (r.open && (typeof r.open.tar !== "string" || r.open.tar !== `${r.part}.tar`)) throw new CopyError(T`${where}: tar "${r.open.tar}" is not that of the part`, { code: "COPY_PREPARE", status: 500 });
  return where;
}

/** The input of SET UP (head, step 1) for a repo. */
export function setUpInput(r) {
  const updates = (r.refs || []).filter((x) => !x.symref && x.name !== STASH).map((x) => [x.name, x.oid]);
  if (!r.head?.symref && r.head?.oid) updates.push(["HEAD", r.head.oid]);
  const symbols = (r.refs || []).filter((x) => x.symref).map((x) => [x.name, x.symref]);
  if (r.head?.symref) symbols.push(["HEAD", r.head.symref]);
  const ids = [...updates.map((u) => u[1])];
  const fmt = ids.some((i) => i.length === 64) ? "sha256" : "sha1";
  const config = configText([...(r.projectRepo ? PROJECT_REPO_CONFIG : []), ...(r.config || [])]);
  const fields = [fmt, r.projectRepo ? "1" : "0", PROJECT_REPO_HOOK, r.projectRepo ? PRE_COMMIT : "", config, String(r.exclude || ""),
    String(updates.length), ...updates.flat(), String(symbols.length), ...symbols.flat()];
  for (const f of fields) if (String(f).includes("\0")) throw new CopyError(T("SET UP: a field carries a NUL"), { code: "COPY_PREPARE", status: 500 });
  return { text: fields.join("\0"), updates };
}

// ── The procedure ───────────────────────────────────────────────────────────────────────────────────────────────────

export async function prepareCopy({ copy, inst, location, projectPath, snapshot, base = null, note = null, ownRoots = null }) {
  if (!inst?.containerId) throw new CopyError(T`Preparation ${copy.projectId}/${copy.name}: the instance row carries no container`, { code: "COPY_PREPARE", status: 500 });
  const repos = [...(snapshot?.repos || [])].sort((a, b) => (a.part === "p" ? -1 : b.part === "p" ? 1 : 0));
  const wherePer = new Map(repos.map((r) => [r.part, checkRepo(r)]));
  const basePer = basePerRepo(base, repos);
  const pathOf = (r) => (r.rel === "." ? projectPath : path.join(projectPath, r.rel));
  const opts = () => ({ timeout: capMs(), env: { GIT_TERMINAL_PROMPT: "0" }, envAlways: ["GIT_TERMINAL_PROMPT"] });
  const state = { step: "", repos: repos.map((r) => ({ part: r.part, rel: r.rel })) };
  const remember = async (step, part) => { state.step = step; state.part = part; if (note) await note({ prepare: { ...state } }); };
  const fails = (r, what, res, code = "COPY_PREPARE") => new CopyError(
    T`${wherePer.get(r.part)}: ${what} failed in the copy container (exit ${res.code ?? res.signal ?? "?"}${res.cap ? `, ${res.cap === "deadline" ? T("time cap") : T("output cap")}` : ""}): ${String(res.stderr || res.stdout || "").trim().split("\n").slice(-3).join(" | ").slice(0, 500)}`,
    { code, status: 500 });
  const result = new Map(repos.map((r) => [r.part, { part: r.part, rel: r.rel, base: null, applied: false, deleted: 0, tar: false, passes: 0, deletedAfter: 0 }]));
  // From a template (head, "COPY FROM A COPY"): the `.git` came with the template's layer.
  const fromTemplate = Boolean(snapshot?.template);
  const withoutBase = base === null || base === undefined || base === "";

  // 0. FOREIGN WORKTREES: the template's worktree administration came with its layer — gone BEFORE any other step, so
  // that no git of this copy ever takes them for its own (head, FOREIGN_WORKTREES).
  const roots = [...new Set((ownRoots?.length ? ownRoots : [projectPath]).map((w) => path.resolve(String(w))))];
  for (const r of fromTemplate ? repos : []) {
    await remember("foreign-worktrees", r.part);
    const res = await commandRun(inst, pathOf(r), "perl", ["-e", FOREIGN_WORKTREES, ...roots], opts());
    if (res.code !== 0) throw fails(r, T("removing the template's worktrees"), res);
    result.get(r.part).worktreesTheTemplate = Number(rowsFrom(res.stdout, "removed")[0] || 0);
  }

  // 1. SET UP
  for (const r of fromTemplate ? [] : repos) {
    await remember("setUp", r.part);
    const { text, updates } = setUpInput(r);
    const res = await commandRun(inst, pathOf(r), "perl", ["-e", SET_UP], { ...opts(), stdin: text });
    if (res.code === 35) {
      const missing = new Set(rowsFrom(res.stdout, "missing"));
      const names = updates.filter(([, id]) => missing.has(id)).map(([n]) => n);
      throw new CopyError(T`${wherePer.get(r.part)}: ${names.length} ref(s) point to objects missing in the copy — ${names.join(", ")} (${[...missing].map(shortId).join(", ")}; alternates or a partial clone in the main instance?) — no copy with broken refs, nothing written`, { code: "COPY_REF_MISSING", status: 409 });
    }
    if (res.code !== 0) throw fails(r, T("setting up the repo"), res);
  }

  // 2. CHECKOUT (with delete list) — from a template only with a base
  let baseHit = false;
  for (const r of fromTemplate && withoutBase ? [] : repos) {
    await remember("checkout", r.part);
    const b = basePer.get(r.rel);
    const a = checkoutArgs(r, b); // in the project repo with a base the state BEFORE the commit "State before copy"
    const res = await commandRun(inst, pathOf(r), "perl", ["-e", CHECKOUT, a.text, a.required ? "1" : "0", a.state], { ...opts(), stdin: nul(r.open?.erase || []) });
    if (res.code === 36) throw new CopyError(T`base: the repo "${r.rel}" does not know "${b.text}" as a commit`, { code: "COPY_BASE", status: 409 });
    if (res.code !== 0) throw fails(r, T("the checkout"), res);
    const [what] = rowsFrom(res.stdout, "base");
    const [states] = rowsFrom(res.stdout, "state");
    const e = result.get(r.part);
    e.base = states !== undefined ? states : what === "-" ? null : what;
    e.applied = Boolean(b) && HEX.test(String(what));
    e.deleted = Number(rowsFrom(res.stdout, "deleted")[0] || 0);
    if (e.applied) baseHit = true;
  }
  if (typeof base === "string" && base && !baseHit) {
    throw new CopyError(T`base "${base}": no repo of the copy knows this commit (${repos.map((r) => r.rel).join(", ") || T("no repos")}) — nothing is guessed`, { code: "COPY_BASE", status: 409 });
  }

  // 2a. TIDY (only from a template with a base): untracked files of the template drop.
  for (const r of fromTemplate && !withoutBase ? repos : []) {
    await remember("tidy", r.part);
    const out = exceptionsFor(r, snapshot.notLinked).flatMap((a) => ["-e", ignorePattern(a)]);
    const res = await commandRun(inst, pathOf(r), "git", ["clean", "-f", "-d", "-q", ...out], opts());
    if (res.code !== 0) throw fails(r, T("tidying (git clean)"), res);
    result.get(r.part).tidied = true;
  }

  // 3. TAR (only without a base)
  for (const r of fromTemplate ? [] : repos) {
    if (!withoutBase || !r.open) continue;
    await remember("tar", r.part);
    const fd = openFileWithoutReference(path.join(location.root.open, r.open.tar), realRoots([location.root.open], [location.root.base]));
    const stream = fs.createReadStream(null, { fd, autoClose: true });
    const res = await commandRun(inst, pathOf(r), "tar", [...TAR_UNPACK], { ...opts(), stdin: stream });
    if (res.code !== 0) throw fails(r, T("unpacking the open changes"), res);
    result.get(r.part).tar = true;
  }

  // 4. POST WORK — delete passes and check (none from a template, head)
  let passes = 0;
  for (const r of fromTemplate ? [] : repos) {
    await remember("postWork", r.part);
    const erase = r.open?.erase || [];
    const input = nul([String(erase.length), ...erase, ...exceptionsFor(r, snapshot.notLinked)]);
    const res = await commandRun(inst, pathOf(r), "perl", ["-e", POST_WORK, location.inside.layer(r.part), String(DELETE_CAP)], { ...opts(), stdin: input });
    if (res.code === 37) {
      throw new CopyError(T`${wherePer.get(r.part)}: after ${DELETE_CAP} delete passes still ${rowsFrom(res.stdout, "cap")[0]} file(s) shining through — cap hit (estimated, not measured), aborted: ${rowsFrom(res.stdout, "rest").slice(0, 5).join(", ")}`, { code: "COPY_CAP", status: 500 });
    }
    if (res.code === 38) {
      throw new CopyError(T`${wherePer.get(r.part)}: ${rowsFrom(res.stdout, "missing")[0]} tracked file(s) are not in the upper layer — the checkout did not write them: ${rowsFrom(res.stdout, "path").slice(0, 5).join(", ")}`, { code: "COPY_NOT_TOP", status: 500 });
    }
    if (res.code !== 0) throw fails(r, T("the delete passes"), res);
    const e = result.get(r.part);
    e.passes = Number(rowsFrom(res.stdout, "passes")[0] || 0);
    e.deletedAfter = Number(rowsFrom(res.stdout, "deleted")[0] || 0);
    passes = Math.max(passes, e.passes);
  }

  // Last the marker: the entrypoint unmounts the raw roots and starts dockerd. Before that into the journal what happened per repo.
  state.result = [...result.values()];
  await remember("prepared", "");
  fs.writeFileSync(location.root.prepared, "", { mode: 0o644, flag: "wx" });
  return { repos: [...result.values()], passes };
}
