// The return-path helper of a copy. The mechanics shared by fetch (stacks/fetch.js) and clear-away (stacks/clearAway.js): a
// helper of kind `returnPath` (projectbox/helper.js: helper labels only, `--network none`) and the ONE program that runs in it.
//
// NO GIT IN B. git runs in the helper as agent (runtime/git-run.js commandRun with the helper instance from
// stacks/code-snapshot.js helperInstance — hooks of main therefore run in the helper, never in B); the upper layer is read
// by the program as root (executeHelper), where it only reads and lists. B only reads outputs.
//
// withReturnPathHelper({ copy, location, projectPath, snapshot, home, system }, fn)
//   Starts the helper, calls `fn({ helper, helperInst })`, removes it in the finally. EVERYTHING is mounted at the SAME path
//   as in B (pattern of the clone helper, stacks/freeze.js — git and the wrapper see the paths unchanged, and relative
//   alternates hold in B and in the helper alike): the project folder rw (fetch into main's repos, merging the project repo,
//   retrieving), main's runtime folder rw (pgid file of the wrapper), `/usr/local/bin` read-only, `~/.gitconfig` read-only;
//   per part of the snapshot `objects/<part>`, `layer/<part>.objects` and `layer/<part>` READ-ONLY (the two object layers
//   of the alternates, the upper layer for lists, LFS and retrieving), `layer/p` also without a repo; the return-path
//   folder rw (the empty repos); the backup folder read-only if it exists (cloning a bundle). What does not exist is not
//   mounted (the helper checks bind sources).
//
// THE PROGRAM (RETURN_PATH_PROGRAM, python3 in the image cbase-projectbox), one command per call:
//   list    (root) the upper layer of a part — `layerList` below.
//   tar     (root) selected files of upper layers as ONE tar on stdout — `tarOfTheLayers` below.
//   lfs     (agent) new LFS objects of the copy into main — `copyLfs` below.
//   back    (agent) named paths of the upper layer into the project folder — `copyBack`.
//   fetch   (agent, in main's repo; argv: the empty repo = the source of every fetch) empty repo, refs, fetch without `+`,
//           fallback ref — `fetchIntoMain`.
//   merge   (agent, in the project folder) merge the copy's project repo — `mergeTogether`.
//   clones  (agent) clone a bundle of a new repo onto a FREE path — `clonesBundle`.
//   size    (agent) the bytes below named paths, lstat only — `sizeIn`, the basis of `returnPathDeadline`.
//   Every git in it runs with `-c transfer.fsckObjects=true -c fetch.fsckObjects=true`, `GIT_NO_LAZY_FETCH=1`,
//   `GIT_TERMINAL_PROMPT=0` and WITHOUT the redirectors from projectbox/projectRepo.js GIT_REDIRECTOR (removed in the program
//   itself: the wrapper's allow-list cannot transport “unset”). `fetch.fsckObjects=true` in addition to `transfer.fsckObjects`
//   — a `fetch.fsckObjects=false` in main's configuration would otherwise win over `transfer`. No git reads a configuration
//   of the copy: the source is never its repo, the empty repo has cbase's configuration (`init --template=`, fresh at every
//   fetch).
//   What every command brings: SIGTERM (the cap of asAgent) becomes SystemExit — every `finally` clears its leftover;
//   nothing is written DIRECTLY to a target path in main but into a leftover next to it (fixed name per copy and path, so
//   that the leftover of a killed run — SIGKILL — is replaced by the next one) and only moved into place when complete (file
//   `link`: EEXIST ⇒ occupied, never overwrites; folder `rename` after lexists); `os.write` until everything is written. An
//   entry that disappears or is unreadable while listing does not abort the list. What is moved into place is durable —
//   `sync_folder` (fsync of the folder) after every `link`/`rename` on the parent folder, every file of a copied folder with
//   fsync, every created folder before the `rename`, every newly created level on its parent; `clones` with
//   `-c core.fsync=committed`. The program's own texts (reasons, notices) are English and are part of its output contract.
//
// layerList(helper, path, { without, cap, bytes, depCap }) → { files, dependent, deleted, opaque, special, unreadable,
//   gitInside, depIncomplete }
//   per entry relative to `path`, sorted. `files` regular files and symlinks; `dependent` dependency folders
//   (projectRepo.js DEPENDENCIES — named as a WHOLE, not entered); `deleted` whiteouts (deleted in the copy, NEVER executed
//   in main); `opaque` opaque folders (main below is invisible to the copy); `special` FIFO/socket/device; `unreadable`
//   folders. `without`: relative paths that are neither named nor entered (`.git`, `.git` of new repos). A whiteout is the
//   real thing: character device 0/0 or an empty file with `user.overlay.whiteout`; opaque `user.overlay.opaque=y`.
//   TEST SEAM (the same as stacks/objects.js setOpaque): with CBASE_COPY_OPAQUE_PROGRAM the program reads the markers that
//   one writes and that the copy view of the fake docker speaks — `.wh.<n>` and `.wh..wh..opq` (macOS knows neither
//   `os.getxattr` nor device files for the user). Cap LAYER_CAP entries (knob CBASE_COPY_LAYER_CAP) with a message; the end
//   carries a marker — a truncated list is an error, never a shorter list. Plus LAYER_BYTES_CAP bytes (knob
//   CBASE_COPY_LAYER_BYTES, marker `!bytes`) — the whole list comes to B as ONE string; the output cap of the docker seam
//   follows it (`maxBytes`), and if it hits anyway that is COPY_CAP too. An entry that disappears between listdir and lstat
//   is missing; one that lstat/listdir cannot handle otherwise (ENAMETOOLONG, EACCES) is under `unreadable`. In a
//   dependency folder the program searches ONLY for `.git` — per find `gitInside` (record `i`, the folder WITH the `.git`):
//   a repo the agent created in `node_modules/lib` would otherwise bypass every backup. Every visited entry counts against
//   DEP_SEARCH_CAP (`depCap`, knob CBASE_COPY_DEP_SEARCH_CAP), not against the list cap; reached ⇒ `depIncomplete` (record
//   `x`, the dependency folder) instead of aborting the whole list — the fetch goes on, the clear-away stops at it. A name
//   that is not UTF-8 or carries `\n`/`\r` comes as `F<json>` (surrogateescape, layerSets); whoever passes it to a process
//   passes nameBytes/nulBytes (bytes, never JS text: git would not find U+FFFD).
// layerSets(stdout, path), nameBytes(s), nulBytes(xs) — the pure parts of it, see there.
// fetchIntoMain({ helperInst, location, part, mainPath, refs, jobs }) → [{ source, target, oid, prior, ok, fallback, notice, paths }]
//   `refs` [[name, oid]] (checked by B: refValid, hex) go into the empty repo of the part (alternates RELATIVE, lower layer
//   `objects/<part>` first, then `layer/<part>.objects`), before that EVERY id through `cat-file --batch-check` — if one is
//   missing, `CopyError` COPY_OBJECT_MISSING and nothing fetched. Per job `{ source, target, oid, onlyNew, base }`: `fetch
//   --no-tags --no-write-fetch-head --no-recurse-submodules --no-auto-maintenance <empty repo> <source>:<target>` WITHOUT
//   `+`; rejected (not fast-forwardable, occupied, D/F conflict, checked out) ⇒ `<target>-<n>` (up to FALLBACK_MAX). If an
//   ANCESTOR of the target exists as a file ref (`copy/k1/a` from an earlier fetch, now `a/b`), no `-<n>` below it would
//   help — the fallback target is then flat `copy/k1/a--b`; `notice` names error:/fatal: first, without hint:/From lines.
//   `onlyNew` (the WIP targets): an existing target with ANOTHER id counts as occupied even if it could be fast-forwarded —
//   a backup never pushes a branch forward. Every other error (fsck, missing object) ends only this job (`ok: false`,
//   `notice`). With `base` afterwards `diff --name-only` base..oid (`paths`, the trap of fetch.js).
// mergeTogether({ helperInst, projectPath, target, oid, onlyCheck, fromOf }) → { already } | { foreign } | { gitlinks } |
//   { free } | { merged, notice }
//   `fromOf` (only with `onlyCheck`): if `oid` does not descend from this commit (`merge-base --is-ancestor fromOf oid` ≠ 0),
//   `foreign: true` with `notice` — the detached tip of a copy's project repo is only merged if it sits on the copy's start
//   point (project-repo-copy.js).
//   `onlyCheck`: is `oid` already an ancestor of HEAD (`already: true`); does the tree of ANY of the commits a merge would
//   bring (`rev-list <oid> --not HEAD` — not only the tip) carry a gitlink (`gitlinks`, mode 160000 — then never merge)?
//   Otherwise `merge --no-edit <target>`. BEFORE the merge `merge-tree --write-tree` in memory — a conflict ⇒ `merged:
//   false`, nothing touched in main (a `merge --abort` would delete an ignored file the conflict brought into play); every
//   path the merge would ADD (`diff --name-status` A) that already lies in main (untracked/ignored, e.g. `.env`) ⇒ `merged:
//   false`; the merge itself with `--no-overwrite-ignore`. HEAD is read ONCE (h0), all checks run against h0, and once more
//   right before the merge — if main moved in between, `merged: false`; `merge --abort` only with an existing MERGE_HEAD
//   and ORIG_HEAD == h0. The whole command runs with `GIT_LFS_SKIP_SMUDGE=0` and `GIT_LFS_SKIP_DOWNLOAD_ERRORS=1` — a path
//   with `filter=lfs` gets the CONTENT in main where `copyLfs` put the object, otherwise the pointer.
// clonesBundle({ helperInst, projectPath, bundle, rel }) → { cloned, wip } | { cloned: false, reason }
//   only onto a FREE path (lexists ⇒ `occupied`), every existing level from the project folder on a real folder (otherwise
//   `reference`), a missing one is created; `clone`, then all branches and the refs `refs/cbase/*` of the bundle (the WIP
//   backup) as refs of its own, then without `origin` (a clone from a bundle would otherwise have only HEAD's branch locally).
// copyLfs({ helperInst, location, part, mainPath }) → { copied, existing, denied }: every file under
//   `layer/<part>/.git/lfs/objects/<aa>/<bb>/<sha256>` whose content has exactly this sha256 and that is missing in main,
//   into `<main>/.git/lfs/objects/…` (never through a symlink); everything else denied. An existing object is not read
//   (`existing`); lstat before opening (regular files only), `O_NOFOLLOW|O_NONBLOCK` (a FIFO never blocks), streamed into a
//   leftover `.cbase-lfs-<marker>-<sha>.tmp` (marker = source), hash AND size checked, fsync, then `link` under the sha
//   name — a truncated write never renames anything; old leftovers are cleared by the next run. A read/write error ⇒
//   `error` in the program ⇒ CopyError COPY_LFS (the caller stays “pending”).
// copyBack({ helperInst, source, target, rels }) → { back, denied, error }: per named path from the upper layer into the
//   project folder, ONLY onto a free path (never overwrite — that too would be a deletion in main), no level a symlink (in
//   the layer as in main), symlinks INSIDE a named folder denied, mode and times kept, no xattrs. Built in the leftover
//   `.cbase-back-<sha(source, rel)>.tmp` next to the target (folders with 0700, modes only at the end), then
//   `link`/`rename` — a read/write error anywhere in it (unreadable subfolder, ENOSPC, SIGTERM) leaves NOTHING under the
//   path and is in `error` (not `denied`: that is foreign material that never comes); clearAway.js turns it into
//   “Backup pending”.
// tarOfTheLayers({ helper, entries, file, cap }) → { size, missing, missingCount } (`missing` at most MISSING_CAP names,
//   the count next to it): `entries` [[root, rel, name in the tar]] as ONE tar into `file` (B writes the bytes, docker.js
//   stdoutFile); above the cap `CopyError` COPY_CAP (the caller discards the half file).
//
// Caps (ESTIMATED, NOT MEASURED): per call RETURN_PATH_CAP_MS (knob CBASE_COPY_RETURN_PATH_MS) — `lfs` and `back` plus
// their bytes at the rate COPY_RETURN_PATH_RATE (knob CBASE_COPY_RETURN_PATH_RATE: returnPathDeadline); LAYER_CAP entries and
// LAYER_BYTES_CAP bytes of the list (knobs CBASE_COPY_LAYER_CAP/_BYTES); MISSING_CAP names in `missing`.
// Guards: server/backend/test/stacks-fetch.test.js, stacks-clear-away.test.js, stacks-return-path-program.test.js (the
// program itself with a real python3: leftovers, write errors, SIGTERM, FIFO, memory, names, merge, clones).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SYSTEM_PATHS, copyInstance } from "../projectbox/creation.js";
import { executeHelper, withHelper } from "../projectbox/helper.js";
import { DEPENDENCIES, GIT_REDIRECTOR } from "../projectbox/projectRepo.js";
import { commandRun } from "../runtime/git-run.js";
import { locationFor } from "../runs/runtime-location.js";
import { helperInstance } from "./code-snapshot.js";
import { createReturnPath } from "./objects.js";
import { CopyError } from "./state.js";
import { T } from "../i18n.js";

export const RETURN_PATH_CAP_MS = 300_000;
// ESTIMATED, NOT MEASURED: a dependency folder counts as ONE entry (plus one record `i` per repo in it and at most one
// record `x`) — the search for `.git` in it counts against DEP_SEARCH_CAP, not against this one.
export const LAYER_CAP = 500_000;
// The visited entries of the `.git` search in the dependency folders, together over all of them (knob
// CBASE_COPY_DEP_SEARCH_CAP). Above it the list says `x<folder>` (search incomplete): the fetch goes on and names it
// (`depSearchIncomplete`), the clear-away holds “Backup pending” — a repo in there would otherwise bypass the backup.
// ESTIMATED, NOT MEASURED: twice the list cap.
export const DEP_SEARCH_CAP = 1_000_000;
// The list as BYTES — an entry can be up to ≈ PATH_MAX long, and the whole list comes to B as ONE string
// (projectbox/docker.js; above buffer.constants.MAX_STRING_LENGTH ≈ 512 Mi characters that threw in a callback and ended
// B). ESTIMATED, NOT MEASURED: 128 MiB, a quarter of it, ≈ 1 million entries of 130 bytes. The output cap of the docker seam
// (projectbox/docker.js, default 64 MiB) lies below — so `layerList` gives it `maxBytes` = this cap plus LIST_MARGIN:
// otherwise a list between 64 and 128 MiB would fail as “not readable” and the knob CBASE_COPY_LAYER_BYTES would have no
// effect upwards. The margin covers the end marker and the program's stderr.
export const LAYER_BYTES_CAP = 128 * 1024 ** 2;
export const LIST_MARGIN = 1024 * 1024;
export const MISSING_CAP = 200; //    names in the message `missing` of the tar (the count is next to it)
export const FALLBACK_MAX = 100; //       `<b>-1` … `<b>-100`, after that an error with a message
const count = (raw, preset) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : preset; };
export const returnPathCapMs = () => count(process.env.CBASE_COPY_RETURN_PATH_MS, RETURN_PATH_CAP_MS);
// `lfs` and `back` copy bytes — their deadline grows with the amount (returnPathDeadline). ESTIMATED, NOT MEASURED: about
// 13 MB/s out of a user container; knob CBASE_COPY_RETURN_PATH_RATE (bytes per second).
export const COPY_RETURN_PATH_RATE = 13 * 1024 ** 2;
const returnPathRate = () => count(process.env.CBASE_COPY_RETURN_PATH_RATE, COPY_RETURN_PATH_RATE);
/** The deadline of a copying call — the fixed cap plus the bytes at the estimated rate (ms). */
export const returnPathDeadline = (bytes) => returnPathCapMs() + Math.ceil((Math.max(0, Number(bytes) || 0) / returnPathRate()) * 1000);
const layerCap = () => count(process.env.CBASE_COPY_LAYER_CAP, LAYER_CAP);
const layerBytesCap = () => count(process.env.CBASE_COPY_LAYER_BYTES, LAYER_BYTES_CAP);
export const depSearchCap = () => count(process.env.CBASE_COPY_DEP_SEARCH_CAP, DEP_SEARCH_CAP);
/** The test seam of the overlay markers (header): with the opaque program of the tests the program reads its markers. */
const ontoMarkers = () => Boolean(process.env.CBASE_COPY_OPAQUE_PROGRAM);

const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e?.code === "ENOENT") return null; throw e; } };
const text = (e) => String(e?.message || e || "unknown").split("\n")[0].slice(0, 400);
const last = (s, n = 2) => String(s || "").trim().split("\n").slice(-n).join(" | ").slice(0, 600);

// ── The program (header) ────────────────────────────────────────────────────────────────────────────────────────────────
// No dollar sign before a curly brace in the text: it sits in a JS template.
export const RETURN_PATH_PROGRAM = String.raw`
import errno, hashlib, json, os, re, shutil, signal, stat, subprocess, sys, tarfile
cmd = sys.argv[1]
def _term(s, f):
    raise SystemExit(128 + s)
signal.signal(signal.SIGTERM, _term)
def write_everything(fd, b):
    mv = memoryview(b)
    while mv:
        n = os.write(fd, mv)
        if n <= 0:
            raise OSError(errno.EIO, "write wrote nothing")
        mv = mv[n:]
def way_file_rest(p, only_file=False):
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        return
    if stat.S_ISDIR(st.st_mode) or (only_file and not stat.S_ISREG(st.st_mode)):
        return
    os.unlink(p)
def way_rest(p):
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(st.st_mode):
        os.unlink(p); return
    os.chmod(p, 0o700)
    for w, ds, fs in os.walk(p):
        for d in ds:
            dp = os.path.join(w, d)
            try:
                if stat.S_ISDIR(os.lstat(dp).st_mode):
                    os.chmod(dp, 0o700)
            except OSError:
                pass
    shutil.rmtree(p)
def sync_folder(p):
    fd = os.open(p, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
def read_input():
    return json.loads(sys.stdin.buffer.read() or b"{}")
def xattr(p, n):
    try:
        return os.getxattr(p, n, follow_symlinks=False)
    except Exception:
        return None
def real_folder(p):
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        return None
    return stat.S_ISDIR(st.st_mode)
def stages_real(root_dir, rel):
    p = root_dir
    for t in rel.split(b"/")[:-1]:
        p = os.path.join(p, t)
        if real_folder(p) is not True:
            return False
    return True
def is_whiteout(p, st, aufs, name):
    if aufs:
        return name.startswith(b".wh.")
    if stat.S_ISCHR(st.st_mode) and st.st_rdev == 0:
        return True
    return stat.S_ISREG(st.st_mode) and st.st_size == 0 and xattr(p, "user.overlay.whiteout") is not None
def git_environment(a):
    env = dict(os.environ)
    for k in list(env):
        if k in a.get("redirector", []) or any(k.startswith(p) for p in a.get("prefixes", [])):
            del env[k]
    env["GIT_NO_LAZY_FETCH"] = "1"; env["GIT_TERMINAL_PROMPT"] = "0"
    return env
def git(env, *args, stdin=None, gitdir=None, cwd=None):
    prefix_args = ["git", "-c", "transfer.fsckObjects=true", "-c", "fetch.fsckObjects=true"] + (["--git-dir=" + gitdir] if gitdir else [])
    return subprocess.run(prefix_args + list(args), input=stdin, capture_output=True, env=env, cwd=cwd)
def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj)); sys.stdout.flush(); sys.exit(code)

if cmd == "list":
    a = read_input()
    root_dir = os.fsencode(a["root"]); aufs = bool(a.get("onto")); cap = int(a["cap"]); bytes_cap = int(a.get("bytes") or 0) or (1 << 62)
    dep_cap = int(a.get("depCap") or 0) or cap
    without = set(os.fsencode(x) for x in a.get("without", [])); dependent_set = set(os.fsencode(x) for x in a.get("dependent", []))
    out = sys.stdout.buffer
    counts = [0, 0, 0]
    def gib(kind, rel):
        try:
            rel.decode("utf-8")
            raw_ok = b"\n" not in rel and b"\r" not in rel
        except UnicodeDecodeError:
            raw_ok = False
        item_set = (kind + rel if raw_ok else kind.upper() + json.dumps(os.fsdecode(rel)).encode("ascii")) + b"\0"
        counts[0] += 1; counts[1] += len(item_set)
        if counts[0] > cap:
            out.write(b"!cap\0"); out.flush(); sys.exit(3)
        if counts[1] > bytes_cap:
            out.write(b"!bytes\0"); out.flush(); sys.exit(3)
        out.write(item_set)
    def git_in_dep(abs0, rel0):
        # Search a dependency folder for repos only (an entry ".git", folder or file) — one sentence "i<rel>" per hit;
        # do not descend into ".git", follow no link, whiteouts do not count. Every visited entry counts against its OWN cap
        # (depCap, across all dependency folders); when the search reaches it, ONE sentence "x<rel0>" stands (the search in
        # this folder is incomplete) — the list goes on (the fetch goes through), the clear-away stops at it. The WHOLE
        # list used to abort with "!cap".
        st2 = [(abs0, rel0)]
        while st2:
            a2, r2 = st2.pop()
            try:
                names = sorted(os.listdir(a2), reverse=True)
            except OSError:
                continue
            for n in names:
                counts[2] += 1
                if counts[2] > dep_cap:
                    gib(b"x", rel0); return
                p2 = os.path.join(a2, n); rr = r2 + b"/" + n
                try:
                    s2 = os.lstat(p2)
                except OSError:
                    continue
                if is_whiteout(p2, s2, aufs, n):
                    continue
                if n == b".git":
                    gib(b"i", r2); continue
                if stat.S_ISDIR(s2.st_mode) and rr not in without:
                    st2.append((p2, rr))
    if real_folder(root_dir) is not True:
        sys.stderr.write("no upper layer: " + os.fsdecode(root_dir) + "\n"); sys.exit(2)
    stack = [(root_dir, b"")]
    while stack:
        abs_, rel = stack.pop()
        try:
            dir_entries = sorted(os.listdir(abs_), reverse=True)
        except FileNotFoundError:
            continue
        except OSError:
            gib(b"u", rel); continue
        for name in dir_entries:
            r = rel + b"/" + name if rel else name
            if r in without or (aufs and name == b".wh..wh..opq"):
                continue
            p = os.path.join(abs_, name)
            try:
                st = os.lstat(p)
            except FileNotFoundError:
                continue
            except OSError:
                gib(b"u", r); continue
            if is_whiteout(p, st, aufs, name):
                w = name[4:] if aufs else name
                gib(b"w", rel + b"/" + w if rel else w); continue
            if stat.S_ISDIR(st.st_mode):
                if name in dependent_set:
                    gib(b"a", r)
                    git_in_dep(p, r)
                    continue
                if (aufs and os.path.lexists(os.path.join(p, b".wh..wh..opq"))) or (not aufs and xattr(p, "user.overlay.opaque") == b"y"):
                    gib(b"o", r)
                stack.append((p, r))
            elif stat.S_ISLNK(st.st_mode) or stat.S_ISREG(st.st_mode):
                gib(b"f", r)
            else:
                gib(b"s", r)
    out.write(b"!end\0")

elif cmd == "size":
    # The bytes below the named paths (lstat only, no link followed, unreadable counts for nothing) — for the deadline
    # author "lfs"/"back" (returnPathDeadline in B).
    a = read_input(); total = 0
    for w in a["paths"]:
        stack = [os.fsencode(w)]
        while stack:
            p = stack.pop()
            try:
                st = os.lstat(p)
            except OSError:
                continue
            if stat.S_ISDIR(st.st_mode):
                try:
                    stack.extend(os.path.join(p, n) for n in os.listdir(p))
                except OSError:
                    pass
            elif stat.S_ISREG(st.st_mode):
                total += st.st_size
    emit({"bytes": total})

elif cmd == "tar":
    a = read_input(); cap = int(a["cap"])
    class CountingSink:
        n = 0
        def write(self, b):
            self.n += len(b)
            if self.n > cap:
                sys.stdout.buffer.flush(); os._exit(4)
            sys.stdout.buffer.write(b); return len(b)
    missing_arcs = []
    with tarfile.open(fileobj=CountingSink(), mode="w|", format=tarfile.PAX_FORMAT) as t:
        for root_dir, rel, arc in a["entries"]:
            w = os.fsencode(root_dir); r = os.fsencode(rel)
            p = os.path.join(w, r)
            if not stages_real(w, r):
                missing_arcs.append(arc); continue
            try:
                st = os.lstat(p)
            except FileNotFoundError:
                missing_arcs.append(arc); continue
            if not (stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode)):
                missing_arcs.append(arc); continue
            t.add(os.fsdecode(p), arcname=arc, recursive=False)
    sys.stdout.buffer.flush()
    sys.stderr.write(json.dumps({"missing": missing_arcs[:int(a.get("missingCap") or 200)], "count": len(missing_arcs)}) + "\n")

elif cmd == "lfs":
    source = os.fsencode(sys.argv[2]); target = os.fsencode(sys.argv[3])
    mark = hashlib.sha256(source).hexdigest()[:16].encode()
    result = {"copied": 0, "existing": 0, "denied": [], "error": []}
    hex2 = re.compile(rb"[0-9a-f]{2}"); hex64 = re.compile(rb"[0-9a-f]{64}")
    def deny(rel, reason):
        result["denied"].append({"rel": os.fsdecode(rel), "reason": reason})
    def target_folder(segs):
        p = target
        e = real_folder(p)
        if e is None:
            # Every newly created level durably in the parent folder (makedirs also creates ancestors).
            new_dirs = []
            q = p
            while real_folder(q) is None:
                new_dirs.append(q); q = os.path.dirname(q)
            os.makedirs(p, 0o755)
            for n in reversed(new_dirs):
                sync_folder(os.path.dirname(n))
        elif e is not True:
            return None
        for t in segs:
            p = os.path.join(p, t)
            e = real_folder(p)
            if e is None:
                os.mkdir(p, 0o755)
                sync_folder(os.path.dirname(p))
            elif e is not True:
                return None
        return p
    if real_folder(source) is True:
        for a1 in sorted(os.listdir(source)):
            p1 = os.path.join(source, a1)
            if not hex2.fullmatch(a1) or real_folder(p1) is not True:
                deny(a1, "not an object folder"); continue
            for a2 in sorted(os.listdir(p1)):
                p2 = os.path.join(p1, a2)
                if not hex2.fullmatch(a2) or real_folder(p2) is not True:
                    deny(a1 + b"/" + a2, "not an object folder"); continue
                for n in sorted(os.listdir(p2)):
                    rel = a1 + b"/" + a2 + b"/" + n
                    if not hex64.fullmatch(n) or n[0:2] != a1 or n[2:4] != a2:
                        deny(rel, "not an LFS object"); continue
                    qp = os.path.join(p2, n)
                    try:
                        qst = os.lstat(qp)
                    except OSError:
                        deny(rel, "not readable"); continue
                    if stat.S_ISLNK(qst.st_mode):
                        deny(rel, "not readable or a link"); continue
                    if not stat.S_ISREG(qst.st_mode):
                        deny(rel, "not a file"); continue
                    zo = target_folder([a1, a2])
                    if zo is None:
                        deny(rel, "Target leads through a link"); continue
                    zp = os.path.join(zo, n)
                    if os.path.lexists(zp):
                        result["existing"] += 1; continue
                    tmp = os.path.join(zo, b".cbase-lfs-" + mark + b"-" + n + b".tmp")
                    try:
                        way_file_rest(os.path.join(zo, b".cbase-" + n + b".tmp"), only_file=True)
                        way_file_rest(tmp)
                        try:
                            fd = os.open(qp, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                        except OSError:
                            deny(rel, "not readable or a link"); continue
                        try:
                            if not stat.S_ISREG(os.fstat(fd).st_mode):
                                deny(rel, "not a file"); continue
                            zfd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                            try:
                                h = hashlib.sha256(); size = 0
                                while True:
                                    b = os.read(fd, 1 << 20)
                                    if not b: break
                                    h.update(b); write_everything(zfd, b); size += len(b)
                                matches = h.hexdigest().encode() == n and os.fstat(zfd).st_size == size
                                if matches:
                                    os.fchmod(zfd, 0o644); os.fsync(zfd)
                            finally:
                                os.close(zfd)
                        finally:
                            os.close(fd)
                        if not matches:
                            deny(rel, "content does not match the name"); continue
                        try:
                            os.link(tmp, zp)
                        except FileExistsError:
                            result["existing"] += 1; continue
                        sync_folder(zo)  # the new name survives a crash
                        result["copied"] += 1
                    except OSError as e:
                        result["error"].append({"rel": os.fsdecode(rel), "reason": "Error: " + str(e)})
                    finally:
                        way_file_rest(tmp)
    emit(result)

elif cmd == "back":
    a = read_input()
    source = os.fsencode(a["source"]); target = os.fsencode(a["target"]); aufs = bool(a.get("onto"))
    result = {"back": [], "denied": [], "error": []}
    def deny(rel, reason, target_list=None):
        (result["denied"] if target_list is None else target_list).append({"rel": os.fsdecode(rel), "reason": reason})
    def rest_name(z, rel):
        return os.path.join(os.path.dirname(z), b".cbase-back-" + hashlib.sha256(source + b"\0" + rel).hexdigest()[:24].encode() + b".tmp")
    def copy_file(q, z, st, sync):
        qfd = os.open(q, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            if not stat.S_ISREG(os.fstat(qfd).st_mode):
                raise OSError(errno.EINVAL, "not a file", q)
            zfd = os.open(z, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                while True:
                    b = os.read(qfd, 1 << 20)
                    if not b: break
                    write_everything(zfd, b)
                os.fchmod(zfd, st.st_mode & 0o777)
                if sync:
                    os.fsync(zfd)
            finally:
                os.close(zfd)
        finally:
            os.close(qfd)
        os.utime(z, ns=(st.st_atime_ns, st.st_mtime_ns), follow_symlinks=False)
    def copy_folder(q, z, rel, modes, inner):
        os.mkdir(z, 0o700)
        for n in sorted(os.listdir(q)):
            qp = os.path.join(q, n); zp = os.path.join(z, n); r = rel + b"/" + n
            s = os.lstat(qp)
            if (aufs and n == b".wh..wh..opq") or is_whiteout(qp, s, aufs, n):
                continue
            if stat.S_ISLNK(s.st_mode):
                deny(r, "link", inner); continue
            if stat.S_ISDIR(s.st_mode):
                copy_folder(qp, zp, r, modes, inner)
                modes.append((zp, s))
            elif stat.S_ISREG(s.st_mode):
                copy_file(qp, zp, s, True)  # every file durably, before the folder takes its place
            else:
                deny(r, "not a file", inner)
        sync_folder(z)  # the entries of the created folder, before the rename
    def set_mode(p, s):
        os.chmod(p, s.st_mode & 0o777)
        os.utime(p, ns=(s.st_atime_ns, s.st_mtime_ns), follow_symlinks=False)
    def bring_over(q, z, st, rel):
        tmp = rest_name(z, rel)
        way_rest(tmp)
        try:
            inner = []
            if stat.S_ISDIR(st.st_mode):
                modes = []
                copy_folder(q, tmp, rel, modes, inner)
                for p, s in modes:
                    set_mode(p, s)
                set_mode(tmp, st)
                if os.path.lexists(z):
                    deny(rel, "occupied in main — not overwritten"); return
                os.rename(tmp, z)
                sync_folder(os.path.dirname(z))  # durable
            else:
                copy_file(q, tmp, st, True)
                try:
                    os.link(tmp, z)
                except FileExistsError:
                    deny(rel, "occupied in main — not overwritten"); return
                sync_folder(os.path.dirname(z))  # durable
            result["denied"].extend(inner)
            result["back"].append(os.fsdecode(rel))
        finally:
            way_rest(tmp)
    for rel in [os.fsencode(x) for x in a["rels"]]:
        if not stages_real(source, rel):
            deny(rel, "level in the layer is not a folder"); continue
        q = os.path.join(source, rel)
        try:
            st = os.lstat(q)
        except FileNotFoundError:
            deny(rel, "not in the upper layer"); continue
        if stat.S_ISLNK(st.st_mode):
            deny(rel, "link"); continue
        if is_whiteout(q, st, aufs, os.path.basename(rel)):
            deny(rel, "deleted in the copy"); continue
        if not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
            deny(rel, "not a file"); continue
        try:
            z = target; ok = True
            for t in rel.split(b"/")[:-1]:
                z = os.path.join(z, t)
                e = real_folder(z)
                if e is None:
                    os.mkdir(z, 0o755)
                    sync_folder(os.path.dirname(z))  # the new level in the parent folder
                elif e is not True:
                    ok = False; break
            if not ok:
                deny(rel, "level in main is not a folder (link?)"); continue
            z = os.path.join(target, rel)
            if os.path.lexists(z):
                deny(rel, "occupied in main — not overwritten"); continue
            bring_over(q, z, st, rel)
        except OSError as e:
            result["error"].append({"rel": os.fsdecode(rel), "reason": "Error: " + str(e)})
    emit(result)

elif cmd == "fetch":
    a = read_input(); env = git_environment(a)
    empty_dir = sys.argv[2]
    if os.path.lexists(empty_dir):
        if os.path.islink(empty_dir) or not os.path.isdir(empty_dir):
            sys.stderr.write(empty_dir + " is not a folder\n"); sys.exit(30)
        shutil.rmtree(empty_dir)
    r = git(env, "init", "-q", "--bare", "--template=", *(["--object-format=sha256"] if a["sha256"] else []), empty_dir)
    if r.returncode:
        sys.stderr.buffer.write(r.stderr); sys.exit(31)
    info = os.path.join(empty_dir, "objects", "info")
    os.makedirs(info, exist_ok=True)
    with open(os.path.join(info, "alternates"), "w") as f:
        f.write("".join(x + "\n" for x in a["alternates"]))
    oids = sorted(set(o for _, o in a["refs"]))
    if oids:
        r = git(env, "cat-file", "--batch-check", stdin=("".join(o + "\n" for o in oids)).encode(), gitdir=empty_dir)
        missing_oids = [z.split(" ")[0] for z in r.stdout.decode().splitlines() if z.endswith(" missing")]
        if r.returncode or missing_oids:
            emit({"missing": missing_oids, "notice": r.stderr.decode(errors="replace")[-400:]}, 35)
        r = git(env, "update-ref", "--no-deref", "--stdin", stdin=("".join("update %s %s\n" % (n, o) for n, o in a["refs"])).encode(), gitdir=empty_dir)
        if r.returncode:
            sys.stderr.buffer.write(r.stderr); sys.exit(32)
    REJECTED = re.compile(r"\[rejected\]|non-fast-forward|cannot lock ref|refusing to fetch into|would clobber|unable to update local ref|some local refs could not be updated|checked out at")
    def ancestor_ref(z):
        segs = z.split("/")
        for i in range(3, len(segs)):
            v = "/".join(segs[:i])
            if git(env, "show-ref", "--verify", "-q", v).returncode == 0:
                return v
        return None
    def short(message):
        lines = [z.strip() for z in message.splitlines() if z.strip()]
        noise = lambda z: z.startswith(("hint:", "From ")) or "git remote prune" in z or "some local refs could not be updated" in z
        important = [z for z in lines if z.startswith(("error:", "fatal:")) and not noise(z)]
        rest = [z for z in lines if z not in important and not noise(z)]
        return "\n".join(important + rest)[:600] or message.strip()[-600:]
    results = []
    for job in a["jobs"]:
        e = {"source": job["source"], "target": None, "prior": None, "ok": False, "fallback": 0, "notice": "", "paths": None}
        base = job["target"]
        blk = ancestor_ref(base)
        if blk is not None:
            base = blk + "--" + base[len(blk) + 1:].replace("/", "--")
        for n in range(0, a["fallbackMax"] + 1):
            target = base if n == 0 else "%s-%d" % (base, n)
            v = git(env, "rev-parse", "-q", "--verify", target)
            prior = v.stdout.decode().strip() if v.returncode == 0 else None
            if job.get("onlyNew") and prior is not None:
                if prior == job["oid"]:
                    e.update(target=target, prior=prior, ok=True, fallback=n, notice=""); break
                e["notice"] = "occupied"; continue
            r = git(env, "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-maintenance", empty_dir, job["source"] + ":" + target)
            if r.returncode == 0:
                e.update(target=target, prior=prior, ok=True, fallback=n, notice=""); break
            message = r.stderr.decode(errors="replace")
            e["notice"] = short(message)
            if not REJECTED.search(message):
                break
        if e["ok"] and job.get("base"):
            d = git(env, "diff", "--name-only", "-z", "--no-renames", job["base"], job["oid"])
            e["paths"] = [p for p in d.stdout.decode(errors="replace").split("\0") if p] if d.returncode == 0 else None
        results.append(e)
    emit({"results": results})

elif cmd == "merge":
    a = read_input(); env = git_environment(a)
    # The image cbase-projectbox sets GIT_LFS_SKIP_SMUDGE=1 (it arrives here with os.environ), and filter.lfs stands in
    # /etc/gitconfig — without the line below, the merge and a merge --abort would write the POINTER FILE into main for every
    # path with filter=lfs, although copyLfs has already put the object into main's .git/lfs/objects (fetch). SKIP_SMUDGE=0:
    # git-lfs takes the local object, without network (the helper runs with --network none). SKIP_DOWNLOAD_ERRORS=1: if an
    # object is missing after all (a pointer whose content was never fetched), the pointer stays there as before, instead of
    # the smudge filter (filter.lfs.required) aborting the merge in the middle of main. Only this command: no other writes a
    # working tree from a commit whose LFS objects cbase holds locally (clones: from a bundle — the objects of a new repo
    # do not come along).
    env["GIT_LFS_SKIP_SMUDGE"] = "0"; env["GIT_LFS_SKIP_DOWNLOAD_ERRORS"] = "1"
    if git(env, "merge-base", "--is-ancestor", a["oid"], "HEAD").returncode == 0:
        emit({"already": True})
    if a.get("onlyCheck"):
        # A detached tip only above its start point (exit 1 = no ancestor, anything above: not readable).
        if a.get("fromOf"):
            v = git(env, "merge-base", "--is-ancestor", a["fromOf"], a["oid"])
            if v.returncode:
                reason = "does not descend from the start point of the copy" if v.returncode == 1 else "cannot be checked against the start point (" + v.stderr.decode(errors="replace").strip()[-300:] + ")"
                emit({"foreign": True, "notice": reason})
        r = git(env, "rev-list", a["oid"], "--not", "HEAD")
        if r.returncode:
            sys.stderr.buffer.write(r.stderr); sys.exit(33)
        links = set()
        for c in r.stdout.decode().split():
            t = git(env, "ls-tree", "-r", "-z", "--full-tree", c)
            if t.returncode:
                sys.stderr.buffer.write(t.stderr); sys.exit(33)
            links.update(z.split("\t", 1)[1] for z in t.stdout.decode(errors="replace").split("\0") if z.startswith("160000 "))
        emit({"gitlinks": sorted(links)} if links else {"free": True})
    # Read HEAD ONCE (h0) — merge-tree, diff and the check for occupied paths run against h0; right before the
    # merge HEAD is read again: if main moved in between, nothing is touched.
    h = git(env, "rev-parse", "--verify", "HEAD^{commit}")
    if h.returncode:
        emit({"merged": False, "notice": "HEAD of main is not readable: " + h.stderr.decode(errors="replace").strip()[-300:]})
    h0 = h.stdout.decode().strip()
    m = git(env, "merge-tree", "--write-tree", "-z", "--name-only", h0, a["oid"])
    if m.returncode not in (0, 1):
        emit({"merged": False, "notice": "merge-tree: " + (m.stdout + m.stderr).decode(errors="replace").strip()[-500:]})
    fields = m.stdout.split(b"\0")
    if m.returncode == 1:
        conflicts = []
        for x in fields[1:]:
            if not x: break
            conflicts.append(os.fsdecode(x))
        emit({"merged": False, "notice": "conflict (nothing in main touched): " + ", ".join(conflicts[:10])})
    d = git(env, "diff", "--name-status", "-z", "--no-renames", h0, fields[0].decode())
    if d.returncode:
        emit({"merged": False, "notice": "diff: " + d.stderr.decode(errors="replace").strip()[-500:]})
    df = d.stdout.split(b"\0")
    occupied_files = [os.fsdecode(df[i + 1]) for i in range(0, len(df) - 1, 2) if df[i] == b"A" and os.path.lexists(df[i + 1])]
    if occupied_files:
        emit({"merged": False, "notice": "main holds unversioned files that the merge would overwrite — nothing touched: " + ", ".join(occupied_files[:10])})
    h1 = git(env, "rev-parse", "--verify", "HEAD^{commit}")
    if h1.returncode or h1.stdout.decode().strip() != h0:
        emit({"merged": False, "notice": "main moved — nothing touched"})
    r = git(env, "merge", "--no-overwrite-ignore", "--no-edit", "-q", a["target"])
    if r.returncode == 0:
        emit({"merged": True})
    message = (r.stdout + r.stderr).decode(errors="replace").strip()[-600:]
    # "merge --abort" only above the OWN merge: MERGE_HEAD stands, and ORIG_HEAD is h0 (otherwise it would abort foreign work).
    mh = git(env, "rev-parse", "-q", "--verify", "MERGE_HEAD")
    oh = git(env, "rev-parse", "-q", "--verify", "ORIG_HEAD")
    if mh.returncode == 0 and oh.returncode == 0 and oh.stdout.decode().strip() == h0:
        git(env, "merge", "--abort")
    emit({"merged": False, "notice": message})

elif cmd == "clones":
    a = read_input(); env = git_environment(a)
    root_dir = os.fsencode(a["root"]); rel = os.fsencode(a["rel"])
    z = root_dir
    for t in rel.split(b"/")[:-1]:
        z = os.path.join(z, t)
        e = real_folder(z)
        if e is None:
            os.mkdir(z, 0o755)
        elif e is not True:
            emit({"cloned": False, "reason": "reference"})
    target = os.path.join(root_dir, rel)
    if os.path.lexists(target):
        emit({"cloned": False, "reason": "occupied"})
    r = git(env, "-c", "core.fsync=committed", "clone", "-q", "--no-hardlinks", a["bundle"], os.fsdecode(target))
    if r.returncode:
        emit({"cloned": False, "reason": "clone", "notice": r.stderr.decode(errors="replace")[-400:]})
    z = os.fsdecode(target)
    r = git(env, "fetch", "-q", "--no-tags", "--no-write-fetch-head", "--update-head-ok", a["bundle"], "refs/heads/*:refs/heads/*", "refs/cbase/*:refs/cbase/*", cwd=z)
    wip = r.returncode == 0
    git(env, "remote", "remove", "origin", cwd=z)
    emit({"cloned": True, "wip": wip})
else:
    sys.stderr.write("unknown command " + cmd + "\n"); sys.exit(2)
`;

const redirector = () => ({ redirector: GIT_REDIRECTOR.names, prefixes: GIT_REDIRECTOR.prefixes });

// A command as agent through the wrapper (runtime/git-run.js commandRun) — JSON back; exit ≠ 0 with a message. `deadline`
// (ms): the deadline of this call, otherwise the fixed cap; at the cap the message names deadline and knobs.
async function asAgent(helperInst, cwd, command, args = [], input = null, what = command, deadline = returnPathCapMs()) {
  const r = await commandRun(helperInst, cwd, "python3", ["-c", RETURN_PATH_PROGRAM, command, ...args], {
    timeout: deadline, maxBuffer: 64 * 1024 * 1024, ...(input === null ? {} : { stdin: JSON.stringify(input) }),
  });
  let response = null;
  try { response = JSON.parse(r.stdout || "null"); } catch { /* below */ }
  const cap = r.cap ? T` (cap: ${r.cap}; deadline ${deadline} ms, estimated, not measured; knobs CBASE_COPY_RETURN_PATH_MS and CBASE_COPY_RETURN_PATH_RATE)` : "";
  return { r, response, error: () => `${what}: Exit ${r.code ?? r.signal}${cap} — ${last(r.stderr)}` };
}

/** The bytes below `paths` (program `size`, lstat only) — for returnPathDeadline. */
export async function sizeIn(helperInst, cwd, paths) {
  const { r, response, error } = await asAgent(helperInst, cwd, "size", [], { paths }, T("Size"));
  if (r.code !== 0 || !Number.isFinite(response?.bytes)) throw new CopyError(error(), { code: "COPY_RETURN_PATH", status: 500 });
  return response.bytes;
}

// ── The helper ──────────────────────────────────────────────────────────────────────────────────────────────────────

export async function withReturnPathHelper({ copy, location, projectPath, snapshot, home = os.homedir(), system = null }, fn) {
  const pid = String(copy.projectId);
  const runtime = locationFor({ projectId: pid, converted: true });
  createReturnPath(location, { processes: runtime.processes });
  const ro = (p) => ({ type: "bind", source: p, target: p, onlyRead: true });
  const mounts = [
    { type: "bind", source: projectPath, target: projectPath },
    { type: "bind", source: runtime.root, target: runtime.root },
    { type: "bind", source: (system || SYSTEM_PATHS).usrLocalBin, target: SYSTEM_PATHS.usrLocalBin, onlyRead: true },
    { type: "bind", source: location.root.returnPathFolder, target: location.root.returnPathFolder },
  ];
  const gitconfig = path.join(home, ".gitconfig");
  if (lstatOrNull(gitconfig)?.isFile()) mounts.push(ro(gitconfig));
  const seen = new Set();
  const alongside = (p) => { if (!seen.has(p) && lstatOrNull(p)?.isDirectory()) { seen.add(p); mounts.push(ro(p)); } };
  alongside(location.root.layer("p"));
  for (const r of snapshot?.repos || []) {
    alongside(location.root.objects(r.part));
    alongside(location.root.layerObjects(r.part));
    alongside(location.root.layer(r.part));
  }
  alongside(location.backup);
  return withHelper({ kind: "returnPath", projectId: pid, instance: copyInstance(copy.name), mounts, capMs: returnPathCapMs() },
    (helper) => fn({ helper, helperInst: helperInstance(pid, helper) }));
}

// ── The list of the upper layer ─────────────────────────────────────────────────────────────────────────────────────

const KINDS = { f: "files", a: "dependent", w: "deleted", o: "opaque", s: "special", u: "unreadable", i: "gitInside", x: "depIncomplete" };
export const relValid = (rel) => typeof rel === "string" && Boolean(rel) && !rel.includes("�") && !rel.startsWith("/") && !/[\n\r\0]/.test(rel)
  && rel.split("/").every((t) => t && t !== "." && t !== "..");
// A name of the upper layer is foreign data in BYTES — a Latin-1 name or a line break is no reason to reject the whole
// list. It only has to be a relative path in form; it is text only at the places that go on using it as text (ref names,
// `retrieve`, `pathError` — relValid applies there).
const layerRelValid = (rel) => typeof rel === "string" && Boolean(rel) && !rel.startsWith("/") && !rel.includes("\0")
  && rel.split("/").every((t) => t && t !== "." && t !== "..");
/** A name that goes on as BYTES (surrogateescape form allowed, `\n` too) — in the form of the layer, but never with
 *  U+FFFD (that would mean: somewhere a byte was already lost as text). fetch.js stateFromOutput (`E`/`G`) and newRepos. */
export const nameRelValid = (rel) => layerRelValid(rel) && !rel.includes("\ufffd");

/**
 * A name from the program back into its bytes. The program sends a name that is not UTF-8 or carries `\n`/`\r` as a JSON
 * string of `os.fsdecode` (surrogateescape: every invalid byte 0x80–0xFF as a SINGLE surrogate U+DC80–U+DCFF); here it
 * becomes exactly that byte again. Everything else is UTF-8. Whoever passes a name of the list to a process passes it this
 * way (nulBytes) — as JS text (utf8) the byte would become U+FFFD, and git would not find the file.
 */
export function nameBytes(s) {
  const parts = [];
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xdc80 || c > 0xdcff) continue;
    const before = i > 0 ? s.charCodeAt(i - 1) : 0;
    if (before >= 0xd800 && before <= 0xdbff) continue; // second half of a real pair
    parts.push(Buffer.from(s.slice(from, i), "utf8"), Buffer.from([c - 0xdc00]));
    from = i + 1;
  }
  parts.push(Buffer.from(s.slice(from), "utf8"));
  return Buffer.concat(parts);
}
const NUL = Buffer.from([0]);
/** Names NUL-separated as bytes (stdin of the commands INSIDE the copy: WIP, project repo, check-ignore). */
export const nulBytes = (xs) => Buffer.concat(xs.flatMap((x) => [nameBytes(x), NUL]));

/**
 * The output of the program `list`, read (pure): `f<name>` raw (UTF-8 without `\n`/`\r`) or `F<json>` per record, then
 * `!end`. Throws COPY_LAYER without the end marker or with a record that is not a relative path in form. The kinds: KINDS
 * (also `x` — `depIncomplete`, the search in this dependency folder stopped).
 */
export function layerSets(stdout, filePath) {
  const sets = String(stdout || "").split("\0");
  if (sets.length < 2 || sets[sets.length - 2] !== "!end") throw new CopyError(T`upper layer ${filePath}: list without an end marker — aborted`, { code: "COPY_LAYER", status: 500 });
  const out = { files: [], dependent: [], deleted: [], opaque: [], special: [], unreadable: [], gitInside: [], depIncomplete: [] };
  for (const s of sets.slice(0, -2)) {
    const small = String(s[0] || "").toLowerCase();
    const kind = KINDS[small];
    let rel = s.slice(1);
    if (kind && s[0] !== small) { try { rel = JSON.parse(rel); } catch { rel = null; } }
    if (!kind || !(layerRelValid(rel) || (kind === "unreadable" && rel === ""))) {
      throw new CopyError(T`upper layer ${filePath}: unexpected entry ${JSON.stringify(s.slice(0, 120))} — not taken over`, { code: "COPY_LAYER", status: 500 });
    }
    out[kind].push(rel);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

export async function layerList(helper, filePath, { without = [], cap = layerCap(), bytes = layerBytesCap(), depCap = depSearchCap() } = {}) {
  const input = JSON.stringify({ root: filePath, onto: ontoMarkers(), cap, bytes, depCap, without, dependent: DEPENDENCIES.map((x) => x.replace(/\/$/, "")) });
  let r;
  try {
    r = await executeHelper(helper, ["python3", "-c", RETURN_PATH_PROGRAM, "list"], { stdin: input, capMs: returnPathCapMs(), maxBytes: bytes + LIST_MARGIN });
  } catch (e) {
    // The output cap of the seam follows the own one (maxBytes above) — if it hits anyway (stderr floods), that is the same
    // cap and not an unreadable folder.
    if (e?.code === "OUTPUT") throw new CopyError(T`upper layer ${filePath}: output above ${bytes + LIST_MARGIN} bytes (cap, estimated, not measured; knob CBASE_COPY_LAYER_BYTES) — aborted instead of truncated`, { code: "COPY_CAP", status: 500 });
    const marker = String(e?.stdout || "").split("\0").slice(-2)[0];
    if (marker === "!cap" || marker === "!bytes") {
      const what = marker === "!cap" ? T`more than ${cap} entries (cap, estimated, not measured; knob CBASE_COPY_LAYER_CAP)`
        : T`more than ${bytes} bytes of list (cap, estimated, not measured; knob CBASE_COPY_LAYER_BYTES)`;
      throw new CopyError(T`upper layer ${filePath}: ${what} — aborted instead of truncated`, { code: "COPY_CAP", status: 500 });
    }
    throw new CopyError(T`upper layer ${filePath} cannot be read: ${text(e)}`, { code: "COPY_LAYER", status: 500 });
  }
  return layerSets(r.stdout, filePath);
}

// ── Fetch into main ─────────────────────────────────────────────────────────────────────────────────────────────────

const HEX = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

export async function fetchIntoMain({ helperInst, location, part, mainPath, refs, jobs }) {
  for (const [n, o] of refs) if (!/^refs\//.test(n) || !HEX.test(o)) throw new TypeError(`fetchIntoMain: ref ${n} ${o} unchecked`);
  if (!jobs.length) return [];
  const empty = location.root.returnPath(part);
  // Relative to `<empty>/objects`: the same text holds in B, in the helper (same paths) and in the fake docker.
  const relative = (p) => path.relative(path.join(empty, "objects"), p).split(path.sep).join("/");
  const input = {
    alternates: [relative(location.root.objects(part)), relative(location.root.layerObjects(part))],
    sha256: refs.some(([, o]) => o.length === 64), refs, jobs, fallbackMax: FALLBACK_MAX, ...redirector(),
  };
  // The source of every fetch is the empty repo — in the argv (visible in the log of the docker call, held by a guard),
  // never the copy's repo.
  const { r, response, error } = await asAgent(helperInst, mainPath, "fetch", [empty], input, T`Fetch ${part}`);
  if (r.code === 35) {
    const f = response?.missing || [];
    throw new CopyError(T`${part}: ${f.length} object(s) are missing in both layers (${f.slice(0, 5).join(", ")}) — nothing fetched`, { code: "COPY_OBJECT_MISSING", status: 500 });
  }
  if (r.code !== 0 || !Array.isArray(response?.results)) throw new CopyError(`${part}: ${error()}`, { code: "COPY_FETCH", status: 500 });
  return response.results.map((e, i) => ({ ...e, oid: jobs[i].oid }));
}

export async function mergeTogether({ helperInst, projectPath, target, oid, onlyCheck = false, fromOf = null }) {
  const { r, response, error } = await asAgent(helperInst, projectPath, "merge", [], { target, oid, onlyCheck, ...(fromOf ? { fromOf } : {}), ...redirector() }, T("Merging"));
  if (r.code !== 0 || !response) throw new CopyError(T`Project repo: ${error()}`, { code: "COPY_FETCH", status: 500 });
  return response;
}

export async function clonesBundle({ helperInst, projectPath, bundle, rel }) {
  const { r, response, error } = await asAgent(helperInst, projectPath, "clones", [], { root: projectPath, rel, bundle, ...redirector() }, T`Cloning ${rel}`);
  if (r.code !== 0 || !response) throw new CopyError(error(), { code: "COPY_RETRIEVE", status: 500 });
  return response;
}

// ── LFS, retrieving, tar ────────────────────────────────────────────────────────────────────────────────────────────

export async function copyLfs({ helperInst, location, part, mainPath }) {
  const source = path.join(location.root.layer(part), ".git", "lfs", "objects");
  if (!lstatOrNull(source)?.isDirectory()) return { copied: 0, existing: 0, denied: [] };
  const git = path.join(mainPath, ".git");
  if (!lstatOrNull(git)?.isDirectory()) return { copied: 0, existing: 0, denied: [{ rel: ".", reason: T("main's repo has no .git folder") }] };
  const deadline = returnPathDeadline(await sizeIn(helperInst, mainPath, [source]));
  const { r, response, error } = await asAgent(helperInst, mainPath, "lfs", [source, path.join(git, "lfs", "objects")], null, `LFS ${part}`, deadline);
  if (r.code !== 0 || !response) throw new CopyError(error(), { code: "COPY_LFS", status: 500 });
  // A write error (ENOSPC, EFBIG) is never “copied” — the backup is pending, the layer stays.
  const f = Array.isArray(response.error) ? response.error : [];
  if (f.length) throw new CopyError(T`LFS ${part}: ${f.length} object(s) not copied (${f.slice(0, 3).map((x) => `${x.rel}: ${x.reason}`).join("; ")})`, { code: "COPY_LFS", status: 500 });
  return { copied: response.copied, existing: response.existing, denied: response.denied };
}

// → { back, denied, error } — `error`: a read or write error in the middle of copying; then NOTHING lies under the path in
// main (the program writes into a leftover next to the target and only moves it into place when complete). Whoever gets
// `error` has not retrieved — the clear-away then does not mark its step as done (clearAway.js).
export async function copyBack({ helperInst, source, target, rels }) {
  if (!rels.length) return { back: [], denied: [], error: [] };
  const deadline = returnPathDeadline(await sizeIn(helperInst, target, rels.map((rel) => path.join(source, rel))));
  const { r, response, error } = await asAgent(helperInst, target, "back", [], { source, target, rels, onto: ontoMarkers() }, T("Retrieving"), deadline);
  if (r.code !== 0 || !response) throw new CopyError(error(), { code: "COPY_RETRIEVE", status: 500 });
  return { back: response.back || [], denied: response.denied || [], error: Array.isArray(response.error) ? response.error : [] };
}

export async function tarOfTheLayers({ helper, entries, file, cap }) {
  try {
    const r = await executeHelper(helper, ["python3", "-c", RETURN_PATH_PROGRAM, "tar"], {
      stdin: JSON.stringify({ entries, cap, missingCap: MISSING_CAP }), stdoutFile: file, capMs: returnPathCapMs(),
    });
    let missing = [];
    let missingCount = null;
    try {
      const j = JSON.parse(String(r.stderr || "").trim().split("\n").pop());
      missing = Array.isArray(j.missing) ? j.missing : [];
      if (Number.isInteger(j.count)) missingCount = j.count;
    } catch { /* no statement */ }
    return { size: fs.statSync(file).size, missing, missingCount: missingCount ?? missing.length };
  } catch (e) {
    if (e?.code === 4) throw new CopyError(T`Tar of the ignored files above ${cap} bytes (cap, estimated, not measured; knob CBASE_COPY_IGNORED_CAP) — not backed up`, { code: "COPY_CAP", status: 500 });
    throw new CopyError(T`Tar of the ignored files failed: ${text(e)}`, { code: "COPY_BACKUP", status: 500 });
  }
}
