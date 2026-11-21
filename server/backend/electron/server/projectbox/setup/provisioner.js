// The tool `PROVISIONER`: a Python program from the standard library, held as a constant and started in the project container —
//
//   commandRun(inst, root, "python3", ["-c", PROVISIONER, mode], { stdin: <JSON>, withoutDeadline: true, signal })
//
// The image has `python3` but no `unzip`/`bsdtar`; B never touches the mounted project folder through path names. Values never
// sit in argv: paths and mode come through stdin. No time cap (the content decides how long it takes); the abort is the `signal`
// (group kill in the container).
//
// Vocabulary: a "staging" is the folder `.cbase-source-<seq>` in the project that holds one uploaded source until it is placed;
// a "link" is a symlink (entry kind `reference`); an "item error" is one `{ kind, path }` in `error` — that item fails, the pass
// goes on; "the answer" is the human's choice overwrite | skip for files that already exist.
//
// The modes: `conflicts`, `place`, `size`, `list` and `unpack` (ZIP), `clone`.
//
//   conflicts  stdin `{ root, stagings: [abs], newFolders? }` — reading, over all stagings. `existing` and `examples` (≤ 5): the
//              files whose target in the root is already there (an agent wrote it while the chats kept running) — only targets
//              the answer decides (a file where a file goes). What `place` replaces in NO mode — a link at the target or on the
//              way, a file in the way of a folder, a folder where a file goes, something other than file/folder
//              (`never_replaced`) — is listed apart in `blocked` (number of PLACES, deduplicated) and `blockedExamples` (≤ 5, the
//              place where it lies — also an ancestor): offered as "overwrite", placing would fail there in every mode.
//              `throughReference`: a path part of the target is a link. `gitFolder` (relative folders that bring a `.git` FOLDER —
//              the "repo in repo" check on the real tree) and, parallel to it, `gitStaging` (the index into `stagings` of the
//              staging it comes from; without it "Continue without this source" finds nothing to leave out). ONLY THE OUTERMOST:
//              a `.git` folder that has a folder with a `.git` folder above it IN THE SAME staging belongs to the content of the
//              uploaded repo (a directly cloned theme `website/themes/t/.git`, `infra/.terraform/modules/vpc/.git`) — the
//              client's rule (web/src/lib/project-layout.ts: a block is the outermost repo, an inner `.git/HEAD` becomes no
//              node); counting every one lets the preview allow "create" and placing then fails each time. Across TWO stagings
//              "repo in repo" stays an error (two sources, targets `a` and `a/b`).
//              `gitCollision` (≤ 5) and `gitCollisionCount`: EVERY place that brings a `.git` (not only the outermost — an
//              embedded clone inside an uploaded repo would otherwise hit an existing repo) where the root already has a `.git`.
//              With the input `newFolders` also `newOccupied`: the new top folders the staging still carries and that exist at
//              the target by now (an agent created them — no longer a new folder, no code repo).
//   place      stdin `{ root, staging: abs, mode: "overwrite" | "skip" | "keep", references? }` — one staging into the root:
//              folders are created or entered (a folder that does not exist at the target at all moves as a WHOLE with one
//              rename), files with `os.replace` (atomic per file), with `skip` only where the target is missing — the skipped
//              source file is removed. `keep` is the mode the procedure picks BY ITSELF (no answer, nothing counted): like `skip`,
//              but NOTHING is removed — a file whose target only appeared after the count (a turn or agent kept running) stays in
//              the staging and counts in `occupied`; the procedure counts again and asks. Only a human's explicit "skip" discards.
//              Every path part below the root is opened without following a link (O_NOFOLLOW per part): a link ⇒ item error,
//              never followed; a folder in the way of a file or the reverse ⇒ item error.
//              NEVER into a `.git` that already exists at the target — an entry below a `.git` path part whose `.git` lies in the
//              root is the item error `repo` (once per `.git`, the subtree is skipped); otherwise overwrite/skip would replace or
//              add to HEAD, index, refs and objects file by file.
//              A link IN the staging is an item error — except with `references: true` (the staging of a ZIP source: its links
//              come from the archive and are meant to exist in the project): then it is placed INDIVIDUALLY like a file
//              (conflict, modes, `os.replace` moves the link, never its target) — also into a folder that already exists at the
//              target, and into the root. The out-of-project rule applies there once more: BEFORE any move, a link with an
//              absolute target or one that leads via ".." beyond the root is removed (computed from the target place, as when
//              unpacking — an agent can drop something into the staging), also inside a folder that moves as a whole; once all
//              are set, every placed link whose real place (realpath) is not inside the root is removed (`referenceOutside`, hint).
//              BEFORE that the rule of the `.git` FILE: it stays only if its `gitdir` is relative and points, inside the same
//              staging, at an existing `.git/modules/…` or `.git/worktrees/…` — otherwise it is removed (`omitted`, with a hint).
//              With `references: true` (only there — folder and file sources are written by the client), BEFORE any move every
//              file whose name is a part name of the unpacking (`.cbase-part-` + 32 hex characters, see "abort") is removed too:
//              the half file of an unpacking hit by a SIGKILL — `omitted`, ONE hint; if it could not be removed, item error
//              `part`. Afterwards empty folders of the staging are removed, last the staging itself.
//              Output `{ written, skipped, occupied, omitted, throughReference, referenceOutside, references, error[≤20],
//              errorCount, hints[≤20], rest }` (`rest`: is the staging still there?; `references`: links placed).
//   size       stdin `{ staging: abs }` — reading: the sum of the file sizes (lstat, no link followed) of a staging,
//              `{ bytes, files }`; a missing one is 0. The space check of the setup counts only what is STILL to come — what was
//              already staged at an abort has reduced the free space already.
//   list       stdin `{ archive: abs, mapping: [{ from, to | null }], omit: { folder, files }, root? }` — reading: the archive
//              (in the runtime folder, opened without following a link) against the plan. `{ entries, parentFolder, files,
//              references, folder, sizeDeclared, omitted, leftOut, gitFolder[≤200], hints[≤20], missing[≤5], missingCount,
//              withoutTarget[≤5], withoutTargetCount, existing, examples[≤5], throughReference, methodCount }` — `entries` without
//              the names that drop entirely once cleaned ("./"); `missing`: a `from` of the mapping with no entry below it that
//              the server does not omit anyway (for `""`: the archive has none at all); `withoutTarget`: a file or link no
//              `from` covers (both ⇒ PLAN_MATCHES_NOT in the procedure — the client's reader is no trust anchor); `methodCount`:
//              files and links with a method other than stored/deflate (plus ONE hint); `existing`/`examples` only with `root`
//              (the targets that already exist there; with `root` also `blocked`, `blockedExamples`, `gitCollision`,
//              `gitCollisionCount` — same computation as `conflicts`). Or `{ denied: { reason, names[≤5], text } }` (pre-check).
//   unpack     stdin `{ archive: abs, staging: abs, mapping, omit }` — into the staging, NEVER to the target place (the procedure
//              emptied it beforehand): `{ written, folder, references, omitted, leftOut, withoutTarget, throughReference,
//              referenceOutside, error[≤20], errorCount, hints[≤20], slot? }` or `{ denied }`.
//              THE RULES:
//              · Names: flag bit 11 ⇒ UTF-8, else cp437 — `orig_filename`, as zipfile decodes it (the "Unicode Path" field
//                0x7075 overrides only `filename` from Python 3.12 on; the client does not read it, so neither does this), cut
//                at the first NUL, `\` → `/`, NFC, then the "." parts are dropped (`clean_name` — bsdtar writes every name with
//                "./"; the same rule in web/src/lib/zip-directory.ts and Code/ZipDirectory.swift): "./proj/a.txt" →
//                "proj/a.txt", "proj/./x" → "proj/x", "proj/." → "proj" (file), the "/" of a folder entry stays; a name made
//                of "." parts only (".", "./", "././") drops entirely (no entry, counts nowhere). Compared AND written in NFC
//                (written raw below the prefix, an NFD name from the macOS Finder would leave a code repo of the plan missing
//                in the Linux container) — below the target path of the mapping the layout fixed (the one `codeRepos` and the
//                rules of the POST know). Two raw names equal in NFC: a file ⇒ item error `duplicate`, a folder is the same one.
//              · Pre-check before anything is written (AFTER cleaning): absolute, drive letter, an empty or a ".." part ⇒ the
//                whole archive `denied` (`unsafe`, at most 5 names in cleaned form — "", "/", "/./" → "/", "a//./b" → "a//b");
//                an encrypted entry (bit 0) ⇒ `encrypted`; a name with bit 11 that is not UTF-8 ⇒ `encoding`; no ZIP ⇒ `broken`.
//              · Mapping: per entry the longest matching `from` prefix (whole path parts, NFC); `from: ""` is the archive root
//                and covers everything — the clients send it for a ZIP WITHOUT a top folder (`{ from: "", to: <target of the
//                top node> | null }` plus the explicit entries below; one entry per first path part would exceed MAPPING_CAP
//                for a flat archive); `to: null` ⇒ left out. The target is checked again (no empty, ".", ".." part). Omitting
//                over every path part: the omit list including `__MACOSX`, `.DS_Store` — never inside a `.git` folder; plus a
//                `.git` FILE whose gitdir does not point relatively into the archive at `.git/modules|worktrees/…` of a repo
//                brought along (same computation as the client's preview, web/src/lib/project-layout.ts).
//              · No writing through links: every path part O_NOFOLLOW (`kette`); a link in the way ⇒ item error `reference`
//                (`throughReference`). Folders and files first, by depth; links FROM the archive last, by depth, with the same
//                parent check — an entry below a link of the archive never comes into being.
//              · Abort: a file is written under a part name in the same folder (`.cbase-part-` + 32 hex characters,
//                O_CREAT|O_EXCL|O_NOFOLLOW, 0600), with the same item errors at the target name by lstat before and at the end
//                (link ⇒ `reference`, folder ⇒ `folder-in-way`, other ⇒ `no-file`), done ⇒ fchmod and os.replace onto the
//                name; otherwise the part name is removed in the finally. SIGTERM (the abort, group kill) ends in this mode
//                through SystemExit so the finally blocks run; what a SIGKILL leaves behind is discarded by `place` with
//                `references` (above). So a target name never holds half a file, and "Take as is" takes whole files only. (An
//                archive entry that itself has such a name is dropped there too — the price of the rule.)
//              · Out of the project: a link with an absolute target or one that leads via ".." out of the project root
//                (computed from the TARGET place) is not created (`referenceOutside`, hint); and, once all are set, the real
//                place of every link (realpath) — chains like `a → .`, `b → a/..` are caught there.
//              · Permissions: `external_attr >> 16` & 0o777 without setuid/setgid/sticky, files at least u+r, folders u+rwx
//                (placing moves out of them); without Unix info 0644/0755. No chown.
//              · Bomb: ONLY the methods 0 (stored) and 8 (deflate) — for bzip2/LZMA zipfile calls `decompress` without
//                `max_length` (461 B archive, 650 MB memory): another method ⇒ item error `method` BEFORE any read. Files as
//                streams with a byte count against the declared size; more ⇒ `bomb`, a CRC or format error ⇒ `damaged`
//                (zipfile itself stops at the declared size and then reports the CRC) — the entry is dropped entirely. The
//                target of a link: method 0/8, `file_size` ≤ REFERENCE_MAX and `compress_size` ≤ 2·REFERENCE_MAX + 64, else
//                `reference-long`; read BOUNDED (`read(REFERENCE_MAX + 1)`, never `zf.read` — that would unpack the whole
//                stretch in one go), a length other than `file_size` ⇒ `damaged`.
//              · ENOSPC ⇒ `slot: true`, the unpacking ends.
//   clone      stdin `{ root, staging: abs, target: rel, onlyCheck? }`: a clone IS its staging (the repo itself,
//              `.cbase-source-<seq>` directly in the root — otherwise an error of the program) and moves as a WHOLE with ONE
//              rename to `target` — never mixed, never overwritten. What lies at the target, never following a link
//              (`target_kind`): something ⇒ `{ occupied: kind }` (also a link on the way), nothing is moved or deleted. The
//              parent folders of the target are created as when placing, without following a link (`kette`; a link or a file in
//              the way ⇒ `occupied`). The rename never replaces: renameat2(RENAME_NOREPLACE), on macOS renameatx_np(RENAME_EXCL)
//              through ctypes — if the file system does not know the flag, lstat at the target and renameat (`way`:
//              "without-replace" | "after-lstat"); a target that appears between check and rename is `occupied`. Done ⇒
//              `{ placed: true, way }`. If the staging is missing, the clone is already placed (`{ missing: true, occupied }` —
//              an earlier pass ended after the rename; repeatable). With `onlyCheck` only `{ free: true }` | `{ occupied }` —
//              the clone step asks that BEFORE cloning (TARGET_OCCUPIED, nothing is deleted), placing before every move.
//   Output     ONE JSON line. B reads only numbers and shortened names. An error of the program itself: `{ abort: text }` and
//              exit 2.
//
// `os.replace(…, src_dir_fd, dst_dir_fd)` (renameat): every move goes through the pinned folders — on Linux AND on macOS. The
// question asked is `os.rename in os.supports_dir_fd`: CPython registers only "rename" for HAVE_RENAMEAT, never "replace", although
// both are the same function (`os.replace in …` is always False, also in the container: every move would go through the path).
// Only where renameat is missing, through the path right after the check — named in the program (DIR_FD).
import { commandRun } from "../../runtime/git-run.js";
import { OMIT_FILES, OMIT_FOLDER } from "./rules.js";

export const PROVISIONER = String.raw`
import errno, json, os, re, secrets, signal, stat, sys, unicodedata, zipfile, zlib

DIR_FD = os.rename in os.supports_dir_fd  # NOT os.replace: CPython never lists it although it uses renameat (header)
OFL = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | os.O_NOFOLLOW
# Where the gitdir of a valid .git FILE points: ONE list for both rules (staging and archive).
GIT_UNDER = ("modules", "worktrees")
REFERENCE_MAX = 4096
# The compression methods whose unpacking bounds the amount (header "Bomb"): 0 (stored) and 8 (deflate, max_length per step).
METHODS = (0, 8)
# The part name of a file being unpacked (header "Abort") — in the same folder as its target.
PART_FRONT = ".cbase-part-"
PART_NAME = re.compile(r"^\.cbase-part-[0-9a-f]{32}$")

class ItemError(Exception):
    def __init__(self, kind, path):
        Exception.__init__(self, kind)
        self.kind = kind
        self.path = path

def short(p):
    return p if len(p) <= 300 else p[:297] + "..."

def lstat_at(name, fd):
    try:
        return os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return None

def open_chain(base, segs, create_missing):
    # A descriptor on base/segs, every part opened without following a link; create_missing: missing folders are created.
    fd = os.open(base, OFL)
    try:
        for i, t in enumerate(segs):
            try:
                n = os.open(t, OFL, dir_fd=fd)
            except FileNotFoundError:
                if not create_missing:
                    raise
                try:
                    os.mkdir(t, 0o755, dir_fd=fd)
                except FileExistsError:
                    pass
                n = os.open(t, OFL, dir_fd=fd)
            except OSError as e:
                st = lstat_at(t, fd)
                path = "/".join(segs[: i + 1])
                if st is not None and stat.S_ISLNK(st.st_mode):
                    raise ItemError("reference", path)
                if st is not None and not stat.S_ISDIR(st.st_mode):
                    raise ItemError("file-in-way", path)
                raise
            os.close(fd)
            fd = n
        return fd
    except BaseException:
        os.close(fd)
        raise

def walk_tree(base):
    # (rel, kind) per entry below base, never following a link; kind: folder, file, reference, different.
    out = []
    def descend(rel):
        try:
            listing = sorted(os.scandir(os.path.join(base, rel) if rel else base), key=lambda e: e.name)
        except OSError:
            return
        for e in listing:
            r = rel + "/" + e.name if rel else e.name
            try:
                st = e.stat(follow_symlinks=False)
            except OSError:
                continue
            if stat.S_ISLNK(st.st_mode):
                out.append((r, "reference"))
            elif stat.S_ISDIR(st.st_mode):
                out.append((r, "folder"))
                descend(r)
            elif stat.S_ISREG(st.st_mode):
                out.append((r, "file"))
            else:
                out.append((r, "different"))
    descend("")
    return out

def target_situation(root_dir, rel):
    # What lies at the target, never following a link, and WHERE: (kind, location) — kind as in target_kind, location the path part
    # (relative) where it lies (for "reference" and "file-in-way" also an ancestor of the target); (None, None) if the target is missing.
    segs = rel.split("/")
    p = root_dir
    for i, t in enumerate(segs):
        p = os.path.join(p, t)
        try:
            st = os.lstat(p)
        except FileNotFoundError:
            return None, None
        location = "/".join(segs[: i + 1])
        if stat.S_ISLNK(st.st_mode):
            return "reference", location
        if i < len(segs) - 1 and not stat.S_ISDIR(st.st_mode):
            return "file-in-way", location
        if i == len(segs) - 1:
            return ("folder" if stat.S_ISDIR(st.st_mode) else ("file" if stat.S_ISREG(st.st_mode) else "different")), location
    return None, None

def target_kind(root_dir, rel):
    # What lies at the target, never following a link: None (missing), "reference" (a path part or the target), "folder", "file", "different".
    return target_situation(root_dir, rel)[0]

def never_replaced(z, is_folder):
    # A target that "place" replaces in NO mode (an item error before any mode check): a link at the target or on the way, a file
    # in the way, something other than file/folder — plus a folder where a file goes and a file where a folder goes. It is no
    # conflict (the answer overwrite/skip would have no effect).
    if z in ("reference", "file-in-way", "different"):
        return True
    return z == ("file" if is_folder else "folder")

def git_collision(root_dir, rels):
    # EVERY place where the source brings a ".git" (folder or file) — not only the outermost — against the root: if something
    # already lies there under exactly this name, that is a repository cbase never writes into. → the places (the folder that
    # carries the ".git"; "" = the root), sorted.
    out = []
    for r in sorted(rels):
        g = r + "/.git" if r else ".git"
        try:
            z, location = target_situation(root_dir, g)
        except OSError:
            z, location = "different", g  # unreadable: rather denied than written into
        if z is not None and location == g:
            out.append(r)
    return out

def git_locations(rels):
    # The places that bring a ".git": per path the part BEFORE its first ".git" path part.
    out = set()
    for rel in rels:
        segs = rel.split("/")
        if ".git" in segs:
            out.add("/".join(segs[: segs.index(".git")]))
    return out

def mode_conflicts(a):
    # "existing" counts only targets the answer overwrite/skip decides (a file where a file goes); what is never replaced is listed
    # apart in "blocked"/"blockedExamples" (the places, deduplicated — a folder in the way counts once, not per file below it).
    # "gitCollision": see git_collision. "newOccupied" (input "newFolders"): the new top folders the staging STILL carries and
    # that exist at the target by now — an agent created them; they are no longer new.
    root_dir = a["root"]
    present_count = 0
    examples_list = []
    through_count = 0
    git = []
    git_in = []
    blocked = []
    seen = set()
    git_places = set()
    new_occupied = []
    for i, b in enumerate(a.get("stagings") or []):
        if not os.path.isdir(b) or os.path.islink(b):
            continue
        repos = set()  # the folders of this staging that carry a .git FOLDER
        listing = walk_tree(b)
        git_places |= git_locations([rel for rel, _ in listing])
        for rel, kind in listing:
            if kind == "different":
                continue  # an item error of the staging itself (no-file), no target
            z, location = target_situation(root_dir, rel)
            if kind == "folder":
                if os.path.basename(rel) == ".git":
                    repos.add(os.path.dirname(rel))
                if z is not None and never_replaced(z, True) and location not in seen:
                    seen.add(location)
                    blocked.append(short(location))
                continue
            if z is None:
                continue
            if z == "reference":
                through_count += 1
            if never_replaced(z, False):
                if location not in seen:
                    seen.add(location)
                    blocked.append(short(location))
                continue
            if z != "file":
                continue
            present_count += 1
            if len(examples_list) < 5:
                examples_list.append(short(rel))
        # Only the outermost (header): a repo with another one above it in THIS staging is its content.
        for e in sorted(repos):
            if is_outermost(e, repos) and len(git) < 200:
                git.append(e)
                git_in.append(i)
        for n in a.get("newFolders") or []:
            if isinstance(n, str) and n and "/" not in n and os.path.lexists(os.path.join(b, n)) and target_situation(root_dir, n)[0] is not None:
                new_occupied.append(n)
    collision = git_collision(root_dir, git_places)
    return {"existing": present_count, "examples": examples_list, "throughReference": through_count, "gitFolder": git, "gitStaging": git_in,
            "blocked": len(blocked), "blockedExamples": blocked[:5], "gitCollision": [short(r) for r in collision[:5]],
            "gitCollisionCount": len(collision), "newOccupied": sorted(set(new_occupied))}

def is_outermost(e, repos):
    # Is there no other folder from repos above e (relative, "/" as separator, "" = the staging itself)?
    if e == "":
        return True
    if "" in repos:
        return False
    segs = e.split("/")
    for n in range(1, len(segs)):
        if "/".join(segs[:n]) in repos:
            return False
    return True

def size(a):
    b = a["staging"]
    try:
        st = os.lstat(b)
    except FileNotFoundError:
        return {"bytes": 0, "files": 0}
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        raise ValueError("the staging is not a folder")
    total = 0
    num = 0
    for rel, kind in walk_tree(b):
        if kind != "file":
            continue
        try:
            total += os.lstat(os.path.join(b, rel)).st_size
            num += 1
        except OSError:
            pass
    return {"bytes": total, "files": num}

def git_file_applies(b, rel):
    # The rule of the .git FILE: relative gitdir, inside the same staging, pointing at an existing .git/modules/… or
    # .git/worktrees/…
    p = os.path.join(b, rel)
    try:
        with open(p, "rb") as f:
            text = f.read(4096).decode("utf-8", "replace")
    except OSError:
        return False
    target = None
    for z in text.splitlines():
        if z.startswith("gitdir:"):
            target = z[len("gitdir:"):].strip()
            break
    if not target or os.path.isabs(target):
        return False
    full_path = os.path.normpath(os.path.join(os.path.dirname(p), target))
    bn = os.path.normpath(b)
    if not full_path.startswith(bn + os.sep):
        return False
    segs = os.path.relpath(full_path, bn).split(os.sep)
    ok = False
    for i in range(len(segs) - 1):
        if segs[i] == ".git" and segs[i + 1] in GIT_UNDER:
            ok = True
    if not ok:
        return False
    # present, and no link on the way
    q = bn
    for t in segs:
        q = os.path.join(q, t)
        try:
            st = os.lstat(q)
        except FileNotFoundError:
            return False
        if stat.S_ISLNK(st.st_mode):
            return False
    return stat.S_ISDIR(st.st_mode)

def replace_at(b, root_dir, rel):
    segs = rel.split("/")
    name = segs[-1]
    dst_fd = open_chain(root_dir, segs[:-1], True)
    try:
        if DIR_FD:
            src_fd = open_chain(b, segs[:-1], False)
            try:
                return dst_fd, (lambda: os.replace(name, name, src_dir_fd=src_fd, dst_dir_fd=dst_fd)), src_fd
            except BaseException:
                os.close(src_fd)
                raise
        return dst_fd, (lambda: os.replace(os.path.join(b, rel), os.path.join(root_dir, rel))), None
    except BaseException:
        os.close(dst_fd)
        raise

def reference_gone_if_escapes(b, rel):
    # A link of the staging (parent folders opened without following a link, the link itself never followed): if it points absolute or
    # via ".." beyond the root (computed from the target place rel, same computation as when unpacking), it is removed. → True if removed.
    segs = rel.split("/")
    pfd = open_chain(b, segs[:-1], False)
    try:
        target = os.readlink(segs[-1], dir_fd=pfd)
        if target and not escapes(segs, target):
            return False
        os.unlink(segs[-1], dir_fd=pfd)
        return True
    finally:
        os.close(pfd)

def reference_gone_if_outside(root_dir, w_real, rel):
    # The placed link rel at the target: if its real place (realpath) does not end inside the root, it is removed (parent folders
    # opened without following a link, only a link is removed — whatever else lies there by now stays). → True if removed.
    segs = rel.split("/")
    try:
        pfd = open_chain(root_dir, segs[:-1], False)
    except (OSError, ItemError):
        return False
    try:
        st = lstat_at(segs[-1], pfd)
        if st is None or not stat.S_ISLNK(st.st_mode):
            return False
        real_path = os.path.realpath(os.path.join(root_dir, rel))
        if real_path == w_real or real_path.startswith(w_real + os.sep):
            return False
        os.unlink(segs[-1], dir_fd=pfd)
        return True
    finally:
        os.close(pfd)

def mode_place(a):
    root_dir = a["root"]
    b = a["staging"]
    mode = a.get("mode") or "skip"
    if mode not in ("overwrite", "skip", "keep"):
        raise ValueError("unknown mode " + mode)
    # The staging of a ZIP source carries links FROM THE ARCHIVE (they are meant to exist in the project) — only then
    # ("references: true", explicit) does the mode place a link INDIVIDUALLY, like a file (os.replace moves the link itself, never
    # its target). Without it a link stays an item error (folders/files: there the client writes files only).
    with_refs = a.get("references") is True
    out = {"written": 0, "skipped": 0, "occupied": 0, "omitted": 0, "throughReference": 0, "referenceOutside": 0, "references": 0, "error": [], "errorCount": 0, "hints": []}
    def error(kind, path):
        if kind == "reference":
            out["throughReference"] += 1
        out["errorCount"] += 1
        if len(out["error"]) < 20:
            out["error"].append({"kind": kind, "path": short(path)})
    def hint(t):
        if len(out["hints"]) < 20:
            out["hints"].append(t)
    st = os.lstat(b)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        raise ValueError("the staging is not a folder")
    listing = walk_tree(b)
    # Against KILL: a part name of the unpacking (header "Abort") is half a file — it is removed BEFORE any move (also inside a
    # folder about to move as a whole) and never reaches the project. Only in the staging of a ZIP source ("references"); folder
    # and file sources are written by the client, there the name is just a name.
    if with_refs:
        parts_gone = 0
        for rel, kind in listing:
            if kind != "file" or not PART_NAME.match(os.path.basename(rel)):
                continue
            segs = rel.split("/")
            try:
                pfd = open_chain(b, segs[:-1], False)
                try:
                    st = lstat_at(segs[-1], pfd)
                    if st is not None and stat.S_ISREG(st.st_mode):
                        os.unlink(segs[-1], dir_fd=pfd)
                finally:
                    os.close(pfd)
            except (OSError, ItemError):
                error("part", rel)  # not removed: visible, the source halts
                continue
            out["omitted"] += 1
            parts_gone += 1
        if parts_gone:
            hint(str(parts_gone) + " part file(s) of an aborted unpacking discarded")
            listing = walk_tree(b)
    # Pre-check: the .git FILES (before any move — the rule sees the staging as it was uploaded).
    for rel, kind in listing:
        if kind == "file" and os.path.basename(rel) == ".git" and not git_file_applies(b, rel):
            os.unlink(os.path.join(b, rel))
            out["omitted"] += 1
            hint(short(rel) + ": .git file without a valid target left out")
    # Once more BEFORE any move (the staging lies in the project, an agent can drop something there): a link with an absolute
    # target or one that leads via ".." beyond the root (same computation as when unpacking, from the target place) is removed
    # from the staging — also one inside a folder about to move as a whole, and before it could replace a file at the target.
    if with_refs:
        for rel, kind in listing:
            if kind != "reference":
                continue
            try:
                fort = reference_gone_if_escapes(b, rel)
            except (OSError, ItemError):
                continue  # gone, or a parent has become a link by now — the loop below reports what remains
            if fort:
                out["referenceOutside"] += 1
                hint(short(rel) + ": link pointing out of the project not created")
    placed_refs = []  # the links this pass brought to their place (individually or inside a folder that moved as a whole)
    done = set()  # folders whose subtree is no longer handled individually (moved as a whole, or their target is barred)
    git_situation = {}  # per ".git" place: what lies at the target (asked once — a ".git" carries thousands of entries)
    for rel, kind in walk_tree(b):
        if any(rel.startswith(x + "/") for x in done):
            continue
        if with_refs and kind == "file" and PART_NAME.match(os.path.basename(rel)):
            continue  # a part name that was not removed above (item error "part") — never into the project
        if kind == "different" or (kind == "reference" and not with_refs):
            error("reference" if kind == "reference" else "no-file", rel)
            continue
        # NEVER into a ".git" that already exists at the target — no replacing, no adding (HEAD, index, refs, objects of two
        # repositories mixed). Item error "repo" at the ".git", its subtree is skipped. A ".git" that does not exist at the target
        # moves as usual (as a whole with its folder or as a new folder of its own).
        segs = rel.split("/")
        if ".git" in segs:
            g = "/".join(segs[: segs.index(".git") + 1])
            if g not in git_situation:
                try:
                    git_situation[g] = target_situation(root_dir, g)
                except OSError:
                    git_situation[g] = ("different", g)
            gz = git_situation[g]
            if gz[0] is not None and gz[1] == g:
                error("repo", g)
                done.add(g)
                continue
        try:
            z = target_kind(root_dir, rel)
        except OSError as e:
            error("read", rel)
            done.add(rel)
            continue
        if z == "reference" or z == "file-in-way":
            error(z, rel)
            done.add(rel)
            continue
        if kind == "folder":
            if z is None:
                below = walk_tree(os.path.join(b, rel))
                n = sum(1 for _, x in below if x == "file")
                refs_below = [rel + "/" + r for r, x in below if x == "reference"] if with_refs else []
                try:
                    dst_fd, move, src_fd = replace_at(b, root_dir, rel)
                except ItemError as e:
                    error(e.kind, e.path)
                    done.add(rel)
                    continue
                except OSError:
                    error("move", rel)
                    done.add(rel)
                    continue
                done.add(rel)
                try:
                    move()
                    out["written"] += n
                    out["references"] += len(refs_below)
                    placed_refs.extend(refs_below)
                except OSError:
                    error("move", rel)
                finally:
                    os.close(dst_fd)
                    if src_fd is not None:
                        os.close(src_fd)
            elif z != "folder":
                error("file-in-way", rel)
                done.add(rel)
            continue
        # a file
        if z == "folder":
            error("folder-in-way", rel)
            continue
        if z == "different":
            error("no-file", rel)
            continue
        if z == "file" and mode == "skip":
            os.unlink(os.path.join(b, rel))
            out["skipped"] += 1
            continue
        if z == "file" and mode == "keep":
            out["occupied"] += 1  # stays in the staging (header: nothing is dropped silently)
            continue
        try:
            dst_fd, move, src_fd = replace_at(b, root_dir, rel)
        except ItemError as e:
            error(e.kind, e.path)
            continue
        except OSError:
            error("move", rel)
            continue
        try:
            dest = lstat_at(rel.split("/")[-1], dst_fd)
            if dest is not None and (stat.S_ISLNK(dest.st_mode) or stat.S_ISDIR(dest.st_mode)):
                error("reference" if stat.S_ISLNK(dest.st_mode) else "folder-in-way", rel)
                continue
            if dest is not None and mode == "skip":
                os.unlink(os.path.join(b, rel))
                out["skipped"] += 1
                continue
            if dest is not None and mode == "keep":
                out["occupied"] += 1
                continue
            move()
            if kind == "reference":
                out["references"] += 1
                placed_refs.append(rel)
            else:
                out["written"] += 1
        except OSError:
            error("move", rel)
        finally:
            os.close(dst_fd)
            if src_fd is not None:
                os.close(src_fd)
    # At the real place (as when unpacking, header): once all are set, every placed link must end INSIDE the root — a chain over
    # another link (one that was not there yet, or one an agent created at the target) is removed there, until nothing more goes.
    if placed_refs:
        w_real = os.path.realpath(root_dir)
        again = True
        while again:
            again = False
            for rel in list(placed_refs):
                if not reference_gone_if_outside(root_dir, w_real, rel):
                    continue
                placed_refs.remove(rel)
                out["references"] -= 1
                out["referenceOutside"] += 1
                hint(short(rel) + ": link pointing out of the project not created")
                again = True
    # Empty folders of the staging are removed, last the staging itself.
    for root_d, subdirs, files in os.walk(b, topdown=False):
        for o in subdirs:
            p = os.path.join(root_d, o)
            if not os.path.islink(p):
                try:
                    os.rmdir(p)
                except OSError:
                    pass
    try:
        os.rmdir(b)
        out["rest"] = False
    except OSError:
        out["rest"] = True
    return out

# ── ZIP: list and unpack ──────────────────────────────────────────────────────────────────────────────────────

class Rejected(Exception):
    def __init__(self, reason, names, text=""):
        Exception.__init__(self, reason)
        self.reason = reason
        self.names = names
        self.text = text

class NoSpace(Exception):
    pass

NEWLINES = re.compile("\r\n|\r|\n| | ")
GITDIR = re.compile(r"^gitdir:[ \t]*(.+?)[ \t]*$")
DRIVE = re.compile(r"^[A-Za-z]:")
BROKEN = (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError, RuntimeError)

def nfc(t):
    return unicodedata.normalize("NFC", t)

def open_archive(path):
    # Opened without following a link. A name with bit 11 that is not UTF-8 keeps zipfile from reading the archive at all (encoding).
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("the archive is not a file")
        f = os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise
    try:
        return f, zipfile.ZipFile(f)
    except UnicodeDecodeError:
        f.close()
        raise Rejected("encoding", [])
    except zipfile.BadZipFile as e:
        f.close()
        raise Rejected("broken", [], short(str(e)))
    except BaseException:
        f.close()
        raise

def clean_name(n):
    # The "." parts are dropped (bsdtar — macOS "tar --format zip -cf x.zip .", Windows "tar -a -c -f x.zip ." — writes every name
    # with "./"). THE SAME rule in web/src/lib/zip-directory.ts and mobile/…/Code/ZipDirectory.swift: split at "/" without the
    # trailing "/", every part that is exactly "." is dropped, joined again, the "/" of the folder entry put back. A name whose
    # parts were ALL "." (".", "./", "././") is dropped entirely (None: no entry, counts nowhere). An empty part stays (the
    # pre-check denies it): "", "/" and "/./" (→ "/") stay unsafe, "a//./b" becomes "a//b".
    trailing_slash = n.endswith("/")
    segs = (n[:-1] if trailing_slash else n).split("/")
    if all(t == "." for t in segs):
        return None
    return "/".join(t for t in segs if t != ".") + ("/" if trailing_slash else "")

def unsafe(n):
    # Zip slip (pre-check), AFTER clean_name: absolute, drive letter, an empty or a ".." part ("." no longer exists).
    if n.startswith("/") or DRIVE.match(n):
        return True
    bare = n[:-1] if n.endswith("/") else n
    return any(t in ("", ".", "..") for t in bare.split("/"))

class Entry(object):
    __slots__ = ("info", "nfc", "kind", "trailing_slash")

def decode_name(info):
    # Bit 11 ⇒ UTF-8, else cp437: orig_filename, as zipfile decodes it (field 0x7075 overrides only filename from Python 3.12
    # on, and the client does not read it); cut at the first NUL, "\\" → "/".
    raw = info.orig_filename
    i = raw.find("\x00")
    if i >= 0:
        raw = raw[:i]
    return raw.replace("\\", "/")

def read_entries(zf):
    # The name: decoded (NUL, "\\"), NFC, cleaned ("." parts) — compared AND written in NFC (e.nfc): written raw below the mapping
    # prefix, a ZIP from the macOS Finder would land in NFD, and a code repo of the plan — in NFC — would be missing in the Linux
    # container. Pre-check BEFORE any write: an unsafe name or an encrypted entry denies the whole archive (at most 5 names).
    unsafe_names, out_count, encrypted_names, encrypted_count, out = [], 0, [], 0, []
    for info in zf.infolist():
        n = clean_name(nfc(decode_name(info)))
        if n is None:
            continue
        if unsafe(n):
            out_count += 1
            if len(unsafe_names) < 5:
                unsafe_names.append(short(n))
            continue
        e = Entry()
        e.info = info
        e.trailing_slash = n.endswith("/")
        e.nfc = (n[:-1] if e.trailing_slash else n).split("/")
        hi = info.external_attr >> 16
        e.kind = "reference" if stat.S_ISLNK(hi) else ("folder" if e.trailing_slash else "file")
        if info.flag_bits & 0x1:
            encrypted_count += 1
            if len(encrypted_names) < 5:
                encrypted_names.append(short("/".join(e.nfc)))
        out.append(e)
    if out_count:
        raise Rejected("unsafe", unsafe_names)
    if encrypted_count:
        raise Rejected("encrypted", encrypted_names)
    return out

def upper_folders(listing):
    # Exactly one shared first path part (without __MACOSX/ and .DS_Store), and it is a folder.
    first = None
    is_folder = False
    for e in listing:
        t = e.nfc
        if t[0] == "__MACOSX" or t[-1] == ".DS_Store":
            continue
        if first is None:
            first = t[0]
        elif first != t[0]:
            return None
        if len(t) > 1 or e.trailing_slash:
            is_folder = True
    return first if first is not None and is_folder else None

def omitted_rule(e, omit_folders, omit_files):
    # The omit rule over every path part — never anything INSIDE a .git folder (it belongs to the repo), .DS_Store only outside.
    t = e.nfc
    g = t.index(".git") if ".git" in t else -1
    if g >= 0:
        segs = t[:g]
    else:
        segs = t if e.kind == "folder" else t[:-1]
    if any(x in omit_folders for x in segs):
        return True
    return g < 0 and e.kind != "folder" and t[-1] in omit_files

def resolve_link(subdirs, target):
    stack = []
    for t in list(subdirs) + target.split("/"):
        if t in ("", "."):
            continue
        if t == "..":
            if not stack:
                return None
            stack.pop()
            continue
        stack.append(t)
    return "/".join(stack)

def read_small(zf, info):
    if info.file_size > 4096 or info.compress_type not in METHODS or info.compress_size > 4096 * 2 + 64:
        return ""
    try:
        with zf.open(info) as q:
            return q.read(4096).decode("utf-8-sig", "replace")
    except Exception:
        return ""

def dead_git_files(zf, kept, upper):
    # The rule of the .git FILE in the archive (as the client computes it in the preview): relative gitdir that points, inside the
    # archive, at an existing .git/modules/… or .git/worktrees/… of a repo brought along — otherwise dead. Without a top folder
    # the imagined folder counts as first part, as in the client's origin.
    front = [] if upper is not None else ["\x00"]
    files = [front + e.nfc for e in kept if not e.trailing_slash]
    texts = ["/".join(x) for x in files]
    repo = set()
    for x in files:
        if len(x) >= 3 and x[-2] == ".git" and x[-1] == "HEAD" and x.count(".git") == 1:
            repo.add("/".join(x[:-2]))
    dead = set()
    for e in kept:
        if e.trailing_slash:
            continue
        x = front + e.nfc
        if x[-1] != ".git" or x.count(".git") != 1:
            continue
        target = ""
        for z in NEWLINES.split(read_small(zf, e.info)):
            m = GITDIR.match(z)
            if m:
                target = m.group(1)
                break
        resolved = resolve_link(x[:-1], target) if target and not target.startswith("/") and not DRIVE.match(target) else None
        alive = False
        if resolved:
            t = resolved.split("/")
            if ".git" in t:
                gi = t.index(".git")
                pre = resolved + "/"
                alive = (len(t) > gi + 2 and t[gi + 1] in GIT_UNDER and "/".join(t[:gi]) in repo
                        and any(y.startswith(pre) for y in texts))
        if not alive:
            dead.add(id(e))
    return dead

def target_ok(z):
    return bool(z) and all(t not in ("", ".", "..") and "\x00" not in t and "/" not in t for t in z)

def mapping_from(a):
    # [{ from, to | null }] → { from (NFC, "/"-separated; "" = the whole archive): target parts | None }
    out = {}
    for x in a.get("mapping") or []:
        source = x.get("from") if isinstance(x, dict) else None
        dest = x.get("to") if isinstance(x, dict) else None
        if not isinstance(source, str):
            raise ValueError("mapping: from is missing")
        if dest is not None and (not isinstance(dest, str) or not target_ok(dest.split("/"))):
            raise ValueError("mapping: invalid target")
        out["/".join(nfc(t) for t in source.split("/")) if source else ""] = None if dest is None else dest.split("/")
    return out

class Item(object):
    __slots__ = ("e", "z")

def plan_archive(zf, a):
    # The ONE computation for list and unpack: pre-check, omitting, .git rule, mapping (the longest prefix applies; the target
    # parts of the mapping, below them the archive's names in NFC).
    listing = read_entries(zf)
    omit = a.get("omit") or {}
    omit_folders = set(omit.get("folder") or [])
    omit_files = set(omit.get("files") or [])
    upper = upper_folders(listing)
    p = {"upper": upper, "entries": len(listing), "item": [], "omitted": 0, "leftOut": 0, "hints": [], "without": [], "withoutCount": 0, "missing": [], "missingCount": 0}
    kept = []
    for e in listing:
        if omitted_rule(e, omit_folders, omit_files):
            p["omitted"] += 1
        else:
            kept.append(e)
    dead = dead_git_files(zf, kept, upper)
    targets = mapping_from(a)
    prefixes = set()
    for e in kept:
        if id(e) in dead:
            p["omitted"] += 1
            if len(p["hints"]) < 20:
                p["hints"].append(short("/".join(e.nfc)) + ": .git file without a valid target left out")
            continue
        for k in range(1, len(e.nfc) + 1):
            prefixes.add("/".join(e.nfc[:k]))
        z = None
        hit = False
        for k in range(len(e.nfc), -1, -1):
            key = "/".join(e.nfc[:k])
            if key in targets:
                hit = True
                dest = targets[key]
                z = None if dest is None else list(dest) + e.nfc[k:]
                break
        if not hit:
            if e.kind != "folder":
                p["withoutCount"] += 1
                if len(p["without"]) < 5:
                    p["without"].append(short("/".join(e.nfc)))
            continue
        if z is None:
            p["leftOut"] += 1
            continue
        if not target_ok(z):
            raise ValueError("invalid target: " + short("/".join(z)))
        x = Item()
        x.e = e
        x.z = z
        p["item"].append(x)
    for source in targets:
        if not (source in prefixes or (source == "" and prefixes)):
            p["missingCount"] += 1
            if len(p["missing"]) < 5:
                p["missing"].append(short(source))
    return p

def git_folder(items):
    repos = set()
    for x in items:
        z = x.z
        for i, t in enumerate(z):
            if t == ".git" and (i < len(z) - 1 or x.e.kind == "folder"):
                repos.add("/".join(z[:i]))
                break
    return [r for r in sorted(repos) if is_outermost(r, repos)][:200]

def mode_list(a):
    f, zf = open_archive(a["archive"])
    try:
        p = plan_archive(zf, a)
        files = [x for x in p["item"] if x.e.kind != "folder"]
        # Files and links with a method other than stored/deflate are not unpacked (item error "method").
        method_count = sum(1 for x in files if x.e.info.compress_type not in METHODS)
        out = {
            "entries": p["entries"], "parentFolder": p["upper"], "files": sum(1 for x in files if x.e.kind == "file"),
            "references": sum(1 for x in files if x.e.kind == "reference"), "folder": len(p["item"]) - len(files),
            "sizeDeclared": sum(x.e.info.file_size for x in files), "omitted": p["omitted"],
            "leftOut": p["leftOut"], "gitFolder": git_folder(p["item"]), "hints": p["hints"],
            "missing": p["missing"], "missingCount": p["missingCount"], "withoutTarget": p["without"], "withoutTargetCount": p["withoutCount"],
            "existing": 0, "examples": [], "throughReference": 0, "methodCount": method_count,
        }
        if method_count and len(out["hints"]) < 20:
            out["hints"].append(str(method_count) + " entries with unsupported compression (only stored and deflate) — they are not unpacked")
        root_dir = a.get("root")
        if root_dir:
            # Same computation as "conflicts": "existing" only what the answer overwrite/skip decides; what is never replaced goes
            # into "blocked" (places, deduplicated — also a folder the archive knows only as the way to its files);
            # "gitCollision" over EVERY ".git" of the archive.
            blocked = []
            seen = set()
            for x in p["item"]:
                rel = "/".join(x.z)
                z, location = target_situation(root_dir, rel)
                if z is None:
                    continue
                is_folder = x.e.kind == "folder"
                if not is_folder and z == "reference":
                    out["throughReference"] += 1
                if never_replaced(z, is_folder):
                    if location not in seen:
                        seen.add(location)
                        blocked.append(short(location))
                    continue
                if is_folder or z != "file":
                    continue
                out["existing"] += 1
                if len(out["examples"]) < 5:
                    out["examples"].append(short(rel))
            collision = git_collision(root_dir, git_locations(["/".join(x.z) for x in p["item"]]))
            out.update({"blocked": len(blocked), "blockedExamples": blocked[:5],
                        "gitCollision": [short(r) for r in collision[:5]], "gitCollisionCount": len(collision)})
        return out
    finally:
        zf.close()
        f.close()

def write_everything(fd, buf):
    n = 0
    while n < len(buf):
        n += os.write(fd, buf[n:])

def in_way(name, dst_fd, rel):
    # What lies at the name of a file, without following it: a link, a folder or something other than a file ⇒ item error.
    st = lstat_at(name, dst_fd)
    if st is None or stat.S_ISREG(st.st_mode):
        return
    if stat.S_ISLNK(st.st_mode):
        raise ItemError("reference", rel)
    if stat.S_ISDIR(st.st_mode):
        raise ItemError("folder-in-way", rel)
    raise ItemError("no-file", rel)

def write_file(zf, info, b, z, rel):
    # NEVER written under the final name — half a file (abort, SIGKILL, full disk) would otherwise be taken into the project by
    # "Take as is". Written under a part name in the same folder (O_CREAT|O_EXCL|O_NOFOLLOW, 0600), done ⇒ fchmod and os.replace
    # onto the name (atomic; a link lying there by now is replaced, never followed). The part name is removed in the finally —
    # on abort through the SIGTERM handler (main), against SIGKILL when placing (header).
    dst_fd = open_chain(b, z[:-1], True)
    try:
        name = z[-1]
        in_way(name, dst_fd, rel)
        segment = PART_FRONT + secrets.token_hex(16)
        try:
            fd = os.open(segment, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dst_fd)
        except OSError as e:
            if e.errno == errno.ENOSPC:
                raise
            raise ItemError("write", rel)
        finished = False
        try:
            n = 0
            try:
                with zf.open(info) as q:
                    while True:
                        buf = q.read(1 << 20)
                        if not buf:
                            break
                        n += len(buf)
                        # Byte count against the declared size (bomb): more than announced ⇒ the entry aborts.
                        if n > info.file_size:
                            raise ItemError("bomb", rel)
                        write_everything(fd, buf)
            except BROKEN:
                raise ItemError("damaged", rel)
            if n != info.file_size:
                raise ItemError("damaged", rel)
            hi = info.external_attr >> 16
            # Permissions from the archive without setuid/setgid/sticky, read permission for agent always (u+r); without Unix info 0644.
            os.fchmod(fd, ((hi & 0o777) | 0o400) if hi else 0o644)
            in_way(name, dst_fd, rel)  # the same item errors as before, once more at the end (an agent put something in the way)
            try:
                if DIR_FD:
                    os.replace(segment, name, src_dir_fd=dst_fd, dst_dir_fd=dst_fd)
                else:
                    # Only without renameat (header, DIR_FD): through the path, right after the check.
                    os.replace(os.path.join(b, *(z[:-1] + [segment])), os.path.join(b, *z))
            except OSError as e:
                if e.errno == errno.ENOSPC:
                    raise
                st = lstat_at(name, dst_fd)
                raise ItemError("folder-in-way" if st is not None and stat.S_ISDIR(st.st_mode) else "write", rel)
            finished = True
        finally:
            os.close(fd)
            if not finished:
                try:
                    os.unlink(segment, dir_fd=dst_fd)
                except OSError:
                    pass
    finally:
        os.close(dst_fd)

def escapes(z, target):
    # Absolute, or via ".." beyond the project root — computed from the TARGET place of the link.
    if target.startswith("/"):
        return True
    stack = list(z[:-1])
    for t in target.split("/"):
        if t in ("", "."):
            continue
        if t == "..":
            if not stack:
                return True
            stack.pop()
        else:
            stack.append(t)
    return False

def mode_unpack(a):
    b = a["staging"]
    st = os.lstat(b)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        raise ValueError("the staging is not a folder")
    b_real = os.path.realpath(b)
    f, zf = open_archive(a["archive"])
    try:
        p = plan_archive(zf, a)
        out = {"written": 0, "folder": 0, "references": 0, "omitted": p["omitted"], "leftOut": p["leftOut"],
               "withoutTarget": p["withoutCount"], "throughReference": 0, "referenceOutside": 0, "error": [], "errorCount": 0, "hints": list(p["hints"])}
        def error(kind, path):
            if kind == "reference":
                out["throughReference"] += 1
            out["errorCount"] += 1
            if len(out["error"]) < 20:
                out["error"].append({"kind": kind, "path": short(path)})
        def hint(t):
            if len(out["hints"]) < 20:
                out["hints"].append(t)
        depth_key = lambda x: (len(x.z), x.z)
        normal = sorted([x for x in p["item"] if x.e.kind != "reference"], key=depth_key)
        with_refs = sorted([x for x in p["item"] if x.e.kind == "reference"], key=depth_key)
        modes = []
        seen_rels = set()
        try:
            for x in normal:
                rel = "/".join(x.z)
                try:
                    if x.e.kind == "folder":
                        os.close(open_chain(b, x.z, True))
                        hi = x.e.info.external_attr >> 16
                        # Folders: u+rwx — placing moves out of them (rename needs write permission on the source folder).
                        modes.append((x.z, ((hi & 0o777) | 0o700) if hi else 0o755))
                        out["folder"] += 1
                        continue
                    if x.e.info.compress_type not in METHODS:
                        raise ItemError("method", rel)  # BEFORE any read (bzip2/LZMA unpack without a bound per step)
                    if rel in seen_rels:
                        raise ItemError("duplicate", rel)
                    write_file(zf, x.e.info, b, x.z, rel)
                    seen_rels.add(rel)
                    out["written"] += 1
                except ItemError as e:
                    error(e.kind, e.path)
                except OSError as e:
                    if e.errno == errno.ENOSPC:
                        raise NoSpace()
                    error("write", rel)
            # Links FROM the archive last, sorted by depth, with the same parent check (no writing through links).
            created = []
            for x in with_refs:
                rel = "/".join(x.z)
                try:
                    info = x.e.info
                    # The target of a link is read BOUNDED — zf.read would unpack the whole stretch in one go (461 B archive,
                    # 650 MB memory). Only stored/deflate, at most as many compressed bytes as a target of REFERENCE_MAX needs,
                    # read REFERENCE_MAX + 1; more ⇒ reference-long, a length other than announced ⇒ damaged.
                    if info.compress_type not in METHODS:
                        raise ItemError("method", rel)
                    if info.file_size > REFERENCE_MAX or info.compress_size > 2 * REFERENCE_MAX + 64:
                        raise ItemError("reference-long", rel)
                    try:
                        with zf.open(info) as q:
                            raw = q.read(REFERENCE_MAX + 1)
                    except BROKEN:
                        raise ItemError("damaged", rel)
                    if len(raw) > REFERENCE_MAX:
                        raise ItemError("reference-long", rel)
                    if len(raw) != info.file_size:
                        raise ItemError("damaged", rel)
                    target = raw.decode("utf-8", "surrogateescape")
                    if not target or "\x00" in target:
                        raise ItemError("reference-invalid", rel)
                    if escapes(x.z, target):
                        out["referenceOutside"] += 1
                        hint(short(rel) + ": link pointing out of the project not created")
                        continue
                    pfd = open_chain(b, x.z[:-1], True)
                    try:
                        os.symlink(target, x.z[-1], dir_fd=pfd)
                    except FileExistsError:
                        raise ItemError("occupied", rel)
                    finally:
                        os.close(pfd)
                    created.append(x.z)
                    out["references"] += 1
                except ItemError as e:
                    error(e.kind, e.path)
                except OSError as e:
                    if e.errno == errno.ENOSPC:
                        raise NoSpace()
                    error("reference-create", rel)
            # Chains (a → ., b → a/..): the REAL place of every link must lie inside the staging — checked once all are set,
            # until nothing more goes.
            again = True
            while again:
                again = False
                for z in list(created):
                    real_path = os.path.realpath(os.path.join(b, *z))
                    if real_path == b_real or real_path.startswith(b_real + os.sep):
                        continue
                    pfd = open_chain(b, z[:-1], False)
                    try:
                        os.unlink(z[-1], dir_fd=pfd)
                    finally:
                        os.close(pfd)
                    created.remove(z)
                    out["references"] -= 1
                    out["referenceOutside"] += 1
                    hint(short("/".join(z)) + ": link pointing out of the project not created")
                    again = True
        except NoSpace:
            out["slot"] = True
        for z, m in sorted(modes, key=lambda x: -len(x[0])):
            try:
                fd = open_chain(b, z, False)
                try:
                    os.fchmod(fd, m)
                finally:
                    os.close(fd)
            except (OSError, ItemError):
                pass
        return out
    finally:
        zf.close()
        f.close()

def without_replace(sfd, s, dfd, d):
    # ONE rename that never replaces (header "clone"): renameat2(RENAME_NOREPLACE) on Linux, renameatx_np(RENAME_EXCL) on macOS;
    # if the file system does not know the flag (EINVAL/ENOSYS) or the function is missing, lstat at the target and renameat — named.
    try:
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        f, flag = getattr(libc, "renameat2", None), 1
        if f is None:
            f, flag = getattr(libc, "renameatx_np", None), 4
    except Exception:
        f = None
    if f is not None:
        if f(sfd, os.fsencode(s), dfd, os.fsencode(d), flag) == 0:
            return "without-replace"
        e = ctypes.get_errno()
        if e not in (errno.EINVAL, errno.ENOSYS, errno.ENOTSUP, getattr(errno, "EOPNOTSUPP", errno.ENOTSUP)):
            raise OSError(e, os.strerror(e))
    if lstat_at(d, dfd) is not None:
        raise FileExistsError(errno.EEXIST, "target exists")
    if DIR_FD:
        os.rename(s, d, src_dir_fd=sfd, dst_dir_fd=dfd)
    else:
        raise OSError(errno.ENOTSUP, "renameat is missing")
    return "after-lstat"

def mode_clone(a):
    # Header "clone": the staging of a clone as a WHOLE to its target — or only check whether the target is free.
    root_dir = a["root"]
    b = os.path.normpath(a["staging"])
    bname = os.path.basename(b)
    if os.path.dirname(b) != os.path.normpath(root_dir) or not bname.startswith(".cbase-source-"):
        raise ValueError("the staging does not lie directly in the root")
    rel = a.get("target") or ""
    segs = rel.split("/")
    if not rel or any(t in ("", ".", "..", ".git") for t in segs) or segs[0].lower().startswith(".cbase-"):
        raise ValueError("invalid target")
    wfd = os.open(root_dir, OFL)
    try:
        st = lstat_at(bname, wfd)
        if st is not None and (stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode)):
            raise ValueError("the staging is not a folder")
        kind = target_kind(root_dir, rel)
        if a.get("onlyCheck"):
            return {"occupied": kind} if kind is not None else {"free": True}
        if st is None:
            return {"missing": True, "occupied": kind}
        if kind is not None:
            return {"occupied": kind}
        try:
            pfd = open_chain(root_dir, segs[:-1], True)
        except ItemError as x:
            return {"occupied": x.kind}
        try:
            try:
                via = without_replace(wfd, bname, pfd, segs[-1])
            except (FileExistsError, IsADirectoryError, NotADirectoryError):
                return {"occupied": "existing"}
            except OSError as e:
                if e.errno in (errno.EEXIST, errno.ENOTEMPTY, errno.ENOTDIR, errno.EISDIR):
                    return {"occupied": "existing"}
                raise
        finally:
            os.close(pfd)
        return {"placed": True, "via": via}
    finally:
        os.close(wfd)

def on_term(signum, frame):
    # Header "Abort": SIGTERM (the group kill of the abort) ends through SystemExit — so the finally blocks run and the part name
    # of the file being written is removed. A second TERM during cleanup goes unheard.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise SystemExit(128 + signum)

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "unpack":
        signal.signal(signal.SIGTERM, on_term)
    try:
        a = json.loads(sys.stdin.read() or "{}")
        if mode == "conflicts":
            r = mode_conflicts(a)
        elif mode == "place":
            r = mode_place(a)
        elif mode == "size":
            r = size(a)
        elif mode == "list":
            r = mode_list(a)
        elif mode == "unpack":
            r = mode_unpack(a)
        elif mode == "clone":
            r = mode_clone(a)
        else:
            raise ValueError("unknown mode " + mode)
    except Rejected as x:
        # The pre-check (also on opening: encoding, broken) is a result, not an error of the program.
        r = {"denied": {"reason": x.reason, "names": x.names, "text": x.text}}
    except Exception as e:
        sys.stdout.write(json.dumps({"abort": short(type(e).__name__ + ": " + str(e))}) + "\n")
        sys.exit(2)
    sys.stdout.write(json.dumps(r) + "\n")

main()
`;

export class ProvisionerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProvisionerError";
    this.code = code;
  }
}

async function run(inst, root, mode, input, { signal = null } = {}) {
  const r = await commandRun(inst, root, "python3", ["-c", PROVISIONER, mode], { stdin: JSON.stringify(input), withoutDeadline: true, ...(signal ? { signal } : {}) });
  if (r.aborted) throw new ProvisionerError("ABORTED", `${mode}: aborted`);
  // An error of the program itself: PLACE, or (the archive modes) UNPACK.
  const code = mode === "list" || mode === "unpack" ? "UNPACK" : "PLACE";
  let response = null;
  try { response = JSON.parse(String(r.stdout || "").trim().split("\n").pop() || "null"); } catch { response = null; }
  if (!response || typeof response !== "object") {
    throw new ProvisionerError(code, `${mode} in the project container: ${String(r.stderr || "").trim().split("\n").slice(-2).join(" ").slice(0, 300) || `exit ${r.code}`}`);
  }
  if (response.abort) throw new ProvisionerError(code, `${mode} in the project container: ${String(response.abort).slice(0, 300)}`);
  return response;
}

/** Mode `conflicts` over all stagings (absolute) — `{ existing, examples, throughReference, gitFolder, gitStaging, blocked,
 *  blockedExamples, gitCollision, gitCollisionCount, newOccupied }` (header). `newFolders` (only the after-the-fact upload): the
 *  candidates for `newOccupied`. */
export const countConflicts = (inst, root, stagings, { newFolders, ...opts } = {}) =>
  run(inst, root, "conflicts", { root, stagings, ...(Array.isArray(newFolders) ? { newFolders } : {}) }, opts);

/** Mode `place` for ONE staging (absolute) — the program's output. `keep`: the mode without an answer (header). `references`:
 *  the staging of a ZIP source — its links are placed individually (header "place"). */
export function place(inst, root, staging, mode, { references = false, ...opts } = {}) {
  if (!["overwrite", "skip", "keep"].includes(mode)) throw new TypeError(`place: mode "${mode}"`);
  return run(inst, root, "place", { root, staging, mode, ...(references === true ? { references: true } : {}) }, opts);
}

/** Mode `size`: the bytes already lying in a staging (absolute) — a missing one is 0. */
export async function stagedBytes(inst, root, staging, opts) {
  const r = await run(inst, root, "size", { staging }, opts);
  if (!Number.isSafeInteger(r.bytes) || r.bytes < 0) throw new ProvisionerError("PLACE", `size in the project container: not a number (${String(r.bytes).slice(0, 40)})`);
  return r.bytes;
}

// The omit list of the rules (./rules.js) — the same one the clients get through `GET /api/projectCreation/rules`.
const omit = () => ({ folder: [...OMIT_FOLDER], files: [...OMIT_FILES] });

/** Mode `list`: the archive (absolute, in the runtime folder) against the mapping — see header. `againstRoot`: compute `existing`
 *  and `examples` against the root (after-the-fact upload; the creation counts when placing). */
export const archiveList = (inst, root, archive, mapping, { againstRoot = false, ...opts } = {}) =>
  run(inst, root, "list", { archive, mapping, omit: omit(), ...(againstRoot ? { root } : {}) }, opts);

/** Mode `unpack`: the archive into the staging (absolute) — see header. */
export const unpackArchive = (inst, root, archive, staging, mapping, opts) =>
  run(inst, root, "unpack", { archive, staging, mapping, omit: omit() }, opts);

/** Mode `clone`: the staging of a clone (absolute) as a WHOLE to `target` (relative to the root), with ONE rename that never
 *  replaces — `{ placed, way }` | `{ occupied: kind }` | `{ missing: true, occupied }`; with `onlyCheck` only `{ free }` | `{ occupied }`. */
export const placeClone = (inst, root, staging, target, { onlyCheck = false, ...opts } = {}) =>
  run(inst, root, "clone", { root, staging, target, ...(onlyCheck === true ? { onlyCheck: true } : {}) }, opts);
