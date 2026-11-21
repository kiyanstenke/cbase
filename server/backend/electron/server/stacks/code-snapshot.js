// The code state of a copy, taken while the main instance is paused. Called by stacks/freeze.js between the pause and
// phase 2 — main stands still, nothing changes underneath.
//
// NO GIT IN B (the backend). Every git command runs in the clone helper as agent: through runtime/git-run.js with the helper
// instance (`helperInstance` — projectbox/run-instance.js containerOf knows `helperId`); the project folder is mounted there
// at its original path. Hooks, `core.fsmonitor` and filters of main therefore run in the helper, never in B. B only reads
// files (through the descriptor, never through a symlink) and links objects (stacks/objects.js). Source guard in
// server/backend/test/stacks-code.test.js.
//
// codeSnapshot({ projectId, name, projectPath, location, helper, base, note })
//   projectPath   the project folder of main (mounted at the same path in the helper)
//   location      copyLocation(…) (stacks/location.js) — `open/` is mounted rw at the same path in the helper
//   helper        the clone helper `{ id }` (projectbox/helper.js startHelper)
//   base          the copy's `base` (JSON or null): with a base NO open changes come along anywhere — no tar
//   note(data)    optional, awaited: the progress for the journal (section `code`, stacks/freeze.js)
//   Procedure:
//     1. If the project folder is the project's own repo (marker, projectRepo.js carriesProjectRepoMarker), first (a) a commit
//        “State before copy <name>” (commitProjectRepo with the helper instance, `empty: true`) — its repo list is the one from
//        searchProject in the helper; otherwise searchProject itself. Never findRepos (cap in git.js).
//        1.0 WITH a base, ONE `sh -c` in the helper (BEFORE_COPY) reads, BEFORE that commit, the HEAD of the project repo and
//        the base resolved against exactly that state (`rev-parse -q --verify <b>^{commit}`; the project repo's base comes
//        from stacks/prepare.js baseOfTheRepo). Both are kept as `beforeCopy` on part `p`: the commit takes the open changes
//        of the project root into main, the copy still stands on the state before it (prepare.js checkoutArgs) — with a base
//        no open changes come along anywhere.
//     2. Parts: `p` = the project folder if it has a `.git` FOLDER (project repo or code repo), then the code repos `r0…rn`
//        in list order. A `.git` that is not a folder (gitfile of a worktree or submodule, a symlink) is not linked but
//        named (`notLinked`).
//     3. Per repo ONE `sh -c` in the helper with `GIT_OPTIONAL_LOCKS=0`: (b) `for-each-ref` of all refs including
//        `refs/remotes/*/HEAD` and `%(symref)`, `symbolic-ref -q HEAD`, `rev-parse HEAD`, the number of stashes,
//        `config --local -z --get-regexp '^(branch|remote)\.'`, the content of `info/exclude`, the gitlinks of the index (perl
//        over `ls-files -s -z`, mode 160000 only — submodules), `worktree list --porcelain -z` (linked worktrees, ignored
//        ones too) and ONLY with a base the non-ignored embedded repos (perl over `ls-files -z --others --exclude-standard`,
//        entries ending in “/” only — without a base the status supplies them); (c) without a base `status --porcelain=v2 -z
//        --untracked-files=all --no-renames --ignore-submodules=all` into `open/<part>.status`, from it the EXISTING paths
//        (perl, -e/-l) into `open/<part>.list` — plus, from `ls-files -v -z`, the files with the assume-unchanged or
//        skip-worktree bit, which git status does not check: existing ⇒ into the list (their content goes with the tar),
//        missing with ONLY assume-unchanged ⇒ erase list, otherwise (skip-worktree, e.g. a sparse checkout) only counted;
//        the ledger of these is `open/<part>.hidden` —, then `tar --null --no-recursion -cf open/<part>.tar -T …`. B stores
//        the bytes and never unpacks them.
//     4. B checks every line: ref names by the rules of `check-ref-format`, ids hexadecimal, no NUL, no line breaks, UTF-8,
//        paths relative without `..`; caps for tar size, rows and output, each with a message. The erase list is the tracked
//        paths of the status that no longer exist. A status line `? x/` (a non-ignored embedded repo or a linked worktree —
//        git does not descend into it) does not go into the tar but into `notLinked`.
//     4a. `notLinked` grows by the repos INSIDE the code repos that the search does not see (it does not descend into a repo
//        it found) — each `{ rel, reason }`, `rel` relative to the project folder, no duplicates (a part or something
//        already named does not count): `embedded` (`x/` with a `.git` folder — it shows through in the copy, `.git`
//        included), `gitfile`/`reference` (`x/` with a `.git` that is not a folder), `submodule` (a gitlink), `worktree` (a
//        linked worktree of a part below the project folder, not `prunable`). The preparation exempts every named `rel`
//        (except `gone`) from its delete passes: in the copy its gitfile is invalid, git would see its files one by one as
//        untracked (stacks/prepare.js).
//     5. Objects: `<repo>/.git/objects` → `objects/<part>` (stacks/objects.js linkObjects), the upper layer
//        `layer/<part>/.git` (opaque, mount point `.git/objects`, `shallow`); LFS is only named.
//     6. `snapshot.json` (0600) — what the preparation reads, see SNAPSHOT below.
//   → the summary without path lists ({ version, projectRepo, commit, repos: [{ part, rel, … counts }], notLinked }),
//     per repo `open: null | { paths, erase, size, hidden, hiddenMissing }` (counts).
//
// SNAPSHOT (version 1): { version, projectId, name, time, base: bool, projectRepo: bool, commit | null,
//   repos: [{ part, rel ("." = the project folder), projectRepo, head: { symref | null, oid | null }, refs: [{ name, oid,
//   symref | null }], stash, config: [[key, value | null]], exclude, open: null | { tar: "<part>.tar", size, identifier:
//   { ino, ctime, mtime } (see checkOpenAfterClear), paths: [..], erase: [..], hidden: [..], hiddenMissing },
//   objects: { files, copied, alternates, promisor, … }, shallow, lfs, beforeCopy? }],
//   notLinked: [{ rel, reason }], unreadable: [..] }
//   beforeCopy (project repo only, and only with a base): { head: <id> | null, base: <id> | null, text: <base text> | null }
//   — HEAD and the resolved base BEFORE the commit “State before copy”; `text` is the project repo's base (null: the object
//   does not name it), `base` null: the repo did not know it. A snapshot without the field prepares the copy without it.
//   open.hidden          files with the assume-unchanged or skip-worktree bit that exist in main: their content came with
//                        the tar, the bit did not — in the copy `git status` shows them as modified if they are.
//   open.hiddenMissing   (count) files with the skip-worktree bit that are missing in main (a sparse checkout): in the copy
//                        they carry the state of the checkout. Missing ones with ONLY assume-unchanged are in `open.erase`.
// checkOpenAfterClear(location)  after the helper was emptied: every tar still has the size and identifier of its check.
// readSnapshot(location)  THE reader of `snapshot.json` (through the descriptor, never through a symlink; version checked,
//   otherwise CopyError COPY_PREPARE) — for build, fetch, clearing away, the request and the snapshot of a copy from a copy.
//   It lives here because this step needs it itself and build.js imports this file via freeze.js (an import back would be
//   a cycle).
//
// templateSnapshot({ projectId, name, projectPath, location, template, base, note }) — the snapshot of a copy made from a
//   COPY (`template` = { name, instance, inst, location }: its name, `copy-<name>`, its instance row, copyLocation of the
//   template). Called by stacks/freeze.js BEFORE the template is paused. NO commit, no tar, no upper layer from B: the new
//   copy takes over the template's upper layers whole (`layer/`, by the clone program in the clone helper, two-phase) — with
//   them come `.git` including index, reflogs, stashes, hooks and configuration, and every open change. Recorded here is
//   only what the rest of the build and the fetch read:
//     - the parts (`p`, `r<i>`) with `rel`, `projectRepo`, `shallow`, `lfs`, plus `notLinked` and `unreadable` from the
//       template's snapshot — it is its `layer/<part>` that are taken over (a repo the template itself created lives only
//       in its layer; the fetch of the new copy finds it through its search as a new repo);
//     - per part ONE `sh -c` (SCRIPT, without open changes) INSIDE the running template — commandRun with its instance row,
//       as agent, like the fetch (no git in B) —: refs, HEAD, stashes, configuration, exclude. This is the state “at freeze
//       time” against which the fetch of the new copy judges (stacks/fetch.js jobsFor: only new and moved things go to main
//       under its name; the template's work is fetched by the template). Read BEFORE the pause (at the closed barrier the
//       command would wait for itself) — a ref the template moves between read and pause is fetched by the new copy as
//       moved (twice, never lost);
//     - `objects/<part>` = hard links to `objects/<part>` of the TEMPLATE (linkObjects with its location as anchor) — the
//       same inodes as main; the objects the template wrote itself are in its `layer/<part>.objects` and come with the layer;
//     - `template: { name, instance }` in the snapshot: stacks/prepare.js then sets nothing up (the `.git` is there),
//       unpacks nothing and re-checks nothing — with a `base` it checks out and clears untracked files. `commit` is null.
//   Throws CodeError (`COPY_TEMPLATE`: the template's snapshot is foreign or malformed) or the errors of
//   readRepo/linkObjects.
//   → the summary like codeSnapshot, plus `template`.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MAIN } from "../projectbox/creation.js";
import { commitProjectRepo, searchProject, createProjectRepo, carriesProjectRepoMarker } from "../projectbox/projectRepo.js";
import { realRoots, entriesInArea, openFileWithoutReference } from "../runtime/real-path.js";
import { commandRun } from "../runtime/git-run.js";
import { prepareLayer, linkObjects } from "./objects.js";
import { baseOfTheRepo } from "./prepare.js";
import { CopyError } from "./state.js";
import { T } from "../i18n.js";

export const SNAPSHOT_VERSION = 1;
// Caps — ESTIMATED, NOT MEASURED; each with an environment knob, and their message says that it was a cap.
export const TAR_CAP = 2 * 1024 ** 3; //            CBASE_COPY_TAR_CAP (bytes per repo)
export const ROWS_CAP = 500_000; //               CBASE_COPY_ROWS_CAP (refs, status entries, config per repo)
export const OUTPUT_CAP = 64 * 1024 * 1024; //     output of the `sh -c` per repo
export const EXCLUDE_CAP = 1024 * 1024; //          info/exclude
export const REPO_CAP_MS = 300_000; //              CBASE_COPY_CODE_MS (one `sh -c` or one commit)
const count = (raw, preset) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : preset; };
const tarCap = () => count(process.env.CBASE_COPY_TAR_CAP, TAR_CAP);
const rowsCap = () => count(process.env.CBASE_COPY_ROWS_CAP, ROWS_CAP);
const repoCapMs = () => count(process.env.CBASE_COPY_CODE_MS, REPO_CAP_MS);

export class CodeError extends Error {
  constructor(message, code = "COPY_CODE") {
    super(message);
    this.name = "CodeError";
    this.code = code;
  }
}

// snapshot.json — new, 0600, never through a symlink (`wx`). ONE place for both ways (main and template): the path guard in
// server/backend/test/stacks-creation.test.js counts the writing calls per file.
function writeSnapshot(location, snapshot) {
  fs.writeFileSync(location.root.snapshot, `${JSON.stringify(snapshot)}\n`, { mode: 0o600, flag: "wx" });
}

/** THE reader of `snapshot.json` (see header). */
export function readSnapshot(location) {
  const fd = openFileWithoutReference(location.root.snapshot, realRoots([location.root.base], [location.root.base]));
  let s;
  try { s = JSON.parse(fs.readFileSync(fd, "utf8")); } finally { fs.closeSync(fd); }
  if (s?.version !== SNAPSHOT_VERSION || !Array.isArray(s.repos)) {
    throw new CopyError(T`Snapshot version ${s?.version ?? "—"} instead of ${SNAPSHOT_VERSION} — cannot be read`, { code: "COPY_PREPARE", status: 500 });
  }
  return s;
}

/** The clone helper's instance for runtime/git-run.js (projectbox/run-instance.js containerOf: `helperId`). */
export const helperInstance = (projectId, helper) => ({ projectId: String(projectId), instance: MAIN, identifier: `${projectId}/clone-helper`, helperId: String(helper?.id || "") });

// The gitlinks of the index (submodules): only the paths with mode 160000, NUL-separated — the list of all entries stays in
// the helper (it would be as large as the repo). No single quote: it sits inside a `'…'` of the `sh -c`.
const GITLINKS = String.raw`open(my $p, "-|", "git", "ls-files", "-s", "-z") or exit 25; while (my $z = <$p>) { chomp $z; print $1, "\0" if $z =~ /^160000 [0-9a-f]+ [0-3]\t(.*)\z/s; } close($p) or exit 25;`;
// With a base no status runs — the non-ignored embedded repos and worktrees (`x/`, git does not descend into them) then
// come from `ls-files --others`; without a base the status supplies them and a second walk through the tree is saved.
const EMBEDDED = String.raw`open(my $p, "-|", "git", "ls-files", "-z", "--others", "--exclude-standard") or exit 27; while (my $z = <$p>) { chomp $z; print $z, "\0" if $z =~ m{/\z}; } close($p) or exit 27;`;
// (c) The list: from the status the EXISTING paths (also a symlink without a target); folders ending in “/” (an untracked
// embedded repo or a worktree) are named by B. Then `ls-files -v -z`: lower-case letter = assume-unchanged, `S` =
// skip-worktree — git status does not check these files. Existing ⇒ into the list (tar) and `m <p>` into the ledger; missing
// with ONLY assume-unchanged (`h`) ⇒ `l <p>` (erase list); otherwise counted, last `f <count>`. Arguments: status file, ledger file.
const LIST = String.raw`my ($st, $vb) = @ARGV; my %seen;
open(my $s, "<", $st) or exit 23;
while (my $z = <$s>) { chomp $z; my $p; if ($z =~ /^1 /) { $p = (split / /, $z, 9)[8]; } elsif ($z =~ /^u /) { $p = (split / /, $z, 11)[10]; } elsif ($z =~ /^\? /) { $p = substr($z, 2); } else { next; }
  next if !defined($p) || $p =~ m{/\z}; $seen{$p} = 1; print $p, "\0" if -e $p || -l $p; }
close($s);
open(my $o, ">", $vb) or exit 23; binmode $o;
open(my $v, "-|", "git", "ls-files", "-v", "-z") or exit 23;
my $missing = 0;
while (my $z = <$v>) { chomp $z; next unless $z =~ /^([a-zS]) (.+)\z/s; my ($t, $p) = ($1, $2); next if $seen{$p}++;
  if (-l $p || (-e $p && !-d _)) { print $p, "\0"; print $o "m $p\0"; } elsif ($t eq "h") { print $o "l $p\0"; } else { $missing++; } }
close($v) or exit 23;
print $o "f $missing\0"; close($o) or exit 23;`;

// The ONE `sh -c` per repo. Arguments: $1 section marker, $2 status file, $3 list file, $4 tar file, $5 “1” = without open
// changes (base), $6 ledger of the hidden changes. The sections are on stdout, each after “\n<marker> <name>\n”; “end” says
// that (b) is complete. Exit 21–27: which step failed (stderr carries the message of git or tar).
export const SCRIPT = [
  'm="$1"; st="$2"; li="$3"; ta="$4"; bare="$5"; vb="$6"',
  'a() { printf \'\\n%s %s\\n\' "$m" "$1"; }',
  "a refs; git for-each-ref --format='%(refname)%00%(objectname)%00%(symref)' || exit 21",
  "a head; git symbolic-ref -q HEAD",
  "a oid; git rev-parse -q --verify HEAD",
  "a stash; git rev-list --walk-reflogs --count refs/stash 2>/dev/null || printf 0",
  "a config; git config --local -z --get-regexp '^(branch|remote)\\.'",
  "a exclude; if [ -f .git/info/exclude ] && [ ! -L .git/info/exclude ]; then cat .git/info/exclude; fi",
  `a gitlinks; perl -0 -e '${GITLINKS}' || exit 25`,
  "a worktrees; git worktree list --porcelain -z || exit 26",
  `a embedded; if [ "$bare" = 1 ]; then perl -0 -e '${EMBEDDED}' || exit 27; fi`,
  "a end",
  '[ "$bare" = 1 ] && exit 0',
  'git status --porcelain=v2 -z --untracked-files=all --no-renames --ignore-submodules=all > "$st" || exit 22',
  `perl -0 -e '${LIST}' "$st" "$vb" > "$li" || exit 23`,
  'tar --null --no-recursion -cf "$ta" -T "$li" || exit 24',
].join("\n");

// Step 1.0 of the header: the state of the project repo BEFORE “State before copy”. Argument $1: the text of the base ("" =
// none — the object does not name the project repo). `rev-parse -q --verify`: exit 1 means “does not know it”, anything
// above is an error (exit 31/32) — “unknown” is not “does not know it”. No leading “-” in the text (baseOfTheRepo), it is
// not an option.
export const BEFORE_COPY = [
  'b="$1"',
  'h=$(git rev-parse -q --verify "HEAD^{commit}"); r=$?; [ "$r" -le 1 ] || exit 31',
  'z=""; if [ -n "$b" ]; then z=$(git rev-parse -q --verify "$b^{commit}"); r=$?; [ "$r" -le 1 ] || exit 32; fi',
  "printf 'head=%s\\nbase=%s\\n' \"$h\" \"$z\"",
].join("\n");

async function readBeforeCopy({ helperInst, root, base }) {
  const b = baseOfTheRepo(base, ".");
  const r = await commandRun(helperInst, root, "sh", ["-c", BEFORE_COPY, "sh", b ? b.text : ""], {
    timeout: repoCapMs(), maxBuffer: 64 * 1024, env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, envAlways: ["GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT"],
  });
  if (r.code !== 0) {
    const step = { 31: "HEAD", 32: T("the base") }[r.code] || `Exit ${r.code ?? r.signal ?? "?"}`;
    throw new CodeError(T`Project folder: the state before “State before copy” cannot be read in the clone helper (${step})${r.cap ? ` — ${r.cap === "deadline" ? T("time cap") : T("output cap")}` : ""}: ${String(r.stderr || "").trim().split("\n").slice(-2).join(" | ").slice(0, 400)}`);
  }
  const rows = String(r.stdout || "").split("\n");
  const value = (k) => {
    const z = rows.filter((x) => x.startsWith(`${k}=`));
    const v = z.length === 1 ? z[0].slice(k.length + 1) : null;
    if (v === null || !(v === "" || HEX.test(v))) throw new CodeError(T`Project folder: the state before “State before copy” — “${k}” is not an id (${JSON.stringify(String(r.stdout || "").slice(0, 200))})`);
    return v || null;
  };
  return { head: value("head"), base: value("base"), text: b ? b.text : null };
}

// ── Checks (step 4) ──────────────────────────────────────────────────────────────────────────────────────────────────

const HEX = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
/** The rules of `git check-ref-format` for a full ref name (refs/…), without --normalize and without --allow-onelevel. */
export function refValid(name) {
  const n = String(name ?? "");
  if (!n.startsWith("refs/") || n.endsWith("/") || n.endsWith(".") || n === "@") return false;
  if (n.includes("..") || n.includes("@{") || n.includes("//")) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(n)) return false;
  return n.split("/").every((t) => t && !t.startsWith(".") && !t.endsWith(".lock"));
}
const utf8 = new TextDecoder("utf-8", { fatal: true });
function checkPath(p, repo) {
  if (!p || p.startsWith("/") || /[\n\r\0]/.test(p) || p.includes(String.fromCharCode(0xfffd)) || p.split("/").some((t) => t === ".." || t === "")) {
    throw new CodeError(T`${repo}: path ${JSON.stringify(p)} is not relative, is empty, has “..” or a line break — not taken over`);
  }
  return p;
}
function pathFrom(buf, repo) {
  let p;
  try { p = utf8.decode(buf); } catch { throw new CodeError(T`${repo}: a path is not UTF-8 — not taken over`); }
  return checkPath(p, repo);
}
const nulParts = (buf) => {
  const parts = [];
  let a = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0) { parts.push(buf.subarray(a, i)); a = i + 1; }
  if (a < buf.length) parts.push(buf.subarray(a));
  return parts;
};

// A file from `open/` that the helper wrote: through the descriptor, never through a symlink (a process in the helper
// could replace it), regular files only, with a cap.
function readOpen(file, open, cap, repo) {
  const fd = openFileWithoutReference(file, realRoots([open], [open]));
  try {
    const size = fs.fstatSync(fd).size;
    if (size > cap) throw new CodeError(T`${repo}: ${path.basename(file)} has ${size} bytes — cap ${cap} (estimated, not measured) reached, aborted`, "COPY_CAP");
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
// Size and identifier (inode, ctime, mtime in ns) of a file from `open/` — through the descriptor, never through a symlink.
function identifierOpen(file, open) {
  const fd = openFileWithoutReference(file, realRoots([open], [open]));
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    return { size: Number(st.size), identifier: { ino: String(st.ino), ctime: String(st.ctimeNs), mtime: String(st.mtimeNs) } };
  } finally { fs.closeSync(fd); }
}

/** Every tar in `open/`, AFTER the clone helper was emptied (no process of main lives in it any more), against the size and
 *  identifier from `snapshot.json`. Until then a hook of main that kept running in the helper could replace the checked tar
 *  or let it grow — the cap would then not hold. Throws CodeError `COPY_TAR_CHANGED`. After that only B writes to `open/`
 *  (and nothing does). */
export function checkOpenAfterClear(location) {
  const s = JSON.parse(fs.readFileSync(location.root.snapshot, "utf8"));
  for (const r of s.repos || []) {
    if (!r.open) continue;
    const repo = r.rel === "." ? T("Project folder") : r.rel;
    const now = identifierOpen(path.join(location.root.open, path.basename(r.open.tar)), location.root.open);
    if (now.size !== r.open.size || JSON.stringify(now.identifier) !== JSON.stringify(r.open.identifier)) {
      throw new CodeError(T`${repo}: the tar of the open changes changed after its check (${r.open.size} → ${now.size} bytes, inode/times ${JSON.stringify(now.identifier) === JSON.stringify(r.open.identifier) ? "equal" : "different"}) — a process in the clone helper wrote it, not taken over`, "COPY_TAR_CHANGED");
    }
  }
}

function sections(stdout, marker, repo) {
  const parts = String(stdout).split(`\n${marker} `);
  const out = {};
  for (const t of parts.slice(1)) {
    const i = t.indexOf("\n");
    const name = i < 0 ? t : t.slice(0, i);
    out[name] = i < 0 ? "" : t.slice(i + 1);
  }
  for (const k of ["refs", "head", "oid", "stash", "config", "exclude", "gitlinks", "worktrees", "embedded", "end"]) {
    if (!(k in out)) throw new CodeError(T`${repo}: the read bundle has no section “${k}” — no snapshot`);
  }
  return out;
}

function readBundle(a, repo) {
  const cap = rowsCap();
  const noReplacementChar = (text, what) => { if (text.includes("�")) throw new CodeError(T`${repo}: ${what} is not UTF-8 — not taken over`); };
  noReplacementChar(a.refs, T("a ref name"));
  const rows = a.refs.split("\n").filter(Boolean);
  if (rows.length > cap) throw new CodeError(T`${repo}: ${rows.length} refs — cap ${cap} (estimated, not measured; CBASE_COPY_ROWS_CAP) reached, aborted`, "COPY_CAP");
  const refs = rows.map((z) => {
    const [name, oid, symref, ...rest] = z.split("\0");
    if (rest.length || !refValid(name) || !(HEX.test(oid) || (symref && oid === "")) || (symref && !refValid(symref))) {
      throw new CodeError(T`${repo}: ref line ${JSON.stringify(z.slice(0, 200))} violates check-ref-format or carries no id — not taken over`);
    }
    return { name, oid: oid || null, symref: symref || null };
  });
  const symref = a.head.trim();
  if (symref && !refValid(symref)) throw new CodeError(T`${repo}: HEAD points to ${JSON.stringify(symref)} — not a valid ref`);
  const oid = a.oid.trim();
  if (oid && !HEX.test(oid)) throw new CodeError(T`${repo}: HEAD id ${JSON.stringify(oid)} is not an id`);
  const stash = Number(a.stash.trim() || "0");
  if (!Number.isInteger(stash) || stash < 0) throw new CodeError(T`${repo}: number of stashes ${JSON.stringify(a.stash.trim())} is not a number`);
  noReplacementChar(a.config, T("the configuration"));
  const entries = a.config.split("\0").filter(Boolean);
  if (entries.length > cap) throw new CodeError(T`${repo}: ${entries.length} entries branch./remote. — cap ${cap} reached, aborted`, "COPY_CAP");
  const config = entries.map((e) => {
    const i = e.indexOf("\n");
    const k = i < 0 ? e : e.slice(0, i);
    const v = i < 0 ? null : e.slice(i + 1);
    if (!/^(branch|remote)\.[^\n\r]+$/.test(k) || (v !== null && /[\n\r]/.test(v))) throw new CodeError(T`${repo}: configuration ${JSON.stringify(k.slice(0, 120))} has a line break — not taken over`);
    return [k, v];
  });
  if (Buffer.byteLength(a.exclude) > EXCLUDE_CAP) throw new CodeError(T`${repo}: info/exclude larger than ${EXCLUDE_CAP} bytes — cap reached, aborted`, "COPY_CAP");
  noReplacementChar(a.exclude, "info/exclude");
  // Gitlinks (submodules): relative to the repo, no duplicates (a conflict carries several stages).
  const gl = a.gitlinks.split("\0").filter(Boolean);
  if (gl.length > cap) throw new CodeError(T`${repo}: ${gl.length} gitlinks — cap ${cap} (estimated, not measured; CBASE_COPY_ROWS_CAP) reached, aborted`, "COPY_CAP");
  const gitlinks = [...new Set(gl.map((p) => checkPath(p, repo)))].sort();
  // Linked worktrees: absolute paths, each record starts with “worktree <path>”; `prunable` (the folder is gone) does not
  // count. A path is only checked in codeSnapshot — only one below the project folder concerns the copy.
  const worktrees = [];
  for (const z of a.worktrees.split("\0")) {
    if (z.startsWith("worktree ")) worktrees.push({ path: z.slice(9), prunable: false });
    else if (worktrees.length && (z === "prunable" || z.startsWith("prunable "))) worktrees[worktrees.length - 1].prunable = true;
  }
  if (worktrees.length > cap) throw new CodeError(T`${repo}: ${worktrees.length} worktrees — cap ${cap} (estimated, not measured; CBASE_COPY_ROWS_CAP) reached, aborted`, "COPY_CAP");
  // Only filled with a base (otherwise the status supplies them): `x/` per entry.
  noReplacementChar(a.embedded, T("an embedded repo"));
  const eb = a.embedded.split("\0").filter(Boolean);
  if (eb.length > cap) throw new CodeError(T`${repo}: ${eb.length} embedded repos — cap ${cap} (estimated, not measured; CBASE_COPY_ROWS_CAP) reached, aborted`, "COPY_CAP");
  const embedded = [...new Set(eb.map((p) => {
    if (!p.endsWith("/")) throw new CodeError(T`${repo}: embedded repo ${JSON.stringify(p.slice(0, 200))} without “/” — not taken over`);
    return checkPath(p.slice(0, -1), repo);
  }))].sort();
  return {
    head: { symref: symref || null, oid: oid || null }, refs, stash, config, exclude: a.exclude,
    gitlinks, worktrees: worktrees.filter((w) => !w.prunable).map((w) => w.path), embedded,
  };
}

// The ledger of the hidden changes: `m <p>` in the tar, `l <p>` erased, `f <count>` missing and only counted.
function readHidden(ledger, repo) {
  const cap = rowsCap();
  const sets = nulParts(ledger);
  if (sets.length > cap + 1) throw new CodeError(T`${repo}: ${sets.length} entries with assume-unchanged/skip-worktree — cap ${cap} (estimated, not measured; CBASE_COPY_ROWS_CAP) reached, aborted`, "COPY_CAP");
  const result = { including: [], erased: [], missing: null };
  for (const s of sets) {
    const kind = String.fromCharCode(s[0] ?? 0x20);
    if (s[1] !== 0x20) throw new CodeError(T`${repo}: line of the hidden changes without a kind — not taken over`);
    if (kind === "m") result.including.push(pathFrom(s.subarray(2), repo));
    else if (kind === "l") result.erased.push(pathFrom(s.subarray(2), repo));
    else if (kind === "f" && result.missing === null && /^(0|[1-9][0-9]*)$/.test(s.subarray(2).toString("latin1"))) result.missing = Number(s.subarray(2).toString("latin1"));
    else throw new CodeError(T`${repo}: unexpected line of the hidden changes “${kind}” — not taken over`);
  }
  if (result.missing === null) throw new CodeError(T`${repo}: the ledger of the hidden changes is incomplete — not taken over`);
  return result;
}

// The status (porcelain v2, -z), the list of the existing paths and the ledger of the hidden changes →
// { paths, erase, embedded, hidden, hiddenMissing }.
function readOpenChanges({ status, list, ledger, repo }) {
  const cap = rowsCap();
  const sets = nulParts(status);
  if (sets.length > cap) throw new CodeError(T`${repo}: ${sets.length} status entries — cap ${cap} (estimated, not measured; CBASE_COPY_ROWS_CAP) reached, aborted`, "COPY_CAP");
  const tracked = [];
  const embedded = [];
  for (const s of sets) {
    const kind = String.fromCharCode(s[0] ?? 0x20);
    if (s[1] !== 0x20) throw new CodeError(T`${repo}: status line without a kind — not taken over`);
    if (kind === "1" || kind === "u") {
      // Fields separated by spaces, the path last (it may contain spaces).
      const before = kind === "1" ? 8 : 10;
      let i = 0;
      for (let n = 0; n < before; n++) { i = s.indexOf(0x20, i) + 1; if (i <= 0) throw new CodeError(T`${repo}: status line truncated — not taken over`); }
      tracked.push(pathFrom(s.subarray(i), repo));
    } else if (kind === "?") {
      // `? x/`: a non-ignored embedded repo or a linked worktree — git does not descend into it, the perl leaves it out of
      // the tar; B names it.
      const folder = s.length > 3 && s[s.length - 1] === 0x2f;
      const p = pathFrom(folder ? s.subarray(2, s.length - 1) : s.subarray(2), repo);
      if (folder) embedded.push(p);
    } else {
      // `2` (rename) does not occur with --no-renames, `!` only with --ignored, `#` only with --branch.
      throw new CodeError(T`${repo}: unexpected status kind “${kind}” — not taken over`);
    }
  }
  const paths = nulParts(list).map((b) => pathFrom(b, repo));
  if (paths.length > cap) throw new CodeError(T`${repo}: ${paths.length} open paths — cap ${cap} reached, aborted`, "COPY_CAP");
  const existing = new Set(paths);
  const v = readHidden(ledger, repo);
  for (const p of v.including) if (!existing.has(p)) throw new CodeError(T`${repo}: ${JSON.stringify(p)} is in the ledger of the hidden changes but not in the list — not taken over`);
  const erase = [...new Set([...tracked.filter((p) => !existing.has(p)), ...v.erased])].sort();
  return { paths, erase, embedded: [...new Set(embedded)].sort(), hidden: [...v.including].sort(), hiddenMissing: v.missing };
}

// ── The procedure ───────────────────────────────────────────────────────────────────────────────────────────────────

const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e?.code === "ENOENT") return null; throw e; } };

async function readRepo({ helperInst, abs, part, rel, location, withoutOpen }) {
  const marker = `@@cbase-${crypto.randomBytes(12).toString("hex")}@@`;
  const file = (suffix) => path.join(location.root.open, `${part}.${suffix}`);
  const repo = rel === "." ? T("Project folder") : rel;
  const r = await commandRun(helperInst, abs, "sh", ["-c", SCRIPT, "sh", marker, file("status"), file("list"), file("tar"), withoutOpen ? "1" : "0", file("hidden")], {
    timeout: repoCapMs(), maxBuffer: OUTPUT_CAP, env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, envAlways: ["GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT"],
  });
  if (r.code !== 0) {
    const step = { 21: "for-each-ref", 22: "status", 23: T("list of the open paths"), 24: "tar", 25: "Gitlinks (ls-files -s)", 26: "worktree list", 27: T("embedded repos (ls-files --others)") }[r.code] || `Exit ${r.code ?? r.signal ?? "?"}`;
    throw new CodeError(T`${repo}: code snapshot in the clone helper failed (${step})${r.cap ? ` — ${r.cap === "deadline" ? T("time cap") : T("output cap")}` : ""}: ${String(r.stderr || "").trim().split("\n").slice(-2).join(" | ").slice(0, 400)}`);
  }
  const { gitlinks, worktrees, embedded: ebBase, ...b } = readBundle(sections(r.stdout, marker, repo), repo);
  let open = null;
  let embedded = ebBase;
  if (!withoutOpen) {
    const o = readOpenChanges({
      status: readOpen(file("status"), location.root.open, OUTPUT_CAP * 4, repo),
      list: readOpen(file("list"), location.root.open, OUTPUT_CAP * 4, repo),
      ledger: readOpen(file("hidden"), location.root.open, OUTPUT_CAP * 4, repo),
      repo,
    });
    const { size, identifier } = identifierOpen(file("tar"), location.root.open);
    if (size > tarCap()) throw new CodeError(T`${repo}: the tar of the open changes has ${size} bytes — cap ${tarCap()} (estimated, not measured; CBASE_COPY_TAR_CAP) reached, aborted`, "COPY_CAP");
    open = { tar: path.basename(file("tar")), size, identifier, paths: o.paths, erase: o.erase, hidden: o.hidden, hiddenMissing: o.hiddenMissing }; // identifier: see checkOpenAfterClear
    embedded = o.embedded;
  }
  return { read: { ...b, open }, inside: { embedded, gitlinks, worktrees } };
}

// 4a. The repos INSIDE a part — relative to the project folder; a worktree only below the project folder.
function reposInPart(t, inside, root, gitKind) {
  const under = (p) => (t.rel === "." ? p : path.posix.join(t.rel, p));
  const repo = t.rel === "." ? T("Project folder") : t.rel;
  const out = [];
  for (const e of inside.embedded) {
    const kind = gitKind(path.join(root, under(e)));
    out.push({ rel: under(e), reason: kind === "gitfile" || kind === "reference" ? kind : "embedded" });
  }
  for (const g of inside.gitlinks) out.push({ rel: under(g), reason: "submodule" });
  for (const w of inside.worktrees) {
    const rel = path.relative(root, path.resolve(w));
    if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    out.push({ rel: checkPath(rel.split(path.sep).join("/"), repo), reason: "worktree" });
  }
  return out;
}

// A project folder that was relocated EMPTY got no project repo (an empty folder is often the target of a `git clone <url>
// <path>`). If it carries something since, without being a repo itself or lying inside one, the repo is created BEFORE the
// copy: the same rule as in the relocation, in the helper, before the pause (the first commit takes everything; in the pause
// only “State before copy <name>” follows). Without it the files next to the code repos would have no state of their own in
// the copy — they would show through from main — and the fetch no way back. A folder that is still empty stays without. If
// the creation fails, the `.git` is removed again (createProjectRepo).
// → { created: true, commit } | { created: false, reason: "marker" | "repo" | "in-repo" | "empty" }
export async function projectRepoBeforeCopy({ projectId, name, projectPath, helper }) {
  const root = path.resolve(String(projectPath || ""));
  if (carriesProjectRepoMarker(root)) return { created: false, reason: "marker" };
  if (lstatOrNull(path.join(root, ".git"))) return { created: false, reason: "repo" };
  if (!entriesInArea(root, realRoots([root], [root])).length) return { created: false, reason: "empty" };
  const r = await createProjectRepo(root, { instance: helperInstance(projectId, helper), message: `Project repo created before copy ${name}` });
  return r.created ? { created: true, commit: r.commit } : { created: false, reason: r.reason };
}

export async function codeSnapshot({ projectId, name, projectPath, location, helper, base = null, note = null }) {
  const root = path.resolve(String(projectPath || ""));
  const helperInst = helperInstance(projectId, helper);
  const withoutOpen = base !== null && base !== undefined;
  const state = { part: "", commit: null, finished: [] };
  const remember = async (more) => { Object.assign(state, more); if (note) await note({ ...state }); };

  // 1. Project repo first: the commit (a) in the helper — its repo list comes from searchProject in the helper.
  const projectRepo = carriesProjectRepoMarker(root);
  let list;
  let commit = null;
  let beforeCopy = null;
  if (projectRepo) {
    await remember({ part: "projectRepo" });
    // 1.0 with a base the state BEFORE the own commit — the base in the project repo is judged against it.
    if (withoutOpen) beforeCopy = await readBeforeCopy({ helperInst, root, base });
    const c = await commitProjectRepo(root, `State before copy ${name}`, { empty: true, instance: helperInst });
    commit = c.commit;
    list = { repos: c.repos, unreadable: c.unreadable };
    await remember({ commit });
  } else {
    await remember({ part: "search" });
    list = await searchProject(root, { instance: helperInst });
  }

  // 2. The parts.
  const notLinked = [];
  const parts = [];
  const gitKind = (dir) => { const st = lstatOrNull(path.join(dir, ".git")); return !st ? null : st.isDirectory() && !st.isSymbolicLink() ? "folder" : st.isSymbolicLink() ? "reference" : "gitfile"; };
  const kindP = gitKind(root);
  if (kindP === "folder") parts.push({ part: "p", rel: ".", abs: root, projectRepo });
  else if (kindP) notLinked.push({ rel: ".", reason: kindP });
  for (const rel of list.repos) {
    const abs = path.join(root, rel);
    const kind = gitKind(abs);
    if (kind === "folder") parts.push({ part: `r${parts.filter((t) => t.part !== "p").length}`, rel, abs, projectRepo: false });
    else notLinked.push({ rel, reason: kind || "gone" });
  }

  // 3.–5. Per repo: read bundle and tar in the helper, check, objects, upper layer.
  const repos = [];
  const inPart = [];
  for (const t of parts) {
    await remember({ part: t.part });
    const { read, inside } = await readRepo({ helperInst, abs: t.abs, part: t.part, rel: t.rel, location, withoutOpen });
    inPart.push(...reposInPart(t, inside, root, gitKind));
    const objects = await linkObjects({ source: path.join(t.abs, ".git", "objects"), target: location.root.objects(t.part), repo: t.rel === "." ? T("Project folder") : t.rel, anchor: root });
    const shallow = Boolean(lstatOrNull(path.join(t.abs, ".git", "shallow")));
    prepareLayer({ layer: location.root.layer(t.part), shallow: shallow ? path.join(t.abs, ".git", "shallow") : null, anchor: root });
    const lfs = Boolean(lstatOrNull(path.join(t.abs, ".git", "lfs")));
    repos.push({ part: t.part, rel: t.rel, projectRepo: t.projectRepo, ...read, objects, shallow, lfs, ...(t.projectRepo && beforeCopy ? { beforeCopy } : {}) });
    await remember({ finished: [...state.finished, t.part] });
  }
  // 4a. Add the repos inside the parts — no duplicates: a part or something already named (e.g. a worktree the search found
  // as a gitfile) stays as it is.
  const known = new Set([...parts.map((t) => t.rel), ...notLinked.map((x) => x.rel)]);
  for (const x of inPart) if (!known.has(x.rel)) { known.add(x.rel); notLinked.push(x); }
  if (notLinked.length > rowsCap()) throw new CodeError(T`${notLinked.length} repos without a snapshot of their own — cap ${rowsCap()} (estimated, not measured; CBASE_COPY_ROWS_CAP) reached, aborted`, "COPY_CAP");

  // 6. snapshot.json — new, 0600, never through a symlink.
  const snapshot = {
    version: SNAPSHOT_VERSION, projectId: String(projectId), name: String(name), time: new Date().toISOString(), base: withoutOpen,
    projectRepo, commit, repos, notLinked, unreadable: list.unreadable || [],
  };
  writeSnapshot(location, snapshot);
  await remember({ part: "finished" });
  return {
    version: SNAPSHOT_VERSION, projectRepo, commit, notLinked,
    repos: repos.map((r) => ({
      part: r.part, rel: r.rel, refs: r.refs.length, stash: r.stash,
      open: r.open ? { paths: r.open.paths.length, erase: r.open.erase.length, size: r.open.size, hidden: r.open.hidden.length, hiddenMissing: r.open.hiddenMissing } : null,
      objects: { files: r.objects.files, copied: r.objects.copied, alternates: r.objects.alternates, promisor: r.objects.promisor }, shallow: r.shallow, lfs: r.lfs,
      ...(r.beforeCopy ? { beforeCopy: r.beforeCopy } : {}),
    })),
  };
}

// ── Copy from a copy (header: templateSnapshot) ────────────────────────────────────────────────────────────────────

const PART = /^(p|r(0|[1-9][0-9]*))$/;
export async function templateSnapshot({ projectId, name, projectPath, location, template, base = null, note = null }) {
  const root = path.resolve(String(projectPath || ""));
  const where = T`Template “${template?.name}”`;
  if (!template?.inst || !template?.location || !template?.instance) throw new TypeError("templateSnapshot: no template (name, instance, inst, location)");
  const state = { part: "", template: template.name, finished: [] };
  const remember = async (more) => { Object.assign(state, more); if (note) await note({ ...state }); };

  await remember({ part: "template" });
  const s = readSnapshot(template.location);
  if (String(s.projectId) !== String(projectId) || String(s.name) !== String(template.name)) {
    throw new CodeError(T`${where}: its snapshot names ${s.projectId}/${s.name} — not this template, nothing taken over`, "COPY_TEMPLATE");
  }
  const seen = new Set();
  for (const r of s.repos) {
    if (!PART.test(String(r?.part)) || seen.has(r.part) || typeof r.rel !== "string" || !r.rel) {
    throw new CodeError(T`${where}: part ${JSON.stringify(r?.part)} (${JSON.stringify(r?.rel)}) does not have the form of a part or occurs twice — nothing taken over`, "COPY_TEMPLATE");
    }
    seen.add(r.part);
    if (r.rel !== ".") checkPath(r.rel, where);
  }

  const repos = [];
  for (const r of s.repos) {
    await remember({ part: r.part });
    const abs = r.rel === "." ? root : path.join(root, r.rel);
    const { read } = await readRepo({ helperInst: template.inst, abs, part: r.part, rel: r.rel, location, withoutOpen: true });
    const objects = await linkObjects({ source: template.location.root.objects(r.part), target: location.root.objects(r.part), repo: r.rel === "." ? T("Project folder") : r.rel, anchor: template.location.root.base });
    repos.push({ part: r.part, rel: r.rel, projectRepo: Boolean(r.projectRepo), ...read, objects, shallow: Boolean(r.shallow), lfs: Boolean(r.lfs) });
    await remember({ finished: [...state.finished, r.part] });
  }
  const snapshot = {
    version: SNAPSHOT_VERSION, projectId: String(projectId), name: String(name), time: new Date().toISOString(), base: base !== null && base !== undefined,
    projectRepo: Boolean(s.projectRepo), commit: null, repos, notLinked: Array.isArray(s.notLinked) ? s.notLinked : [],
    unreadable: Array.isArray(s.unreadable) ? s.unreadable : [], template: { name: String(template.name), instance: String(template.instance) },
  };
  writeSnapshot(location, snapshot);
  await remember({ part: "finished" });
  return {
    version: SNAPSHOT_VERSION, projectRepo: snapshot.projectRepo, commit: null, notLinked: snapshot.notLinked, template: snapshot.template,
    repos: repos.map((r) => ({
      part: r.part, rel: r.rel, refs: r.refs.length, stash: r.stash, open: null,
      objects: { files: r.objects.files, copied: r.objects.copied, alternates: r.objects.alternates, promisor: r.objects.promisor }, shallow: r.shallow, lfs: r.lfs,
    })),
  };
}
