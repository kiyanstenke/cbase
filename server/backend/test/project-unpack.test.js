// Uploading and unpacking a ZIP: the provisioner in the modes `list` and `unpack`, the archive routes of the setup
// (`sources/:seq/begin|finished|leaveOut|abort` of a ZIP source, `POST /api/projects/:id/archive`) and the post-start hook
// "project-archive".
//
// WHAT HOLDS HERE
//   The provisioner, run locally with python3 (the same program that runs in the project container; B never touches the folder):
//   (E1)  `../x`, `/etc/x`, `C:x` => the WHOLE archive is rejected ("unsafe"), in both modes — nothing written.
//   (E2)  a file THROUGH a link (a link in the way in the staging) => not written (`throughReference`); the link's target stays
//         empty, and `unpack` writes ONLY into the staging (the folder next to it stays as it was).
//   (E3)  a link entry UNDER a link of the archive => not created (links last, by depth, parent check).
//   (E4)  a link pointing out (absolute, via ".." above the root, a chain `k -> .`, `kk -> k/../..`) => `referenceOutside`, with a
//         hint; a link inside the project is created.
//   (E5)  `__MACOSX/` and `.DS_Store` dropped — `.git/HEAD` and everything INSIDE `.git` stays (also `.git/node_modules`).
//   (E6)  `.git` FILE: an absolute gitdir is dropped (hint), a relative one to `.git/modules/…` of a repo that came along stays.
//   (E7)  the parent folder stays (`list` reports `parentFolder`); without a parent folder `parentFolder: null`, and the client's
//         mapping puts everything under `<zipname>/` (also `.git` as an inner part).
//   (E8)  mapping: the longest matching prefix wins, `to: null` leaves out; a `from` without an entry (`missing`) and a file
//         without a `from` (`withoutTarget`) are counted — the stuff for PLAN_MATCHES_NOT.
//   (E9)  a name WITHOUT bit 11 in cp437 matches the client's mapping (it decodes the same way) — `missing` and `withoutTarget` 0.
//   (E10) mode 0 becomes readable (u+r), setuid/setgid/sticky are dropped, a folder gets u+rwx.
//   (E11) encrypted (bit 0) => rejected, nothing written.
//   (E12) bomb (declared size smaller than the content) => the entry aborts (single error, file gone), the rest stands.
//   (E1b) zip slip in every form: `\` becomes `/` (`..\x`, `a\..\..\x`, `\etc\x`), an empty part (`a//b`) => rejected, `names` in
//         the normalized form.
//   (E2b) no writing through an existing link as the FIRST path part (`proj` itself) and at the place of the FILE (to an existing
//         file outside — it stays untouched — and to a missing one — it is not created).
//   (E9b) bit 11 with NFD names (the macOS Finder) matches a mapping in NFC, and a `from` in NFD matches the archive (NFC at both
//         ends); the precondition is measured in the test itself (bit 11 set, `orig_filename` in NFD).
//   (E13) `place` with `references` (the staging of a ZIP source): a link arrives SINGLY — into a folder that already exists at the
//         target, and into the root (without the flag it stays a single error); links pointing out fall BEFORE any move (also one
//         that led back inside behind the ".." and one in a folder that moves as a whole) and replace no file on "overwrite"; once
//         all are set, a chain through a second link falls (`a -> b/../..`, `b -> .`).
//   (E14) bomb: a link with deflate (300 MiB of zeros, announced 1 B) => `reference-long`, a link with a wrong announced length =>
//         `damaged`, bzip2/LZMA (file and link) => `method` BEFORE any reading; judged by the AMOUNT from all decompressors of the run
//         (counted at `zipfile._get_decompressor`, < 64 KiB — not by memory); `list` counts `methodCount` 3 and gives ONE hint.
//   (E15) "." parts: a bsdtar archive (`./`, `./proj/…`, `proj/./x.txt`, `.`, `././`) is listed with parent folder `proj` and
//         unpacked (`proj/x.txt`); a name consisting only of "." parts is dropped, `proj/.` is the file `proj`; unsafe stay
//         `a//b`, `../x`, `./../x` (-> `../x`), `a//./b` (-> `a//b`), `/./` (-> `/`) and `""` — reported cleaned.
//   (E16) under the prefix, NFC is written — measured on the BYTES (`readdirSync(…, {encoding: "buffer"})`, APFS normalizes on
//         lookup); two NFC-equal raw names => the same folder or `duplicate`.
//   (E17) SIGTERM in the middle of a file (write gate after the first block) => exit 143 via SystemExit, in the staging neither a
//         part name nor half a target name; in the middle of writing ONLY the part name is there.
//   (E18) `place` with `references` discards part names (`.cbase-part-<32 hex>`) that a KILL left behind — also in a folder that
//         moves as a whole —, counts them as `omitted` with ONE hint; a similar name without 32 hex stays; without `references`
//         (folder/files) the name is just a name.
//   (E19) `from: ""` is the archive root — a flat ZIP lands under ONE target, `.git` as `<target>/.git` (`gitFolder` ["site"]);
//         `{from:"", to:null}` + `{from:"a", to:"a"}` keeps only `a`; `missing` [""] only if the archive carries nothing the server
//         does not leave out anyway.
//   (E20) every move (part name -> target name in `unpack`, file and folder in `place`) goes through `os.replace` with
//         src_dir_fd/dst_dir_fd — recorded at a wrapper around `os.replace`. The switch asks `os.rename in os.supports_dir_fd`:
//         CPython never lists "replace" there, `os.replace in …` was false everywhere.
//   Routes (withCreation: real server in server mode, fake docker that runs exec locally):
//   (R0)  without server mode `…/archive` 404; validation of the POST for `zip` (MAPPING mandatory, `from`/`to` checked, TARGET_DUPLICATE).
//   (R1)  `archiveId` idempotent per source — a second `begin` names the same id and `size` at the descriptor (resuming never starts
//         at zero); a foreign id => 409 ARCHIVE_FOREIGN, an invalid one => 400 ARCHIVE, address != body => 400 ARCHIVE_LOCATION; `offset`
//         is checked at the descriptor (a file that grew from outside => 409 OFFSET with its size), 0 replaces, a chunk beyond the
//         announced `bytes` => 400 CHUNK; `finished` with a wrong `size` => 409 ARCHIVE_INCOMPLETE; afterwards unpacked, placed, the
//         archive (row AND file) gone; the link hint stands in the bell.
//   (R2)  second tab: while a chunk is open => 409 UPLOAD_RUNNING (chunk, begin, finished, leaveOut) — with the operation in the
//         address from the BEGINNING of the request, without it as "unsettled" until the body.
//   (R3)  PLAN_MATCHES_NOT (a `from` missing in the archive) => source `error`, nothing unpacked, the archive `error`; "Again" unpacks
//         AGAIN (the completely uploaded archive stays — row, id at the source, file in full size —, `begin` accepts no new
//         upload); only "Continue without this source" discards it.
//   (R4)  abort in the middle of unpacking (provisioner at the gate) => `aborted`, staging and archive stay; meanwhile unpacking holds
//         `busy` (projectWork "unpack"), and `begin` of ANOTHER source works (RUNNING per source); "Again" unpacks anew and finishes.
//   (R5)  leaving out a ZIP source in `wait-upload` takes archive row and file along; the setup continues.
//   (R6)  the archive's links arrive when placing, even if an agent already created the parent folder in `wait-upload`, and in the
//         root (the layout created one there).
//   (R7)  "Take over": a single error (bomb) => source `error` UNPACK, the rest in the staging, the archive stays `unpack`, the link hint
//         is in the bell anyway; a second source `aborted`. `finished` without or with a wrong `takeOver` (also a client's `finished`
//         with `archiveId`/`size`) => 409 SOURCE_STATE; with `takeOver: true` => `staged`, the archive (row and file) falls, what was
//         there is placed.
//   (R8)  deletion routes: `DELETE /api/projects/:id` and `DELETE /api/workspaces/:id` take the archive FILE along, without purge (the
//         runtime folder stays — the file fell through the deletion route, not with the folder).
//   (R0)  also: `from: ""` twice => MAPPING, `./a` => MAPPING (clients send cleaned names), `from: null` => MAPPING.
//   (R9)  `abort` in the middle of a file (write gate) => the provisioner ends, the staging carries only `proj/`; a part name by hand
//         (as after a KILL) and "Take over" => in the project neither the half file nor the part name.
//   (R10) while `leaveOut` hangs at the deletion (gate before every exec), Again, `finished`, `begin` and a second `leaveOut` answer
//         409 RUNNING, and nobody touches the source; the closing row is CONDITIONAL — if a foreign route changes the source in
//         between, `leaveOut` answers 409 SOURCE_STATE, archive (row and file) and operation stay.
//   (R11) the view of a ZIP source carries `name` and `bytes` (other sources do not); a different size for an archive with bytes =>
//         409 ARCHIVE_DIFFERENT `{bytes, size}`, nothing cut, `bytes` stays; `fresh: "yes"` is no statement; `fresh: true` cuts to 0 at the
//         descriptor (same id, `size` 0), not under UPLOAD_RUNNING; `name` is checked with `fresh` (400 NAME for "", "/", NUL, 256
//         characters, number, null) and shown in the view, ignored without `fresh`; afterwards only the new archive unpacks.
//   (R12) a Finder ZIP (NFD) arrives with NFC bytes in the project, the plan's code repo (in NFC) is created; a flat ZIP with
//         `{from: "", to: "site"}` lands under `site/`.
//   Post-start:
//   (H)   "project-archive" leaves a source's archive in `wait-upload` and in `error` standing and removes ONLY an archive file without a
//         row (also: a file under the name of ANOTHER project's archive) and a row without a project (with its file); a foreign name in
//         the folder stays. Registered in server.js.
//
// COUNTER-TESTS (one sabotage each on the worktree, only the affected tests run; each sabotage turns red WITHOUT a hang):
//   provisioner.js `decode`: without bit 11 as UTF-8 instead of cp437 => (E9) red (wrong parent folder, missing 1, withoutTarget 2 —
//        on the server PLAN_MATCHES_NOT).
//   provisioner.js unpack: `zipfile.extractall(staging)` instead of its own routes => (E2) red at "nothing written through the link"
//        (files lay in the folder NEXT to it), (E3) and (E4) red.
//   operation.js beginArchive: `if (true)` instead of `if (!a)` (a new id per `begin`) => (R1) red: the second `begin` named a
//        different id and `size` 0 — resuming would start at zero.
//   archive.js cleanArchive: a deadline with dial 0 (`CBASE_ARCHIVE_DEADLINE_MS`, every row gone from its age) => (H) red: `rows` 3
//        instead of 1 (the open and the failed archive fell).
//   routes.js archiveChunk: without the check "chunk open for this operation" (operation in the address) => (R2) red: the second
//        tab's chunk got 200 instead of 409 UPLOAD_RUNNING.
//   provisioner.js `place`: a link of the staging always a single error (`kind in ("reference", "other")`) => (E13) red and (R6) red.
//   procedure.js stepPlace: without `references: true` for the ZIP source => (R6) red (same message).
//   provisioner.js `place`: the pre-check (links pointing out) off (`if False:`) => (E13) red: `w-p40/proj/out` missing (ENOENT) —
//        the link replaced the file, and the check at the real place removed it afterwards.
//   provisioner.js `place`: the check at the real place off => (E13) red at (c): `references` 2, `referenceOutside` 0 (the chain stood).
//   procedure.js restartState: the old body (archive in `error` falls) => (R3) red: "unpack again, do not upload again" (`wait-upload`
//        instead of `unpack`).
//   routes.js: without the "take over" row => (R7) red: 409 SOURCE_STATE instead of 202; without the `takeOver !== true` check =>
//        (R7) red: `finished` without a body got 202; only `["error"]` => (R7) red at source 2 (aborted: 409 instead of 202);
//        without `removeArchive` => (R7) red (the archive's row stayed).
//   procedure.js unpackSource: without `reportHints` after single errors => (R7) red ("link hint also after single errors in the bell",
//        WITHOUT a hang: judged after the event "source error"); with `archiveError` on single errors => (R7) red (archive `error`).
//   projectbox/erase.js setupsGone: without `removeArchiveFiles` => (R8) red ("the archive file fell with the project": true !== false).
//   provisioner.js `decode`: without `\` -> `/` => (E1b) red (`..\x` not rejected, only `withoutTarget`); `unsafe`: without the empty
//        part => (E1b) red (`a//b`).
//   provisioner.js write_file: without O_NOFOLLOW => (E2b) red ("not written through the link at the place of the file").
//   provisioner.js read_entries without `nfc` => (E9b) red (missing 2, withoutTarget 2); mapping_from without `nfc` => (E9b) red
//        (missing 1: the `from` in NFD).
//   Outside this file: fence-table.js without the row "project-archive" => fence.test.js red (`r.row` undefined for `POST …/archive`);
//   runtime-location.js `archiveFile` without the id check => runtime-location.test.js red ("Missing expected exception").
//   provisioner.js as a whole at the state before the repair (`git show HEAD:…`) => (E14) red (`methodCount` missing), (E15) red (the whole
//        archive "unsafe"), (E16) red (no `duplicate`), (E17) red (target name in the middle of writing), (E18) red (omitted 0), (R9) red,
//        (R12) red ("embedded repos (mode 160000)" — the NFD name broke the project repo); (E19) GREEN: the old provisioner understood `""`
//        already, the server had rejected it.
//   provisioner.js unpack: without the method lock of the files (`if False:`) => (E14) red: "unpacked: 16777231 B" (bzip2).
//   provisioner.js unpack: link unbraked (`zf.read(info)`, without the size check) => (E14) red: "unpacked: 314572811 B".
//   provisioner.js main: without the SIGTERM handler => (E17) red and (R9) red (the part name stayed in the staging).
//   provisioner.js `place`: without discarding part names (both places `if False`) => (E18) red and (R9) red.
//   status.js sourceRunning without `leaveOutRunning` => (R10) red at `finished` (202 instead of 409 RUNNING); procedure.js setupAgain without
//        `leaveOutRunning` => (R10) red at "Again" (the source already stood at `unpack` again); routes.js leaveOut: closing row without the
//        condition => (R10) red at (b) (202 instead of 409, the source was left out).
//   operation.js archiveDifferent always null => (R11) red (200 instead of 409 ARCHIVE_DIFFERENT); beginArchive without `name` => (R11) red
//        (the old name instead of the new one in the view).
//   sources.js `ofError(from)` also for `""` (the old state) => (R12) red: POST 400 MAPPING "`from` empty".
//   provisioner.js `DIR_FD = os.replace in os.supports_dir_fd` (the old state) => (E20) red: ["path", "path"].
//
// Wait only on events: row states through waitUntil (a state without a living procedure that is not the expected one THROWS),
// gates before the provisioner (pyHold) and after its first write block (pyWriteHold, setup-harness.mjs WRITE_GATE), a gate before
// every docker exec (fakeDocker `execGate`), the end of a process (processGone), the server reading a body (diagnostics_channel).
// No duration is a criterion.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import diagnostics from "node:diagnostics_channel";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { PROVISIONER } from "../electron/server/projectbox/setup/provisioner.js";
import { OMIT_FILES, OMIT_FOLDER } from "../electron/server/projectbox/setup/rules.js";
import { archivePath, cleanArchive } from "../electron/server/projectbox/setup/archive.js";
import { leaveOutRunning } from "../electron/server/projectbox/setup/status.js";
import { isArchiveId, locationFor } from "../electron/server/runs/runtime-location.js";
import { withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { ID } from "./projectbox-scenario.mjs";
import {
  REAL_PYTHON, ONLY_IN_OPS_TEXT, WRITE_GATE, active, request as requestData, create, staging, setupRoute, finished as setupFinished, git,
  inSources, read, withCreation, processGone, pyHold, pyWriteHold, pyWriteWaiting, pyWaiting, write, viewIn, gateClosed, waitUntil,
} from "./setup-harness.mjs";

const SERVER = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "electron", "server");

// ── Building a ZIP (python3 zipfile, as a packer writes it — with the cases a packer does not write) ─────────────────
//
// Per entry `{ name, kind?: "file"|"folder"|"reference", text?, b64?, target? (link), mode?, cp437? (the name as cp437 bytes
// WITHOUT bit 11), flags? (into the central directory after writing), lieSize? (declared size smaller than the content),
// zeros? (instead of content that many zero bytes, as a stream), method?: "stored"|"bzip2"|"lzma" (default deflate) }`.
const BUILD = String.raw`
import base64, json, sys, zipfile

class Info(zipfile.ZipInfo):
    def _encodeFilenameFlags(self):
        raw = getattr(self, "raw", None)
        if raw is not None:
            # WITHOUT bit 11: from Python 3.14 on, flag_bits of a name outside ASCII already carries the UTF-8 bit before writing
            # (measured on 3.14.8) — with it cp437 bytes would stand under the promise "UTF-8", and the provisioner would reject the names.
            return raw, self.flag_bits & ~0x800
        return zipfile.ZipInfo._encodeFilenameFlags(self)

a = json.load(sys.stdin)
with zipfile.ZipFile(a["target"], "w") as zf:
    for e in a["entries"]:
        info = Info(e["name"], date_time=(2026, 1, 1, 0, 0, 0))
        info.create_system = 3
        kind = e.get("kind", "file")
        mode = e.get("mode")
        if kind == "folder":
            info.external_attr = ((0o40000 | (0o755 if mode is None else mode)) << 16) | 0x10
            data = b""
        elif kind == "reference":
            info.external_attr = 0o120777 << 16
            data = e.get("target", "").encode()
        else:
            info.external_attr = (0o100000 | (0o644 if mode is None else mode)) << 16
            data = base64.b64decode(e["b64"]) if "b64" in e else e.get("text", "").encode()
        info.compress_type = {"stored": zipfile.ZIP_STORED, "bzip2": zipfile.ZIP_BZIP2, "lzma": zipfile.ZIP_LZMA}.get(e.get("method"), zipfile.ZIP_DEFLATED)
        if "cp437" in e:
            info.raw = e["cp437"].encode("cp437")
        if "zeros" in e:
            # One long run of zeros, written as a stream (the builder never holds more than one block) — stuff for a bomb.
            with zf.open(info, "w") as w:
                block = b"\0" * (1 << 20)
                rest = e["zeros"]
                while rest > 0:
                    w.write(block[:min(rest, len(block))])
                    rest -= len(block)
        else:
            zf.writestr(info, data)
        # zipfile sets the flags itself when writing — what stands here applies to the central directory (which zipfile reads).
        if e.get("flags"):
            info.flag_bits |= e["flags"]
        if "lieSize" in e:
            info.file_size = e["lieSize"]
`;

function buildZip(target, entries) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  execFileSync("python3", ["-c", BUILD], { input: JSON.stringify({ target, entries }) });
  return target;
}

const OUT = { folder: [...OMIT_FOLDER], files: [...OMIT_FILES] };

// The provisioner directly (local): the last line of the output as JSON; an exit != 0 throws with the output.
function provisioner(mode, input) {
  const out = execFileSync("python3", ["-c", PROVISIONER, mode], { input: JSON.stringify({ omit: OUT, ...input }), encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}

function withFolder(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-unpack-")));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The tree under `root` as a sorted list of paths (folders with "/", links with " -> target").
function tree(root) {
  const out = [];
  const go = (d, rel) => {
    for (const n of fs.readdirSync(d).sort()) {
      const abs = path.join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) out.push(`${r} -> ${fs.readlinkSync(abs)}`);
      else if (st.isDirectory()) { out.push(`${r}/`); go(abs, r); }
      else out.push(r);
    }
  };
  go(root, "");
  return out.map((x) => x.normalize("NFC")).sort();
}

// ── (E) The provisioner ───────────────────────────────────────────────────────────────────────────────────────────

test("(E1) `../x`, `/etc/x`, `C:x` => the whole archive rejected (unsafe), in list and unpack — nothing written", () => {
  withFolder((dir) => {
    for (const malicious of ["../x", "/etc/x", "C:x"]) {
      const zip = buildZip(path.join(dir, `${encodeURIComponent(malicious)}.zip`), [{ name: "proj/a.txt", text: "a" }, { name: malicious, text: "b" }]);
      const l = provisioner("list", { archive: zip, mapping: [{ from: "proj", to: "proj" }] });
      assert.equal(l.denied?.reason, "unsafe", `${malicious}: ${JSON.stringify(l)}`);
      assert.deepEqual(l.denied.names, [malicious]);
      const b = path.join(dir, `b-${encodeURIComponent(malicious)}`);
      fs.mkdirSync(b);
      const e = provisioner("unpack", { archive: zip, staging: b, mapping: [{ from: "proj", to: "proj" }] });
      assert.equal(e.denied?.reason, "unsafe", malicious);
      assert.deepEqual(fs.readdirSync(b), [], `${malicious}: nothing written, not even the good entry`);
    }
  });
});

test("(E2) a file through a link => not written; unpack writes ONLY into the staging", () => {
  withFolder((dir) => {
    const zip = buildZip(path.join(dir, "a.zip"), [
      { name: "proj/a.txt", text: "a" }, { name: "proj/sub/x.txt", text: "through the link" }, { name: "proj/sub/deep/y.txt", text: "y" },
    ]);
    const b = path.join(dir, "b");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(path.join(b, "proj"), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(b, "proj", "sub")); // in the way: a link leading out of the staging
    const prior = fs.readdirSync(dir).sort();
    const e = provisioner("unpack", { archive: zip, staging: b, mapping: [{ from: "proj", to: "proj" }] });
    // Safety first (the counter-test with extractall turns red HERE, not at a number).
    assert.deepEqual(fs.readdirSync(outside), [], "nothing written through the link");
    assert.deepEqual(fs.readdirSync(dir).sort(), prior, "nothing was created next to the staging");
    assert.equal(e.denied, undefined, JSON.stringify(e));
    assert.equal(e.written, 1, JSON.stringify(e));
    assert.equal(e.throughReference, 2, JSON.stringify(e));
    assert.equal(e.errorCount, 2, JSON.stringify(e));
    assert.deepEqual(e.error, [{ kind: "reference", path: "proj/sub" }, { kind: "reference", path: "proj/sub" }], "the link in the way");
    assert.equal(read(path.join(b, "proj", "a.txt")), "a");
  });
});

test("(E3) a link entry under a link of the archive => not created", () => {
  withFolder((dir) => {
    const zip = buildZip(path.join(dir, "a.zip"), [
      { name: "proj/a.txt", text: "a" }, { name: "proj/sub/", kind: "folder" },
      { name: "proj/lnk", kind: "reference", target: "sub" }, { name: "proj/lnk/inner", kind: "reference", target: "../a.txt" },
    ]);
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    const e = provisioner("unpack", { archive: zip, staging: b, mapping: [{ from: "proj", to: "proj" }] });
    assert.equal(e.references, 1, JSON.stringify(e));
    // The single error names the link IN THE WAY (the parent chain breaks there), not the entry below it.
    assert.deepEqual(e.error, [{ kind: "reference", path: "proj/lnk" }]);
    assert.equal(e.errorCount, 1);
    assert.deepEqual(tree(b), ["proj/", "proj/a.txt", "proj/lnk -> sub", "proj/sub/"], "nothing was created under the link");
  });
});

test("(E4) links pointing out (absolute, via “..”, as a chain) => referenceOutside with a hint; a link inside the project is created", () => {
  withFolder((dir) => {
    const zip = buildZip(path.join(dir, "a.zip"), [
      { name: "proj/a.txt", text: "a" }, { name: "proj/l1", kind: "reference", target: "a.txt" },
      { name: "proj/l2", kind: "reference", target: "../../etc" }, { name: "proj/abs", kind: "reference", target: "/etc/passwd" },
      { name: "proj/k", kind: "reference", target: "." }, { name: "proj/kk", kind: "reference", target: "k/../.." },
    ]);
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    const e = provisioner("unpack", { archive: zip, staging: b, mapping: [{ from: "proj", to: "proj" }] });
    assert.equal(e.referenceOutside, 3, JSON.stringify(e));
    assert.equal(e.references, 2);
    assert.equal(e.errorCount, 0, JSON.stringify(e.error));
    for (const n of ["proj/l2", "proj/abs", "proj/kk"]) assert.ok(e.hints.some((h) => h.startsWith(`${n}: link pointing out of the project`)), n);
    assert.deepEqual(tree(b), ["proj/", "proj/a.txt", "proj/k -> .", "proj/l1 -> a.txt"]);
  });
});

test("(E5) __MACOSX/ and .DS_Store dropped — .git/HEAD and everything in .git stays", () => {
  withFolder((dir) => {
    const zip = buildZip(path.join(dir, "a.zip"), [
      { name: "proj/a.txt", text: "a" }, { name: "proj/node_modules/x.js", text: "x" }, { name: "proj/web/.next/c.js", text: "c" },
      { name: "__MACOSX/proj/._a.txt", text: "m" }, { name: "proj/.DS_Store", text: "d" },
      { name: "proj/.git/HEAD", text: "ref: refs/heads/main\n" }, { name: "proj/.git/node_modules/keep", text: "k" },
    ]);
    const l = provisioner("list", { archive: zip, mapping: [{ from: "proj", to: "proj" }] });
    assert.equal(l.parentFolder, "proj", "__MACOSX does not count as a second parent folder");
    assert.equal(l.omitted, 4, JSON.stringify(l));
    assert.deepEqual(l.gitFolder, ["proj"]);
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    const e = provisioner("unpack", { archive: zip, staging: b, mapping: [{ from: "proj", to: "proj" }] });
    assert.equal(e.omitted, 4);
    assert.deepEqual(tree(b), ["proj/", "proj/.git/", "proj/.git/HEAD", "proj/.git/node_modules/", "proj/.git/node_modules/keep", "proj/a.txt"]);
  });
});

test("(E6) .git file: an absolute gitdir falls (hint), a relative one to .git/modules/… of a repo that came along stays", () => {
  withFolder((dir) => {
    const zip = buildZip(path.join(dir, "a.zip"), [
      { name: "proj/.git/HEAD", text: "ref: refs/heads/main\n" }, { name: "proj/.git/modules/sub/HEAD", text: "abc\n" },
      { name: "proj/sub/.git", text: "gitdir: ../.git/modules/sub\n" }, { name: "proj/sub/s.txt", text: "s" },
      { name: "proj/lib/.git", text: "gitdir: /etc/x\n" }, { name: "proj/lib/l.txt", text: "l" },
    ]);
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    const e = provisioner("unpack", { archive: zip, staging: b, mapping: [{ from: "proj", to: "proj" }] });
    assert.ok(e.hints.includes("proj/lib/.git: .git file without a valid target left out"), JSON.stringify(e.hints));
    assert.equal(fs.existsSync(path.join(b, "proj", "lib", ".git")), false, "the absolute gitdir fell");
    assert.equal(read(path.join(b, "proj", "sub", ".git")), "gitdir: ../.git/modules/sub\n", "the relative one to .git/modules stays");
    assert.equal(read(path.join(b, "proj", "lib", "l.txt")), "l");
  });
});

test("(E7) the parent folder stays and `list` reports it; without a parent folder `null`, the mapping puts everything under <zipname>/", () => {
  withFolder((dir) => {
    const including = buildZip(path.join(dir, "with.zip"), [{ name: "proj/", kind: "folder" }, { name: "proj/a.txt", text: "a" }, { name: "proj/s/b.txt", text: "b" }]);
    assert.equal(provisioner("list", { archive: including, mapping: [{ from: "proj", to: "proj" }] }).parentFolder, "proj");
    const b1 = path.join(dir, "b1");
    fs.mkdirSync(b1);
    provisioner("unpack", { archive: including, staging: b1, mapping: [{ from: "proj", to: "proj" }] });
    assert.deepEqual(tree(b1), ["proj/", "proj/a.txt", "proj/s/", "proj/s/b.txt"]);
    // Without a parent folder (a repo, packed directly): the client maps every first part to `<zipname>/<part>` — `.git` as an inner part.
    const without = buildZip(path.join(dir, "without.zip"), [{ name: "a.txt", text: "a" }, { name: "s/b.txt", text: "b" }, { name: ".git/HEAD", text: "ref: x\n" }]);
    const mapping = [{ from: "a.txt", to: "without/a.txt" }, { from: "s", to: "without/s" }, { from: ".git", to: "without/.git" }];
    const l = provisioner("list", { archive: without, mapping });
    assert.equal(l.parentFolder, null);
    assert.deepEqual([l.missingCount, l.withoutTargetCount, l.gitFolder], [0, 0, ["without"]]);
    const b2 = path.join(dir, "b2");
    fs.mkdirSync(b2);
    provisioner("unpack", { archive: without, staging: b2, mapping });
    assert.deepEqual(tree(b2), ["without/", "without/.git/", "without/.git/HEAD", "without/a.txt", "without/s/", "without/s/b.txt"]);
  });
});

test("(E8) mapping: the longest prefix wins, `null` leaves out; `missing` and `withoutTarget` are counted", () => {
  withFolder((dir) => {
    const zip = buildZip(path.join(dir, "a.zip"), [
      { name: "proj/a.txt", text: "a" }, { name: "proj/x/b.txt", text: "b" }, { name: "proj/x/y/c.txt", text: "c" }, { name: "proj/w/d.txt", text: "d" },
    ]);
    const mapping = [{ from: "proj", to: "fresh" }, { from: "proj/x", to: "different/x2" }, { from: "proj/x/y", to: null }];
    const l = provisioner("list", { archive: zip, mapping });
    assert.deepEqual([l.files, l.leftOut, l.missingCount, l.withoutTargetCount], [3, 1, 0, 0], JSON.stringify(l));
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    const e = provisioner("unpack", { archive: zip, staging: b, mapping });
    assert.equal(e.leftOut, 1);
    assert.deepEqual(tree(b), ["different/", "different/x2/", "different/x2/b.txt", "fresh/", "fresh/a.txt", "fresh/w/", "fresh/w/d.txt"]);
    const plan = provisioner("list", { archive: zip, mapping: [{ from: "proj/x", to: "x" }, { from: "proj/exists-not", to: "g" }] });
    assert.deepEqual([plan.missingCount, plan.missing, plan.withoutTargetCount, plan.withoutTarget], [1, ["proj/exists-not"], 2, ["proj/a.txt", "proj/w/d.txt"]]);
  });
});

test("(E9) a name without bit 11 in cp437 matches the mapping (missing and withoutTarget 0) and is written under the decoded name", () => {
  withFolder((dir) => {
    const zip = buildZip(path.join(dir, "win.zip"), [{ name: "Übung/ä.txt", cp437: "Übung/ä.txt", text: "u" }, { name: "Übung/b.txt", cp437: "Übung/b.txt", text: "b" }]);
    const mapping = [{ from: "Übung", to: "Übung" }];
    const l = provisioner("list", { archive: zip, mapping });
    assert.deepEqual([l.parentFolder, l.missingCount, l.withoutTargetCount, l.files], ["Übung", 0, 0, 2], JSON.stringify(l));
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    const e = provisioner("unpack", { archive: zip, staging: b, mapping });
    assert.equal(e.written, 2, JSON.stringify(e));
    assert.deepEqual(tree(b), ["Übung/", "Übung/b.txt", "Übung/ä.txt"]);
  });
});

test("(E10) mode 0 becomes readable, setuid/setgid/sticky fall, a folder gets u+rwx", () => {
  withFolder((dir) => {
    const zip = buildZip(path.join(dir, "a.zip"), [
      { name: "proj/null.txt", text: "n", mode: 0 }, { name: "proj/s.sh", text: "#!/bin/sh\n", mode: 0o4755 },
      { name: "proj/g.sh", text: "g", mode: 0o2711 }, { name: "proj/d/", kind: "folder", mode: 0 }, { name: "proj/d/x.txt", text: "x" },
    ]);
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    const e = provisioner("unpack", { archive: zip, staging: b, mapping: [{ from: "proj", to: "proj" }] });
    assert.equal(e.errorCount, 0, JSON.stringify(e.error));
    const m = (rel) => fs.statSync(path.join(b, rel)).mode & 0o7777;
    assert.equal(m("proj/null.txt"), 0o400);
    assert.equal(m("proj/s.sh"), 0o755);
    assert.equal(m("proj/g.sh"), 0o711);
    assert.equal(m("proj/d"), 0o700);
    assert.equal(read(path.join(b, "proj", "null.txt")), "n");
  });
});

test("(E11) encrypted (bit 0) => rejected, nothing written", () => {
  withFolder((dir) => {
    const zip = buildZip(path.join(dir, "a.zip"), [{ name: "x/a", text: "a" }, { name: "x/secret", text: "g", flags: 1 }]);
    assert.deepEqual(provisioner("list", { archive: zip, mapping: [{ from: "x", to: "x" }] }).denied, { reason: "encrypted", names: ["x/secret"], text: "" });
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    assert.equal(provisioner("unpack", { archive: zip, staging: b, mapping: [{ from: "x", to: "x" }] }).denied?.reason, "encrypted");
    assert.deepEqual(fs.readdirSync(b), []);
  });
});

test("(E12) bomb: more content than declared => the entry aborts and falls, the rest stands", () => {
  withFolder((dir) => {
    const zip = buildZip(path.join(dir, "a.zip"), [{ name: "x/a", text: "a" }, { name: "x/bomb", b64: Buffer.alloc(1 << 20).toString("base64"), lieSize: 16 }]);
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    const e = provisioner("unpack", { archive: zip, staging: b, mapping: [{ from: "x", to: "x" }] });
    assert.equal(e.errorCount, 1, JSON.stringify(e));
    assert.ok(["bomb", "damaged"].includes(e.error[0].kind), JSON.stringify(e.error));
    assert.equal(e.error[0].path, "x/bomb");
    assert.deepEqual(tree(b), ["x/", "x/a"], "the aborted entry is not there, not even partly");
  });
});

// ── Review gaps ──────────────────────────────────────────────────────────────────────────────────────────────────

test("(E1b) zip slip in every form: `\\` becomes `/` (`..\\x`, `a\\..\\..\\x`, `\\etc\\x`), an empty part (`a//b`) => denied", () => {
  withFolder((dir) => {
    for (const [malicious, normal] of [["..\\x", "../x"], ["a\\..\\..\\x", "a/../../x"], ["\\etc\\x", "/etc/x"], ["a//b", "a//b"]]) {
      const zip = buildZip(path.join(dir, `${encodeURIComponent(malicious)}.zip`), [{ name: "proj/a.txt", text: "a" }, { name: malicious, text: "b" }]);
      const l = provisioner("list", { archive: zip, mapping: [{ from: "proj", to: "proj" }] });
      assert.equal(l.denied?.reason, "unsafe", `${malicious}: ${JSON.stringify(l)}`);
      assert.deepEqual(l.denied.names, [normal], `${malicious}: the name after normalization`);
      const b = path.join(dir, `b-${encodeURIComponent(malicious)}`);
      fs.mkdirSync(b);
      const e = provisioner("unpack", { archive: zip, staging: b, mapping: [{ from: "proj", to: "proj" }] });
      assert.equal(e.denied?.reason, "unsafe", malicious);
      assert.deepEqual(fs.readdirSync(b), [], `${malicious}: nothing written`);
    }
  });
});

test("(E2b) no writing through an existing link — also as the FIRST path part and at the place of the file itself", () => {
  withFolder((dir) => {
    const zip = buildZip(path.join(dir, "a.zip"), [{ name: "proj/a.txt", text: "malicious" }, { name: "proj/c.txt", text: "malicious" }, { name: "proj/sub/d.txt", text: "malicious" }, { name: "proj/ok.txt", text: "ok" }]);
    // (i) The first path part `proj` is a link pointing out (an agent put it into the staging, P1).
    const b1 = path.join(dir, "b1");
    const outside1 = path.join(dir, "outside1");
    fs.mkdirSync(b1);
    fs.mkdirSync(outside1);
    fs.symlinkSync(outside1, path.join(b1, "proj"));
    const e1 = provisioner("unpack", { archive: zip, staging: b1, mapping: [{ from: "proj", to: "proj" }] });
    assert.deepEqual(fs.readdirSync(outside1), [], "nothing written through the link at the first path part");
    assert.equal(e1.written, 0, JSON.stringify(e1));
    assert.equal(e1.errorCount, 4);
    assert.ok(e1.error.every((f) => f.kind === "reference" && f.path === "proj"), JSON.stringify(e1.error));
    // (ii) The file itself is a link: to an existing file outside, and to one that does not exist (O_CREAT would create it).
    const b2 = path.join(dir, "b2");
    const outside2 = path.join(dir, "outside2");
    fs.mkdirSync(path.join(b2, "proj"), { recursive: true });
    fs.mkdirSync(outside2);
    fs.writeFileSync(path.join(outside2, "target.txt"), "untouched");
    fs.symlinkSync(path.join(outside2, "target.txt"), path.join(b2, "proj", "a.txt"));
    fs.symlinkSync(path.join(outside2, "fresh.txt"), path.join(b2, "proj", "c.txt"));
    const e2 = provisioner("unpack", { archive: zip, staging: b2, mapping: [{ from: "proj", to: "proj" }] });
    assert.equal(read(path.join(outside2, "target.txt")), "untouched", "not written through the link at the place of the file");
    assert.deepEqual(fs.readdirSync(outside2), ["target.txt"], "no file was created outside");
    assert.deepEqual(e2.error, [{ kind: "reference", path: "proj/a.txt" }, { kind: "reference", path: "proj/c.txt" }], JSON.stringify(e2));
    assert.equal(e2.throughReference, 2);
    assert.equal(read(path.join(b2, "proj", "ok.txt")), "ok");
    assert.equal(read(path.join(b2, "proj", "sub", "d.txt")), "malicious", "an entry without a link in the way is created");
  });
});

test("(E9b) bit 11 with NFD names (how the macOS Finder packs umlauts) matches a mapping in NFC — and a mapping in NFD matches the archive", () => {
  withFolder((dir) => {
    const nfd = (s) => s.normalize("NFD");
    const zip = buildZip(path.join(dir, "mac.zip"), [{ name: nfd("Übung/a.txt"), text: "a" }, { name: nfd("Übung/März/b.txt"), text: "b" }]);
    // The precondition of the case: bit 11 set, the names in the archive in NFD.
    const raw = JSON.parse(execFileSync("python3", ["-c", "import json,sys,zipfile; print(json.dumps([[i.flag_bits & 0x800, i.orig_filename] for i in zipfile.ZipFile(sys.argv[1]).infolist()]))", zip], { encoding: "utf8" }));
    assert.deepEqual(raw, [[0x800, nfd("Übung/a.txt")], [0x800, nfd("Übung/März/b.txt")]]);
    // The client's mapping: the parent folder in NFC, a subfolder in NFD (both ends are compared in NFC).
    const mapping = [{ from: "Übung".normalize("NFC"), to: "Übung".normalize("NFC") }, { from: nfd("Übung/März"), to: "Übung/Maerz" }];
    const l = provisioner("list", { archive: zip, mapping });
    assert.deepEqual([l.parentFolder, l.missingCount, l.withoutTargetCount, l.files], ["Übung".normalize("NFC"), 0, 0, 2], JSON.stringify(l));
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    const e = provisioner("unpack", { archive: zip, staging: b, mapping });
    assert.deepEqual([e.written, e.withoutTarget, e.errorCount], [2, 0, 0], JSON.stringify(e));
    assert.deepEqual(tree(b), ["Übung/", "Übung/Maerz/", "Übung/Maerz/b.txt", "Übung/a.txt"]);
  });
});

test("(E13) `place` with `references` (ZIP): links singly to their place — into an existing folder and into the root; links pointing out once more", () => {
  withFolder((dir) => {
    const place = (input) => provisioner("place", input);
    // (a) An agent created `proj/` in `wait-upload` (P1); the layout put `top` into the root; `fresh/` is missing at the target.
    const create2 = (name) => {
      const w = path.join(dir, name);
      const b = path.join(w, ".cbase-source-1");
      write(path.join(w, "proj", "from-agent.txt"), "agent");
      write(path.join(b, "proj", "a.txt"), "a");
      fs.symlinkSync("a.txt", path.join(b, "proj", "l1"));
      fs.symlinkSync("proj/a.txt", path.join(b, "top"));
      fs.mkdirSync(path.join(b, "fresh"));
      fs.symlinkSync("../proj/a.txt", path.join(b, "fresh", "l2"));
      return { w, b };
    };
    const including = create2("w-with");
    const r = place({ root: including.w, staging: including.b, mode: "keep", references: true });
    assert.deepEqual([r.errorCount, r.references, r.written, r.referenceOutside, r.rest], [0, 3, 1, 0, false], JSON.stringify(r));
    assert.deepEqual(tree(including.w), ["fresh/", "fresh/l2 -> ../proj/a.txt", "proj/", "proj/a.txt", "proj/from-agent.txt", "proj/l1 -> a.txt", "top -> proj/a.txt"]);
    // Without the flag a link in the staging stays a single error (folder/files sources, unchanged).
    const without = create2("w-without");
    const r0 = place({ root: without.w, staging: without.b, mode: "keep" });
    assert.deepEqual(r0.error, [{ kind: "reference", path: "proj/l1" }, { kind: "reference", path: "top" }], JSON.stringify(r0));
    assert.equal(r0.rest, true);

    // (b) Links pointing out BEFORE any move: (absolute, via “..” above the root — even if it led back inside behind it)
    // fall out of the staging, also in a folder that moves as a whole, and do NOT replace a file at the target on "overwrite".
    const w = path.join(dir, "w-p40");
    const b = path.join(w, ".cbase-source-1");
    write(path.join(w, "proj", "out"), "old");
    fs.mkdirSync(path.join(b, "proj"), { recursive: true });
    fs.symlinkSync("../../etc", path.join(b, "proj", "out"));
    fs.symlinkSync(`../../${path.basename(w)}/proj/out`, path.join(b, "proj", "back"));
    fs.mkdirSync(path.join(b, "fresh"));
    fs.symlinkSync("/etc/passwd", path.join(b, "fresh", "abs"));
    const r2 = place({ root: w, staging: b, mode: "overwrite", references: true });
    assert.equal(read(path.join(w, "proj", "out")), "old", "the link pointing out did not replace the file at the target");
    assert.deepEqual(tree(w), ["fresh/", "proj/", "proj/out"], JSON.stringify(r2));
    assert.deepEqual([r2.referenceOutside, r2.references, r2.errorCount], [3, 0, 0], JSON.stringify(r2));
    for (const n of ["proj/out", "proj/back", "fresh/abs"]) assert.ok(r2.hints.includes(`${n}: link pointing out of the project not created`), n);

    // (c) And at the real place, once all are set: a chain that leads out only with the second link (`a -> b/../..`, `b -> .`).
    const wk = path.join(dir, "w-chain");
    const bk = path.join(wk, ".cbase-source-1");
    fs.mkdirSync(path.join(wk, "proj"), { recursive: true });
    fs.mkdirSync(path.join(bk, "proj"), { recursive: true });
    fs.symlinkSync("b/../..", path.join(bk, "proj", "a"));
    fs.symlinkSync(".", path.join(bk, "proj", "b"));
    const r3 = place({ root: wk, staging: bk, mode: "keep", references: true });
    assert.deepEqual(tree(wk), ["proj/", "proj/b -> ."], JSON.stringify(r3));
    assert.deepEqual([r3.referenceOutside, r3.references, r3.errorCount], [1, 1, 0]);
    assert.ok(r3.hints.includes("proj/a: link pointing out of the project not created"), JSON.stringify(r3.hints));
  });
});

// ── Review findings 1–4 and 7 at the provisioner ────────────────────────────────────────────────────────────────

// The provisioner with a counter at the source of every unpacking (zipfile._get_decompressor): how many bytes the decompressors of
// this run produced in total — also what zipfile cut to the declared size afterwards. The value goes into a file at the end.
// This measures what the process unpacked, not how much memory it held (RSS would depend on the platform and the allocator).
const COUNTER = String.raw`import atexit, os, zipfile
_real = zipfile._get_decompressor
_sum = [0]
class _Counter(object):
    def __init__(self, d):
        self._d = d
    def decompress(self, data, *a):
        r = self._d.decompress(data, *a)
        _sum[0] += len(r)
        return r
    def flush(self, *a):
        r = self._d.flush(*a)
        _sum[0] += len(r)
        return r
    def __getattr__(self, n):
        return getattr(self._d, n)
def _counting(t):
    d = _real(t)
    return d if d is None else _Counter(d)
zipfile._get_decompressor = _counting
atexit.register(lambda: open(os.environ["CBASE_TEST_COUNTER"], "w").write(str(_sum[0])))
`;
function provisionerCounted(mode, input, counterFile) {
  const out = execFileSync("python3", ["-c", COUNTER + PROVISIONER, mode], {
    input: JSON.stringify({ omit: OUT, ...input }), encoding: "utf8", env: { ...process.env, CBASE_TEST_COUNTER: counterFile },
  });
  return { r: JSON.parse(out.trim().split("\n").pop()), unpacked: Number(fs.readFileSync(counterFile, "utf8")) };
}
const PART_NAME = /^\.cbase-part-[0-9a-f]{32}$/;

test("(E14) bomb through a link (deflate, 300 MiB of zeros, announced 1 B) and through bzip2/LZMA => single error, nothing unpacked", () => {
  withFolder((dir) => {
    const zip = buildZip(path.join(dir, "bomb.zip"), [
      { name: "x/a.txt", text: "a" },
      { name: "x/l-bomb", kind: "reference", zeros: 300 << 20, lieSize: 1 },
      { name: "x/bz", method: "bzip2", zeros: 16 << 20, lieSize: 16 },
      { name: "x/lz", method: "lzma", text: "lzma" },
      { name: "x/l-bz", kind: "reference", target: "a.txt", method: "bzip2" },
      { name: "x/l-announced", kind: "reference", target: "a.txt", lieSize: 9 },
      { name: "x/l-ok", kind: "reference", target: "a.txt" },
    ]);
    // The precondition of the case, measured in the archive: method, announced and compressed size.
    const raw = JSON.parse(execFileSync("python3", ["-c", "import json,sys,zipfile; print(json.dumps({i.filename: [i.compress_type, i.file_size, i.compress_size] for i in zipfile.ZipFile(sys.argv[1]).infolist()}))", zip], { encoding: "utf8" }));
    assert.deepEqual([raw["x/l-bomb"][0], raw["x/l-bomb"][1]], [8, 1]);
    assert.ok(raw["x/l-bomb"][2] > 2 * 4096 + 64, `compressed ${raw["x/l-bomb"][2]} B`);
    assert.deepEqual([raw["x/bz"][0], raw["x/bz"][1]], [12, 16]);
    assert.ok(raw["x/bz"][2] < 4096, `bzip2: ${raw["x/bz"][2]} B for 16 MiB`);
    assert.equal(raw["x/lz"][0], 14);

    const zl = path.join(dir, "counter-list");
    const { r: l, unpacked: listedList } = provisionerCounted("list", { archive: zip, mapping: [{ from: "x", to: "x" }] }, zl);
    assert.equal(l.methodCount, 3, JSON.stringify(l));
    assert.deepEqual(l.hints.filter((h) => /unsupported compression/.test(h)), ["3 entries with unsupported compression (only stored and deflate) — they are not unpacked"], "ONE hint");
    assert.equal(listedList, 0, "list unpacks nothing");

    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    const { r: e, unpacked } = provisionerCounted("unpack", { archive: zip, staging: b, mapping: [{ from: "x", to: "x" }] }, path.join(dir, "counter"));
    // The amount first: in this run all decompressors together produced less than 64 KiB (a bomb would give 300 or 16 MiB).
    assert.ok(unpacked < 64 * 1024, `unpacked: ${unpacked} B`);
    const kinds = Object.fromEntries(e.error.map((f) => [f.path, f.kind]));
    assert.deepEqual(kinds, { "x/bz": "method", "x/lz": "method", "x/l-bz": "method", "x/l-bomb": "reference-long", "x/l-announced": "damaged" }, JSON.stringify(e));
    assert.equal(e.errorCount, 5);
    assert.deepEqual(tree(b), ["x/", "x/a.txt", "x/l-ok -> a.txt"]);
  });
});

test("(E15) “.” parts fall (bsdtar writes “./”) — listed with a parent folder and unpacked; “a//b”, “../x” and relatives stay unsafe", () => {
  withFolder((dir) => {
    const zip = buildZip(path.join(dir, "bsdtar.zip"), [
      { name: "./", kind: "folder" }, { name: "./proj/", kind: "folder" }, { name: "./proj/a.txt", text: "a" },
      { name: "./proj/sub/b.txt", text: "b" }, { name: "./proj/./x.txt", text: "x" }, { name: ".", text: "dropped completely" }, { name: "././", kind: "folder" },
    ]);
    const raw = JSON.parse(execFileSync("python3", ["-c", "import json,sys,zipfile; print(json.dumps([i.orig_filename for i in zipfile.ZipFile(sys.argv[1]).infolist()]))", zip], { encoding: "utf8" }));
    assert.deepEqual(raw, ["./", "./proj/", "./proj/a.txt", "./proj/sub/b.txt", "./proj/./x.txt", ".", "././"], "the names stand raw in the archive");
    const mapping = [{ from: "proj", to: "proj" }];
    const l = provisioner("list", { archive: zip, mapping });
    assert.equal(l.denied, undefined, JSON.stringify(l));
    assert.deepEqual([l.parentFolder, l.entries, l.files, l.folder, l.missingCount, l.withoutTargetCount], ["proj", 4, 3, 1, 0, 0], JSON.stringify(l));
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    const e = provisioner("unpack", { archive: zip, staging: b, mapping });
    assert.deepEqual([e.written, e.errorCount], [3, 0], JSON.stringify(e));
    assert.deepEqual(tree(b), ["proj/", "proj/a.txt", "proj/sub/", "proj/sub/b.txt", "proj/x.txt"], "“proj/./x.txt” lands as “proj/x.txt”");
    // “proj/.” is the file “proj” (no folder entry: it does not end in “/”).
    const file = buildZip(path.join(dir, "point.zip"), [{ name: "proj/.", text: "p" }]);
    const ld = provisioner("list", { archive: file, mapping: [{ from: "proj", to: "p/proj" }] });
    assert.deepEqual([ld.parentFolder, ld.files, ld.missingCount, ld.withoutTargetCount], [null, 1, 0, 0], JSON.stringify(ld));
    const bd = path.join(dir, "bd");
    fs.mkdirSync(bd);
    provisioner("unpack", { archive: file, staging: bd, mapping: [{ from: "proj", to: "p/proj" }] });
    assert.deepEqual(tree(bd), ["p/", "p/proj"]);
    // Unsafe stays what is absolute after dropping the “.” parts or has an empty or “..” part (reported cleaned).
    for (const [malicious, normal] of [["a//b", "a//b"], ["../x", "../x"], ["./../x", "../x"], ["a//./b", "a//b"], ["/./", "/"], ["", ""]]) {
      const z = buildZip(path.join(dir, `u-${encodeURIComponent(malicious) || "empty"}.zip`), [{ name: "proj/a.txt", text: "a" }, { name: malicious, text: "b" }]);
      const lu = provisioner("list", { archive: z, mapping });
      assert.equal(lu.denied?.reason, "unsafe", `${JSON.stringify(malicious)}: ${JSON.stringify(lu)}`);
      assert.deepEqual(lu.denied.names, [normal], `${JSON.stringify(malicious)}: reported cleaned`);
    }
  });
});

test("(E16) under the mapping's prefix NFC is written (bytes, not through a normalizing path); NFC-equal raw names => `duplicate` or the same folder", () => {
  withFolder((dir) => {
    const nfd = (s) => s.normalize("NFD");
    const zip = buildZip(path.join(dir, "finder.zip"), [
      { name: nfd("Kunden/Projekt Müller/"), kind: "folder" }, { name: "Kunden/Projekt Müller/".normalize("NFC"), kind: "folder" },
      { name: nfd("Kunden/Projekt Müller/index.html"), text: "<h1>nfd</h1>" }, { name: "Kunden/Projekt Müller/index.html".normalize("NFC"), text: "<h1>nfc</h1>" },
    ]);
    const raw = JSON.parse(execFileSync("python3", ["-c", "import json,sys,zipfile; print(json.dumps([[i.flag_bits & 0x800, i.orig_filename] for i in zipfile.ZipFile(sys.argv[1]).infolist()]))", zip], { encoding: "utf8" }));
    assert.deepEqual(raw.map(([bit]) => bit), [0x800, 0x800, 0x800, 0x800], "bit 11");
    assert.equal(raw[2][1], nfd("Kunden/Projekt Müller/index.html"), "the precondition: the raw name in NFD");
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    const e = provisioner("unpack", { archive: zip, staging: b, mapping: [{ from: "Kunden", to: "Kunden" }] });
    assert.deepEqual(e.error, [{ kind: "duplicate", path: "Kunden/Projekt Müller/index.html".normalize("NFC") }], JSON.stringify(e));
    assert.deepEqual([e.written, e.folder], [1, 2]);
    const names = fs.readdirSync(path.join(b, "Kunden"), { encoding: "buffer" });
    assert.deepEqual(names.map((n) => n.toString("hex")), [Buffer.from("Projekt Müller", "utf8").toString("hex")], "the folder carries the NFC bytes (M\\xc3\\xbcller)");
    const inside = fs.readdirSync(Buffer.concat([Buffer.from(`${b}/Kunden/`), names[0]]), { encoding: "buffer" });
    assert.deepEqual(inside.map((n) => n.toString()), ["index.html"]);
  });
});

test("(E17) SIGTERM in the middle of a large file => no part name and no half target name in the staging", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-unpack-abort-")));
  try {
    const gates = path.join(dir, "gates");
    fs.mkdirSync(gates);
    fs.writeFileSync(path.join(gates, "write-gate.py"), WRITE_GATE);
    const zip = buildZip(path.join(dir, "large.zip"), [{ name: "proj/aaa-large.bin", zeros: 3 << 20 }, { name: "proj/z.txt", text: "z" }]);
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    const subprocess = spawn(REAL_PYTHON, [path.join(gates, "write-gate.py"), "unpack", PROVISIONER], { stdio: ["pipe", "pipe", "pipe"] });
    const end = new Promise((resolve) => subprocess.on("exit", (code, sig) => resolve({ code, sig })));
    subprocess.stdin.end(JSON.stringify({ omit: OUT, archive: zip, staging: b, mapping: [{ from: "proj", to: "proj" }] }));
    const pid = await pyWriteWaiting(gates, "unpack");
    assert.equal(pid, subprocess.pid);
    // In the middle of the file: the first block lies under the part name, the target name is missing.
    const midway = fs.readdirSync(path.join(b, "proj"));
    assert.equal(midway.length, 1, JSON.stringify(midway));
    assert.match(midway[0], PART_NAME, "under a part name, never under the target name");
    assert.equal(fs.statSync(path.join(b, "proj", midway[0])).size, 1 << 20, "the first block");
    subprocess.kill("SIGTERM");
    const r = await end;
    assert.deepEqual(tree(b), ["proj/"], "no part name and no half target name");
    assert.deepEqual([r.code, r.sig], [143, null], "ended via SystemExit (the finally blocks ran)");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("(E18) `place` with `references` (ZIP) discards leftover part names (SIGKILL) — also in a folder that moves as a whole; not without the flag", () => {
  withFolder((dir) => {
    const part = (n) => `.cbase-part-${crypto.createHash("md5").update(String(n)).digest("hex")}`;
    const create2 = (name) => {
      const w = path.join(dir, name);
      const b = path.join(w, ".cbase-source-1");
      write(path.join(w, "proj", "here.txt"), "da"); // `proj/` already exists at the target: the file moves singly
      write(path.join(b, "proj", "a.txt"), "a");
      write(path.join(b, "proj", part(1)), "half");
      write(path.join(b, "fresh", part(2)), "half"); // `fresh/` is missing at the target: the folder moves as a whole
      write(path.join(b, "proj", ".cbase-part-short"), "not a part name");
      return { w, b };
    };
    const including = create2("w-zip");
    const r = provisioner("place", { root: including.w, staging: including.b, mode: "keep", references: true });
    assert.deepEqual([r.errorCount, r.omitted, r.rest], [0, 2, false], JSON.stringify(r));
    assert.ok(r.hints.includes("2 part file(s) of an aborted unpacking discarded"), JSON.stringify(r.hints));
    assert.deepEqual(tree(including.w), ["fresh/", "proj/", "proj/.cbase-part-short", "proj/a.txt", "proj/here.txt"]);
    // Folder and files sources (without `references`): there the name is just a name.
    const without = create2("w-folder");
    const r0 = provisioner("place", { root: without.w, staging: without.b, mode: "keep" });
    assert.deepEqual([r0.errorCount, r0.omitted], [0, 0], JSON.stringify(r0));
    assert.deepEqual(tree(without.w), ["fresh/", `fresh/${part(2)}`, "proj/", `proj/${part(1)}`, "proj/.cbase-part-short", "proj/a.txt", "proj/here.txt"].sort());
  });
});

test("(E19) `from: \"\"` is the archive root — a flat ZIP without a parent folder lands under ONE target, `.git` as <target>/.git; with `null` and a longer prefix only that one", () => {
  withFolder((dir) => {
    const zip = buildZip(path.join(dir, "flat.zip"), [
      { name: "index.html", text: "i" }, { name: "a/x.txt", text: "x" }, { name: "b/y.txt", text: "y" }, { name: ".git/HEAD", text: "ref: refs/heads/main\n" },
      { name: "node_modules/m.js", text: "m" },
    ]);
    const site = [{ from: "", to: "site" }];
    const l = provisioner("list", { archive: zip, mapping: site });
    assert.deepEqual([l.parentFolder, l.missingCount, l.withoutTargetCount, l.files, l.omitted, l.gitFolder], [null, 0, 0, 4, 1, ["site"]], JSON.stringify(l));
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    provisioner("unpack", { archive: zip, staging: b, mapping: site });
    assert.deepEqual(tree(b), ["site/", "site/.git/", "site/.git/HEAD", "site/a/", "site/a/x.txt", "site/b/", "site/b/y.txt", "site/index.html"]);
    // The root left out, a folder below it explicitly kept: the longest prefix wins.
    const only = [{ from: "", to: null }, { from: "a", to: "a" }];
    const ln = provisioner("list", { archive: zip, mapping: only });
    assert.deepEqual([ln.missingCount, ln.withoutTargetCount, ln.files, ln.leftOut], [0, 0, 1, 3], JSON.stringify(ln));
    const b2 = path.join(dir, "b2");
    fs.mkdirSync(b2);
    provisioner("unpack", { archive: zip, staging: b2, mapping: only });
    assert.deepEqual(tree(b2), ["a/", "a/x.txt"]);
    // `missing` for the root: only if the archive carries nothing the server does not leave out anyway.
    const empty = buildZip(path.join(dir, "only-omitted.zip"), [{ name: "node_modules/m.js", text: "m" }, { name: ".DS_Store", text: "d" }]);
    const lf = provisioner("list", { archive: empty, mapping: site });
    assert.deepEqual([lf.missingCount, lf.missing], [1, [""]], JSON.stringify(lf));
  });
});

// Every call of os.replace, recorded: "fd" (through pinned folders, src_dir_fd AND dst_dir_fd) or "path".
const REPLACE_COUNTER = String.raw`import atexit, json, os
_real_replace = os.replace
_calls = []
def _replace(a, b, *, src_dir_fd=None, dst_dir_fd=None):
    _calls.append("fd" if src_dir_fd is not None and dst_dir_fd is not None else "path")
    return _real_replace(a, b, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
os.replace = _replace
atexit.register(lambda: open(os.environ["CBASE_TEST_REPLACE"], "w").write(json.dumps(_calls)))
`;
function provisionerReplace(mode, input, file) {
  const out = execFileSync("python3", ["-c", REPLACE_COUNTER + PROVISIONER, mode], {
    input: JSON.stringify({ omit: OUT, ...input }), encoding: "utf8", env: { ...process.env, CBASE_TEST_REPLACE: file },
  });
  return { r: JSON.parse(out.trim().split("\n").pop()), calls: JSON.parse(fs.readFileSync(file, "utf8")) };
}

test("(E20) every move through pinned folders (renameat): `os.replace` with src_dir_fd/dst_dir_fd in `unpack` and `place`, never through the path", () => {
  // The program used to ask `os.replace in os.supports_dir_fd` — CPython lists only "rename" there, so the question was false
  // everywhere, also in the container, and every move went through the path (dir_fd is required).
  withFolder((dir) => {
    const zip = buildZip(path.join(dir, "a.zip"), [{ name: "proj/a.txt", text: "a" }, { name: "proj/sub/b.txt", text: "b" }]);
    const b = path.join(dir, "w", ".cbase-source-1");
    fs.mkdirSync(b, { recursive: true });
    const e = provisionerReplace("unpack", { archive: zip, staging: b, mapping: [{ from: "proj", to: "proj" }] }, path.join(dir, "r-unpack"));
    assert.deepEqual([e.r.written, e.r.errorCount], [2, 0], JSON.stringify(e.r));
    assert.deepEqual(e.calls, ["fd", "fd"], "both files from the part name to the target name through the folder descriptors");
    // `proj/` already exists at the target: the files move singly (`replace_at`), `sub/` is missing there and moves as a whole.
    write(path.join(dir, "w", "proj", "here.txt"), "da");
    const s = provisionerReplace("place", { root: path.join(dir, "w"), staging: b, mode: "keep", references: true }, path.join(dir, "r-place"));
    assert.deepEqual([s.r.errorCount, s.r.rest], [0, false], JSON.stringify(s.r));
    assert.deepEqual(s.calls, ["fd", "fd"], JSON.stringify(s.calls));
    assert.deepEqual(tree(path.join(dir, "w")), ["proj/", "proj/a.txt", "proj/here.txt", "proj/sub/", "proj/sub/b.txt"]);
  });
});

// ── (R) The routes ────────────────────────────────────────────────────────────────────────────────────────────────

const source =(ctx, pid, seq, what, body) => requestData(setupRoute(ctx.base, pid, `sources/${seq}/${what}`), { method: "POST", body });
const chunk = (ctx, pid, body, { address = true } = {}) => requestData(
  `${ctx.base}/api/projects/${pid}/archive${address && typeof body?.archiveId === "string" ? `?archiveId=${encodeURIComponent(body.archiveId)}` : ""}`,
  { method: "POST", body },
);
const part = (data, from, until) => data.subarray(from, until).toString("base64");

// All chunks from `size` of `begin`, then `finished` -> the answer of `begin`.
async function performUpload(ctx, pid, seq, data, { step = 512 } = {}) {
  const b = await source(ctx, pid, seq, "begin", { bytes: data.length });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  for (let off = b.body.size; off < data.length;) {
    const r = await chunk(ctx, pid, { archiveId: b.body.archiveId, offset: off, dataB64: part(data, off, off + step) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    off = r.body.size;
  }
  const f = await source(ctx, pid, seq, "finished", { archiveId: b.body.archiveId, size: data.length });
  assert.equal(f.status, 202, JSON.stringify(f.body));
  return b.body;
}

// A chunk request to `…/archive` with an OPEN body (like openChunkRequest of setup-harness.mjs): returns once the server begins to
// read the body (diagnostics_channel) or has already answered. `archiveId` null: the address carries none.
async function openChunk(ctx, pid, archiveId) {
  const filePath = `/api/projects/${pid}/archive${archiveId ? `?archiveId=${encodeURIComponent(archiveId)}` : ""}`;
  let page = null;
  const consumer = ({ request, response }) => { if (request.url === filePath) page = { request, response }; };
  diagnostics.subscribe("http.server.request.start", consumer);
  const anf = http.request(`${ctx.base}${filePath}`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" } });
  const responseValue = new Promise((resolve, reject) => {
    anf.on("response", (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { t += c; });
      res.on("end", () => { let b; try { b = JSON.parse(t); } catch { b = t; } resolve({ status: res.statusCode, body: b }); });
    });
    anf.on("error", reject);
  });
  anf.write(" ");
  try {
    await waitForTruthy(() => page && (page.request.listenerCount("data") > 0 || page.response.writableEnded), "the server reads the body");
  } finally { diagnostics.unsubscribe("http.server.request.start", consumer); }
  return { end: (body) => { anf.end(JSON.stringify(body)); return responseValue; } };
}

const zipSource = (data, mapping, name = "proj.zip") => ({ kind: "zip", target: "", name, bytes: data.length, mapping });

test("(R0) without server mode: `…/archive` 404; validation of the POST for `zip` — mapping mandatory, `from`/`to` checked, TARGET_DUPLICATE", async () => {
  await withAgentsServer(async (ctx) => {
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID } });
    const prior = process.env.CBASE_DOCKER_BIN;
    try {
      process.env.CBASE_DOCKER_BIN = fd.bin;
      const r = await requestData(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: { name: "Old", path: path.join(ctx.root, "workspace", "old") } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const x = await chunk(ctx, r.body.id, { archiveId: crypto.randomUUID(), offset: 0, dataB64: "" });
      assert.equal(x.status, 404);
      assert.match(x.body.error, ONLY_IN_OPS_TEXT);
      assert.deepEqual(fd.calls(), [], "no docker without server mode");
    } finally {
      if (prior === undefined) delete process.env.CBASE_DOCKER_BIN; else process.env.CBASE_DOCKER_BIN = prior;
      fd.cleanUp();
    }
  });
  await withCreation(async ({ ctx }) => {
    const prior = store.listAllProjects().length;
    const post = (q) => requestData(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: { name: "Z", sources: [q] } });
    const base = { kind: "zip", target: "", name: "a.zip", bytes: 10 };
    for (const [q, code] of [
      [base, "MAPPING"], [{ ...base, mapping: [] }, "MAPPING"], [{ ...base, mapping: [{ from: "../x", to: "x" }] }, "MAPPING"],
      [{ ...base, mapping: [{ from: "a/", to: "a" }] }, "MAPPING"], [{ ...base, mapping: [{ from: "a", to: "/etc" }] }, "MAPPING"],
      [{ ...base, mapping: [{ from: "a", to: ".cbase-source-1" }] }, "MAPPING"], [{ ...base, mapping: [{ from: "a", to: "x" }, { from: "a", to: "y" }] }, "MAPPING"],
      [{ ...base, mapping: [{ from: "a", to: "x" }, { from: "b", to: "x" }] }, "TARGET_DUPLICATE"], [{ ...base, mapping: "a" }, "MAPPING"],
      // `from: ""` (the archive root) is valid — but like every `from` only once; a “.” part stays an error (clients send cleaned
      // names).
      [{ ...base, mapping: [{ from: "", to: "x" }, { from: "", to: "y" }] }, "MAPPING"], [{ ...base, mapping: [{ from: "./a", to: "a" }] }, "MAPPING"],
      [{ ...base, mapping: [{ from: null, to: "a" }] }, "MAPPING"],
    ]) {
      const r = await post(q);
      assert.equal(r.status, 400, JSON.stringify(q));
      assert.equal(r.body.code, code, `${JSON.stringify(q)}: ${JSON.stringify(r.body)}`);
    }
    assert.equal(store.listAllProjects().length, prior, "no project was created");
  });
});

test("(R1) archiveId idempotent per source, offset at the descriptor, foreign id; finished => unpacked, placed, archive gone; hint in the bell", async () => {
  await withCreation(async ({ ctx, reader }) => {
    const zip = buildZip(path.join(ctx.root, "zips", "proj.zip"), [
      { name: "proj/", kind: "folder" }, { name: "proj/a.txt", text: "hello" }, { name: "proj/sub/b.txt", text: "world ".repeat(200) },
      { name: "proj/l1", kind: "reference", target: "a.txt" }, { name: "proj/l2", kind: "reference", target: "../../etc" },
      { name: "__MACOSX/proj/._a.txt", text: "m" },
    ]);
    const data = fs.readFileSync(zip);
    const proj = await create(ctx, { name: "With zip", sources: [zipSource(data, [{ from: "proj", to: "proj" }])] });
    const pid = proj.id;
    assert.deepEqual(proj.setup.sources.map((q) => [q.seq, q.kind, q.state]), [[1, "zip", "wait-upload"]]);
    assert.deepEqual(store.sourceOf(pid, 1).mapping, [{ from: "proj", to: "proj" }]);
    await inSources(pid);

    const b1 = await source(ctx, pid, 1, "begin", { bytes: data.length });
    assert.equal(b1.status, 200, JSON.stringify(b1.body));
    assert.deepEqual(Object.keys(b1.body).sort(), ["archiveId", "operation", "size"]);
    assert.ok(isArchiveId(b1.body.archiveId));
    assert.equal(b1.body.size, 0);
    const id = b1.body.archiveId;
    const file = archivePath(pid, id);
    assert.equal(file, path.join(locationFor({ projectId: pid, converted: true }).setup, `archive-${id}.zip`));
    assert.equal(fs.statSync(file).size, 0, "the empty file lies in the runtime folder");
    assert.equal(store.projectArchive(id).state, "upload");

    const half = Math.floor(data.length / 2);
    const s1 = await chunk(ctx, pid, { archiveId: id, offset: 0, dataB64: part(data, 0, half) });
    assert.deepEqual([s1.status, s1.body], [200, { ok: true, size: half }]);
    // Idempotent: the same id, the same operation, `size` at the descriptor — resuming never starts at zero.
    const b2 = await source(ctx, pid, 1, "begin", { bytes: data.length });
    assert.deepEqual(b2.body, { operation: b1.body.operation, archiveId: id, size: half });
    const b2with = await source(ctx, pid, 1, "begin", { bytes: data.length, archiveId: id });
    assert.equal(b2with.body.archiveId, id);

    // Foreign, invalid, address != body.
    const foreign = await chunk(ctx, pid, { archiveId: crypto.randomUUID(), offset: half, dataB64: part(data, half) });
    assert.deepEqual([foreign.status, foreign.body.code], [409, "ARCHIVE_FOREIGN"]);
    const foreignBegin = await source(ctx, pid, 1, "begin", { bytes: data.length, archiveId: crypto.randomUUID() });
    assert.deepEqual([foreignBegin.status, foreignBegin.body.code], [409, "ARCHIVE_FOREIGN"]);
    const broken = await chunk(ctx, pid, { archiveId: "../x", offset: half, dataB64: "" }, { address: false });
    assert.deepEqual([broken.status, broken.body.code], [400, "ARCHIVE"]);
    const location = await requestData(`${ctx.base}/api/projects/${pid}/archive?archiveId=${id}`, { method: "POST", body: { archiveId: crypto.randomUUID(), offset: half, dataB64: "" } });
    assert.deepEqual([location.status, location.body.code], [400, "ARCHIVE_LOCATION"]);
    assert.equal(fs.statSync(file).size, half, "none of these requests wrote");

    // The offset rule at the DESCRIPTOR: if the file grows from outside, its size counts.
    fs.appendFileSync(file, "xyz");
    const o = await chunk(ctx, pid, { archiveId: id, offset: half, dataB64: part(data, half) });
    assert.deepEqual([o.status, o.body.code, o.body.size], [409, "OFFSET", half + 3]);
    assert.equal((await source(ctx, pid, 1, "begin", { bytes: data.length })).body.size, half + 3);
    // 0 replaces; beyond the announced `bytes` => CHUNK.
    const fresh = await chunk(ctx, pid, { archiveId: id, offset: 0, dataB64: part(data, 0, half) });
    assert.deepEqual([fresh.status, fresh.body.size], [200, half]);
    const tooMuch = await chunk(ctx, pid, { archiveId: id, offset: half, dataB64: Buffer.concat([data.subarray(half), Buffer.from("!")]).toString("base64") });
    assert.deepEqual([tooMuch.status, tooMuch.body.code], [400, "CHUNK"]);
    for (const body of [{ archiveId: id, dataB64: "" }, { archiveId: id, offset: -1, dataB64: "" }, { archiveId: id, offset: half }]) {
      const r = await chunk(ctx, pid, body);
      assert.deepEqual([r.status, r.body.code], [400, "CHUNK"], JSON.stringify(body));
    }
    const rest = await chunk(ctx, pid, { archiveId: id, offset: half, dataB64: part(data, half) }, { address: false });
    assert.deepEqual([rest.status, rest.body.size], [200, data.length]);

    // finished: complete means `size` == the size at the descriptor.
    const withoutId = await source(ctx, pid, 1, "finished", { size: data.length });
    assert.deepEqual([withoutId.status, withoutId.body.code], [400, "ARCHIVE"]);
    const wrong = await source(ctx, pid, 1, "finished", { archiveId: id, size: data.length + 1 });
    assert.deepEqual([wrong.status, wrong.body.code, wrong.body.size, wrong.body.expected], [409, "ARCHIVE_INCOMPLETE", data.length, data.length + 1]);
    const foreignFinished = await source(ctx, pid, 1, "finished", { archiveId: crypto.randomUUID(), size: data.length });
    assert.deepEqual([foreignFinished.status, foreignFinished.body.code], [409, "ARCHIVE_FOREIGN"]);
    const f = await source(ctx, pid, 1, "finished", { archiveId: id, size: data.length });
    assert.equal(f.status, 202, JSON.stringify(f.body));
    assert.equal(f.body.setup.sources[0].state, "unpack");
    const toward = await chunk(ctx, pid, { archiveId: id, offset: 0, dataB64: "" });
    assert.deepEqual([toward.status, toward.body.code], [409, "ARCHIVE_CLOSED"], "after finished the archive accepts nothing more");

    await setupFinished(pid);
    const w = proj.path;
    assert.equal(read(path.join(w, "proj", "a.txt")), "hello");
    assert.equal(read(path.join(w, "proj", "sub", "b.txt")), "world ".repeat(200));
    assert.equal(fs.readlinkSync(path.join(w, "proj", "l1")), "a.txt");
    assert.equal(fs.existsSync(path.join(w, "proj", "l2")), false, "link pointing out");
    assert.equal(fs.existsSync(path.join(w, "__MACOSX")), false, "__MACOSX");
    assert.equal(store.projectArchive(id), null, "the archive's row is gone");
    assert.equal(fs.existsSync(file), false, "the archive's file is gone");
    assert.equal(fs.existsSync(staging(proj, 1)), false, "the staging is placed");
    assert.deepEqual(store.projectUploadsOf(pid), []);
    await waitForTruthy(() => reader.events.some((e) => e.type === "notice" && e.notice?.projectId === pid
      && /nicht alles angelegt|not everything created/.test(e.notice.title) && /proj\/l2/.test(e.notice.body)), "link hint in the bell");
  });
});

test("(R2) second tab: an open chunk => 409 UPLOAD_RUNNING — with the operation in the address from the beginning, without it as “unsettled”", async () => {
  await withCreation(async ({ ctx }) => {
    const data = fs.readFileSync(buildZip(path.join(ctx.root, "zips", "a.zip"), [{ name: "proj/a.txt", text: "a" }]));
    const proj = await create(ctx, { name: "Two tabs", sources: [zipSource(data, [{ from: "proj", to: "proj" }])] });
    const pid = proj.id;
    await inSources(pid);
    const { archiveId: id } = (await source(ctx, pid, 1, "begin", { bytes: data.length })).body;

    const open = await openChunk(ctx, pid, id);
    const second = await chunk(ctx, pid, { archiveId: id, offset: 0, dataB64: part(data, 0, 5) });
    assert.deepEqual([second.status, second.body.code], [409, "UPLOAD_RUNNING"]);
    const secondWithout = await chunk(ctx, pid, { archiveId: id, offset: 0, dataB64: part(data, 0, 5) }, { address: false });
    assert.deepEqual([secondWithout.status, secondWithout.body.code], [409, "UPLOAD_RUNNING"], "also without an address: after the body");
    for (const [what, body] of [["begin", { bytes: data.length }], ["finished", { archiveId: id, size: 0 }], ["leaveOut", undefined]]) {
      const r = await source(ctx, pid, 1, what, body);
      assert.deepEqual([r.status, r.body.code], [409, "UPLOAD_RUNNING"], what);
    }
    const a = await active(ctx.base);
    assert.equal(a.uploadsActive, 1);
    assert.equal(a.busy, true, "an open chunk holds busy");
    const first = await open.end({ archiveId: id, offset: 0, dataB64: part(data, 0, 5) });
    assert.deepEqual([first.status, first.body.size], [200, 5], JSON.stringify(first.body));

    // Without an operation in the address: “unsettled” until the body — begin and finished wait anyway.
    const unresolved = await openChunk(ctx, pid, null);
    for (const [what, body] of [["begin", { bytes: data.length }], ["finished", { archiveId: id, size: 5 }]]) {
      const r = await source(ctx, pid, 1, what, body);
      assert.deepEqual([r.status, r.body.code], [409, "UPLOAD_RUNNING"], `unsettled: ${what}`);
    }
    const second2 = await unresolved.end({ archiveId: id, offset: 5, dataB64: part(data, 5) });
    assert.deepEqual([second2.status, second2.body.size], [200, data.length], JSON.stringify(second2.body));
    // The routes judge OPEN requests, never the upload quiet time (a clock): `finished` right after the last chunk works.
    const f = await source(ctx, pid, 1, "finished", { archiveId: id, size: data.length });
    assert.equal(f.status, 202, JSON.stringify(f.body));
    await setupFinished(pid);
    assert.equal(read(path.join(proj.path, "proj", "a.txt")), "a");
  });
});

test("(R3) PLAN_MATCHES_NOT => source error, nothing unpacked, archive error; “Again” unpacks AGAIN — the archive stays until “Continue without this source”", async () => {
  await withCreation(async ({ ctx }) => {
    const data = fs.readFileSync(buildZip(path.join(ctx.root, "zips", "a.zip"), [{ name: "proj/a.txt", text: "a" }]));
    const proj = await create(ctx, { name: "Does not fit", sources: [zipSource(data, [{ from: "proj", to: "proj" }, { from: "missing", to: "missing" }])] });
    const pid = proj.id;
    await inSources(pid);
    const { archiveId: old } = await performUpload(ctx, pid, 1, data);
    const e = await waitUntil(pid, (x) => x?.sources[0].state === "error", "source error");
    assert.equal(e.sources[0].code, "PLAN_MATCHES_NOT", e.sources[0].error);
    assert.match(e.sources[0].error, /missing/);
    assert.equal(e.state, "setUp", "the setup itself is not in error — it waits for the source");
    assert.equal(store.projectArchive(old).state, "error");
    assert.equal(fs.existsSync(path.join(proj.path, "proj")), false, "nothing unpacked and nothing placed");
    assert.deepEqual(fs.readdirSync(staging(proj, 1)), [], "not even into the staging");

    // “Again” runs the source anew from its state — the completely uploaded archive stays, nothing has to be uploaded again.
    const r = await requestData(setupRoute(ctx.base, pid, "again"), { method: "POST" });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.setup.sources[0].state, "unpack", "unpack again, do not upload again");
    const e2 = await waitUntil(pid, (x) => x?.sources[0].state === "error", "error again (the plan still does not fit)");
    assert.equal(e2.sources[0].code, "PLAN_MATCHES_NOT");
    assert.equal(store.sourceOf(pid, 1).archiveId, old, "the same id at the source");
    assert.equal(store.projectArchive(old)?.state, "error", "the row stayed");
    assert.equal(fs.statSync(archivePath(pid, old)).size, data.length, "the file stayed, complete");
    const b = await source(ctx, pid, 1, "begin", { bytes: data.length });
    assert.deepEqual([b.status, b.body.code], [409, "SOURCE_STATE"], "no new upload over an archive that is still there");
    // Only the explicit choice discards (leaveOut).
    const way = await source(ctx, pid, 1, "leaveOut");
    assert.equal(way.status, 202, JSON.stringify(way.body));
    assert.equal(store.projectArchive(old), null);
    assert.equal(fs.existsSync(archivePath(pid, old)), false);
    await setupFinished(pid);
  });
});

test("(R4) abort while unpacking => aborted, staging and archive stay; holds busy, RUNNING only for this source; “Again” unpacks anew", async () => {
  await withCreation(async ({ ctx, pyGates }) => {
    const data = fs.readFileSync(buildZip(path.join(ctx.root, "zips", "a.zip"), [{ name: "proj/a.txt", text: "a" }, { name: "proj/b.txt", text: "b" }]));
    const proj = await create(ctx, { name: "Abort", sources: [zipSource(data, [{ from: "proj", to: "proj" }]), { kind: "files", target: "", bytes: 2 }] });
    const pid = proj.id;
    await inSources(pid);
    pyHold(pyGates, "unpack");
    const { archiveId: id } = await performUpload(ctx, pid, 1, data);
    await pyWaiting(pyGates, "unpack");
    // At the gate: the provisioner stands before `unpack`, the staging is freshly created.
    assert.equal(store.sourceOf(pid, 1).state, "unpack");
    const a = await active(ctx.base);
    assert.equal(a.busy, true, "unpacking holds busy");
    assert.deepEqual(a.projectWork.filter((x) => x.projectId === pid).map((x) => [x.state, x.phase]), [["setUp", "unpack"]]);
    const second = await source(ctx, pid, 2, "begin", { bytes: 2 });
    assert.equal(second.status, 200, `another source does not wait for the unpacking: ${JSON.stringify(second.body)}`);
    const current = await source(ctx, pid, 1, "leaveOut");
    assert.deepEqual([current.status, current.body.code], [409, "RUNNING"]);
    write(path.join(staging(proj, 1), "marker.txt"), "m");

    const start = await source(ctx, pid, 1, "abort");
    assert.equal(start.status, 202, JSON.stringify(start.body));
    assert.equal(start.body.setup.sources[0].state, "aborted");
    await waitUntil(pid, (x) => x?.sources[0].state === "aborted", "aborted, no procedure any more");
    assert.equal(read(path.join(staging(proj, 1), "marker.txt")), "m", "the staging stays");
    assert.equal(store.projectArchive(id).state, "unpack", "the archive stays");
    assert.equal(fs.statSync(archivePath(pid, id)).size, data.length);

    const r = await requestData(setupRoute(ctx.base, pid, "again"), { method: "POST" });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await waitUntil(pid, (x) => x?.sources[0].state === "staged", "unpacked anew");
    assert.equal(store.projectArchive(id), null);
    write(path.join(staging(proj, 2), "c.txt"), "cc");
    const f2 = await source(ctx, pid, 2, "finished");
    assert.equal(f2.status, 202, JSON.stringify(f2.body));
    await setupFinished(pid);
    assert.equal(read(path.join(proj.path, "proj", "a.txt")), "a");
    assert.equal(read(path.join(proj.path, "c.txt")), "cc");
    assert.equal(fs.existsSync(path.join(proj.path, "marker.txt")), false, "the rest of the aborted run fell at the new unpacking");
  });
});

test("(R5) leaving out a ZIP source in wait-upload takes archive row and file along; the setup continues", async () => {
  await withCreation(async ({ ctx }) => {
    const data = fs.readFileSync(buildZip(path.join(ctx.root, "zips", "a.zip"), [{ name: "proj/a.txt", text: "a" }]));
    const proj = await create(ctx, { name: "LeaveOut", sources: [zipSource(data, [{ from: "proj", to: "proj" }])] });
    const pid = proj.id;
    await inSources(pid);
    const { archiveId: id } = (await source(ctx, pid, 1, "begin", { bytes: data.length })).body;
    assert.equal((await chunk(ctx, pid, { archiveId: id, offset: 0, dataB64: part(data, 0, 7) })).status, 200);
    const w = await source(ctx, pid, 1, "leaveOut");
    assert.equal(w.status, 202, JSON.stringify(w.body));
    assert.equal(store.projectArchive(id), null);
    assert.equal(fs.existsSync(archivePath(pid, id)), false);
    await setupFinished(pid);
    assert.equal(fs.existsSync(path.join(proj.path, "proj")), false);
  });
});

test("(R6) the archive's links arrive singly: in a folder an agent created in wait-upload, and in the root", async () => {
  await withCreation(async ({ ctx }) => {
    const data = fs.readFileSync(buildZip(path.join(ctx.root, "zips", "proj.zip"), [
      { name: "proj/", kind: "folder" }, { name: "proj/a.txt", text: "a" }, { name: "proj/show", kind: "reference", target: "a.txt" },
      { name: "proj/top", kind: "reference", target: "proj/a.txt" },
    ]));
    const proj = await create(ctx, { name: "Links", sources: [zipSource(data, [{ from: "proj", to: "proj" }, { from: "proj/top", to: "top" }])] });
    const pid = proj.id;
    await inSources(pid);
    write(path.join(proj.path, "proj", "from-agent.txt"), "agent"); // P1: chats run in wait-upload
    await performUpload(ctx, pid, 1, data);
    await setupFinished(pid);
    const w = proj.path;
    assert.equal(fs.readlinkSync(path.join(w, "proj", "show")), "a.txt", "in the existing folder");
    assert.equal(fs.readlinkSync(path.join(w, "top")), "proj/a.txt", "in the root");
    assert.equal(read(path.join(w, "proj", "a.txt")), "a");
    assert.equal(read(path.join(w, "proj", "from-agent.txt")), "agent");
    assert.equal(fs.existsSync(staging(proj, 1)), false, "nothing stayed in the staging");
  });
});

test("(R7) “Take over” in error (single error) and aborted: only with `takeOver: true`; the rest is placed, the archive falls", async () => {
  await withCreation(async ({ ctx, reader, pyGates }) => {
    const one = fs.readFileSync(buildZip(path.join(ctx.root, "zips", "one.zip"), [
      { name: "proj/a.txt", text: "a" }, { name: "proj/bomb", b64: Buffer.alloc(1 << 20).toString("base64"), lieSize: 16 },
      { name: "proj/out", kind: "reference", target: "../../etc" },
    ]));
    const two = fs.readFileSync(buildZip(path.join(ctx.root, "zips", "two.zip"), [{ name: "two/b.txt", text: "b" }]));
    const proj = await create(ctx, { name: "Take over", sources: [zipSource(one, [{ from: "proj", to: "proj" }]), zipSource(two, [{ from: "two", to: "two" }], "two.zip")] });
    const pid = proj.id;
    await inSources(pid);
    // Source 2: aborted before the provisioner unpacks; a rest lies in its staging (it stays).
    pyHold(pyGates, "unpack");
    const { archiveId: id2 } = await performUpload(ctx, pid, 2, two);
    await pyWaiting(pyGates, "unpack");
    write(path.join(staging(proj, 2), "two", "rest.txt"), "rest");
    assert.equal((await source(ctx, pid, 2, "abort")).status, 202);
    await waitUntil(pid, (x) => x?.sources[1].state === "aborted", "source 2 aborted");
    // Source 1: a single error (bomb) => error UNPACK, the rest lies in the staging, the archive stays.
    const { archiveId: id1 } = await performUpload(ctx, pid, 1, one);
    const e = await waitUntil(pid, (x) => x?.sources[0].state === "error", "source 1 error");
    assert.equal(e.sources[0].code, "UNPACK", e.sources[0].error);
    assert.match(e.sources[0].error, /proj\/bomb/);
    assert.equal(store.projectArchive(id1)?.state, "unpack", "a single error does not make the archive unusable");
    assert.equal(read(path.join(staging(proj, 1), "proj", "a.txt")), "a");
    // The hint goes out BEFORE the event “source error” (procedure.js unpackSource) — wait for the event, then judge: a sabotage
    // turns red, not hanging.
    await waitForTruthy(() => reader.events.some((x) => x.type === "project/setup" && x.projectId === pid && x.source?.seq === 1 && x.source.state === "error"),
      "event: source 1 error");
    assert.ok(reader.events.some((x) => x.type === "notice" && x.notice?.projectId === pid && /proj\/out/.test(x.notice.body)),
      "link hint in the bell also after single errors");

    // A missing field is no statement: `finished` without or with a wrong `takeOver` takes no half state.
    for (const [seq, body] of [[1, undefined], [1, { takeOver: "yes" }], [2, { archiveId: id2, size: two.length }]]) {
      const r = await source(ctx, pid, seq, "finished", body);
      assert.deepEqual([r.status, r.body.code], [409, "SOURCE_STATE"], `${seq} ${JSON.stringify(body)}`);
    }
    const u1 = await source(ctx, pid, 1, "finished", { takeOver: true });
    assert.equal(u1.status, 202, JSON.stringify(u1.body));
    assert.equal(u1.body.setup.sources[0].state, "staged");
    assert.equal(store.projectArchive(id1), null);
    assert.equal(fs.existsSync(archivePath(pid, id1)), false, "the archive's file fell with the choice");
    const u2 = await source(ctx, pid, 2, "finished", { takeOver: true });
    assert.equal(u2.status, 202, JSON.stringify(u2.body));
    assert.equal(store.projectArchive(id2), null);
    assert.equal(fs.existsSync(archivePath(pid, id2)), false);
    await setupFinished(pid);
    assert.equal(read(path.join(proj.path, "proj", "a.txt")), "a");
    assert.equal(fs.existsSync(path.join(proj.path, "proj", "bomb")), false);
    assert.equal(fs.existsSync(path.join(proj.path, "proj", "out")), false, "link pointing out");
    assert.equal(read(path.join(proj.path, "two", "rest.txt")), "rest", "the aborted source: with what was there");
  });
});

test("(R8) deleting project and workspace takes the archive FILE along, not only the row — also without purge", async () => {
  await withCreation(async ({ ctx }) => {
    const data = fs.readFileSync(buildZip(path.join(ctx.root, "zips", "a.zip"), [{ name: "proj/a.txt", text: "a" }]));
    const proj = await create(ctx, { name: "Away with archive", sources: [zipSource(data, [{ from: "proj", to: "proj" }])] });
    const pid = proj.id;
    await inSources(pid);
    const { archiveId: id } = (await source(ctx, pid, 1, "begin", { bytes: data.length })).body;
    assert.equal((await chunk(ctx, pid, { archiveId: id, offset: 0, dataB64: part(data, 0, 11) })).status, 200);
    const file = archivePath(pid, id);
    assert.equal(fs.statSync(file).size, 11);
    const d = await requestData(`${ctx.base}/api/projects/${pid}`, { method: "DELETE" });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(store.projectArchive(id), null);
    assert.ok(fs.existsSync(path.dirname(file)), "without purge the runtime folder stays — the file fell through the deletion route");
    assert.equal(fs.existsSync(file), false, "the archive file fell with the project");

    // The workspace route (like project-setup.test.js (21): a project without an instance row, row and file by hand).
    const wsPath = path.join(ctx.root, "ws-archive");
    fs.mkdirSync(wsPath);
    const ws = (await requestData(`${ctx.base}/api/workspaces`, { method: "POST", body: { name: "Archive", path: wsPath } })).body;
    const p2 = "p-with-archive";
    fs.mkdirSync(path.join(wsPath, "p"));
    store.addProject(ws.id, { id: p2, name: "With archive", path: path.join(wsPath, "p"), createdAt: Date.now() });
    store.createSetup({ projectId: p2, sources: [{ seq: 1, kind: "zip", target: "" }], codeRepos: [] });
    const id2 = crypto.randomUUID();
    store.createProjectArchive({ archiveId: id2, projectId: p2, operation: "", purpose: "creation" });
    write(archivePath(p2, id2), "archive");
    const dw = await requestData(`${ctx.base}/api/workspaces/${ws.id}`, { method: "DELETE" });
    assert.equal(dw.status, 200, JSON.stringify(dw.body));
    assert.equal(store.projectArchive(id2), null);
    assert.ok(fs.existsSync(path.dirname(archivePath(p2, id2))), "here too the runtime folder stays");
    assert.equal(fs.existsSync(archivePath(p2, id2)), false, "the archive file fell with the workspace");
  });
});

// ── Review findings 3–7 at the routes ───────────────────────────────────────────────────────────────────────────

test("(R9) abort in the middle of a file, then “Take over” => the half file is NOT in the project — nor a part name a KILL left behind", async () => {
  await withCreation(async ({ ctx, pyGates }) => {
    const data = fs.readFileSync(buildZip(path.join(ctx.root, "zips", "large.zip"), [{ name: "proj/aaa-large.bin", zeros: 3 << 20 }, { name: "proj/z.txt", text: "z" }]));
    const proj = await create(ctx, { name: "Half", sources: [zipSource(data, [{ from: "proj", to: "proj" }])] });
    const pid = proj.id;
    await inSources(pid);
    pyWriteHold(pyGates, "unpack");
    await performUpload(ctx, pid, 1, data);
    const py = await pyWriteWaiting(pyGates, "unpack");
    const b = staging(proj, 1);
    // In the middle of the first file (1 of 3 MiB): it is created under a part name, its target name is missing.
    assert.deepEqual(fs.readdirSync(path.join(b, "proj")).map((n) => PART_NAME.test(n)), [true], "under a part name");
    const start = await source(ctx, pid, 1, "abort");
    assert.equal(start.status, 202, JSON.stringify(start.body));
    await processGone(py, "the provisioner ended at the abort");
    await waitUntil(pid, (x) => x?.sources[0].state === "aborted", "aborted, no procedure any more");
    assert.deepEqual(tree(b), ["proj/"], "the abort left neither a part name nor a half target name");
    // As if a KILL had come (no finally): a part name in the staging — “Take over” does not put it into the project.
    write(path.join(b, "proj", `.cbase-part-${"0a".repeat(16)}`), "half");
    const u = await source(ctx, pid, 1, "finished", { takeOver: true });
    assert.equal(u.status, 202, JSON.stringify(u.body));
    await setupFinished(pid);
    assert.equal(fs.existsSync(path.join(proj.path, "proj", "aaa-large.bin")), false, "the half file is not in the project");
    assert.deepEqual(fs.readdirSync(path.join(proj.path, "proj")), [], "no part name either");
  });
});

test("(R10) while `leaveOut` waits for the deletion, the source is running (Again, finished, begin, leaveOut => 409 RUNNING); the closing row is conditional", async () => {
  await withCreation(async ({ ctx, fd }) => {
    fd.openGate("exec"); // open until the deletion; then the gate holds EVERY exec (the rest of the test needs none)
    const data = fs.readFileSync(buildZip(path.join(ctx.root, "zips", "a.zip"), [{ name: "proj/a.txt", text: "a" }]));
    const proj = await create(ctx, { name: "Leave out and again", sources: [
      zipSource(data, [{ from: "proj", to: "proj" }, { from: "missing", to: "missing" }]), zipSource(data, [{ from: "proj", to: "p2" }], "b.zip"),
    ] });
    const pid = proj.id;
    await inSources(pid);
    const { archiveId: old } = await performUpload(ctx, pid, 1, data);
    await waitUntil(pid, (x) => x?.sources[0].state === "error", "source 1 error (PLAN_MATCHES_NOT)");
    const { archiveId: id2, operation: v2 } = (await source(ctx, pid, 2, "begin", { bytes: data.length })).body;
    assert.equal((await chunk(ctx, pid, { archiveId: id2, offset: 0, dataB64: part(data, 0, 7) })).status, 200);

    // (a) Deleting the staging holds at the gate; “Again” and a second tab come in between.
    gateClosed(fd, "exec");
    const way = source(ctx, pid, 1, "leaveOut");
    await fd.gateReached("exec");
    await waitForTruthy(() => leaveOutRunning(pid, 1), "leaveOut waits for the deletion");
    const again = await requestData(setupRoute(ctx.base, pid, "again"), { method: "POST" });
    assert.deepEqual([again.status, again.body.code], [409, "RUNNING"], `Again: ${JSON.stringify(again.body)}`);
    for (const [what, body] of [["finished", { takeOver: true }], ["begin", { bytes: data.length }], ["leaveOut", undefined]]) {
      const r = await source(ctx, pid, 1, what, body);
      assert.deepEqual([r.status, r.body.code], [409, "RUNNING"], `${what}: ${JSON.stringify(r.body)}`);
    }
    assert.equal(store.sourceOf(pid, 1).state, "error", "nobody touched the source");
    fd.openGate("exec");
    const w = await way;
    assert.equal(w.status, 202, JSON.stringify(w.body));
    assert.equal(store.sourceOf(pid, 1).state, "leftOut");
    assert.equal(store.projectArchive(old), null, "the archive fell too");
    assert.equal(leaveOutRunning(pid), false, "the lock is gone");

    // (b) If a route the lock does not know changes the source after all, the closing row is not applicable: 409, archive and operation stay.
    gateClosed(fd, "exec");
    const way2 = source(ctx, pid, 2, "leaveOut");
    await fd.gateReached("exec");
    await waitForTruthy(() => leaveOutRunning(pid, 2), "leaveOut 2 waits for the deletion");
    store.changeSource(pid, 2, { state: "error", code: "UNPACK", error: "another route" });
    fd.openGate("exec");
    const w2 = await way2;
    assert.deepEqual([w2.status, w2.body.code], [409, "SOURCE_STATE"], JSON.stringify(w2.body));
    assert.equal(store.sourceOf(pid, 2).state, "error", "the state of the other route stays (no `process: \"\"` on top of it)");
    assert.equal(store.projectArchive(id2)?.archiveId, id2, "the archive's row stays");
    assert.equal(fs.statSync(archivePath(pid, id2)).size, 7, "with its file");
    assert.equal(store.projectUpload(v2)?.operation, v2, "the operation stays");
    assert.equal((await source(ctx, pid, 2, "leaveOut")).status, 202, "the explicit choice afterwards works");
    await setupFinished(pid);
  }, { fdOpts: { execGate: "exec" } });
});

test("(R11) archive identity — the view carries name/bytes; a different size => 409 ARCHIVE_DIFFERENT; `fresh: true` begins the same archive from the start, with `name`", async () => {
  await withCreation(async ({ ctx }) => {
    const old = fs.readFileSync(buildZip(path.join(ctx.root, "zips", "old.zip"), [{ name: "proj/old.txt", text: "old ".repeat(200) }]));
    const fresh = fs.readFileSync(buildZip(path.join(ctx.root, "zips", "new.zip"), [{ name: "proj/fresh.txt", text: "fresh" }]));
    assert.notEqual(old.length, fresh.length);
    const proj = await create(ctx, { name: "Identity", sources: [zipSource(old, [{ from: "proj", to: "proj" }], "old.zip"), { kind: "files", target: "", bytes: 1 }] });
    const pid = proj.id;
    const [q1, q2] = proj.setup.sources;
    assert.deepEqual([q1.name, q1.bytes], ["old.zip", old.length], "the view of a ZIP source: name and announced size");
    assert.deepEqual(["name" in q2, "bytes" in q2], [false, false], "only ZIP sources carry them");
    await inSources(pid);
    const b1 = (await source(ctx, pid, 1, "begin", { bytes: old.length })).body;
    const id = b1.archiveId;
    const half = Math.floor(old.length / 2);
    assert.equal((await chunk(ctx, pid, { archiveId: id, offset: 0, dataB64: part(old, 0, half) })).status, 200);

    // A different archive chosen (a different size): no appending of foreign bytes.
    const different = await source(ctx, pid, 1, "begin", { bytes: fresh.length });
    assert.deepEqual([different.status, different.body.code, different.body.bytes, different.body.size], [409, "ARCHIVE_DIFFERENT", old.length, half], JSON.stringify(different.body));
    assert.match(different.body.error, /größer oder kleiner|larger or smaller/);
    assert.equal(fs.statSync(archivePath(pid, id)).size, half, "the archive stayed");
    assert.equal(store.sourceOf(pid, 1).bytes, old.length, "`bytes` stayed");
    // `fresh` is a statement only with exactly true — without it `name` is ignored (also an invalid one).
    const yes = await source(ctx, pid, 1, "begin", { bytes: fresh.length, fresh: "yes", name: "a/b" });
    assert.deepEqual([yes.status, yes.body.code], [409, "ARCHIVE_DIFFERENT"], JSON.stringify(yes.body));
    // The same size: resume as before.
    assert.deepEqual((await source(ctx, pid, 1, "begin", { bytes: old.length })).body, { operation: b1.operation, archiveId: id, size: half });
    // `name` with `fresh`: not empty, at most 255 characters, without “/” and NUL.
    for (const name of ["", "a/b", "a\0b", "x".repeat(256), 7, null]) {
      const r = await source(ctx, pid, 1, "begin", { bytes: fresh.length, fresh: true, name });
      assert.deepEqual([r.status, r.body.code], [400, "NAME"], JSON.stringify(name));
    }
    assert.equal(fs.statSync(archivePath(pid, id)).size, half, "none of these requests cut");
    // Not under UPLOAD_RUNNING.
    const open = await openChunk(ctx, pid, id);
    const during = await source(ctx, pid, 1, "begin", { bytes: fresh.length, fresh: true, name: "new.zip" });
    assert.deepEqual([during.status, during.body.code], [409, "UPLOAD_RUNNING"]);
    assert.equal((await open.end({ archiveId: id, offset: half, dataB64: part(old, half, half + 10) })).status, 200);

    const n = await source(ctx, pid, 1, "begin", { bytes: fresh.length, fresh: true, name: "x".repeat(255) });
    assert.equal(n.status, 200, JSON.stringify(n.body));
    assert.deepEqual(n.body, { operation: b1.operation, archiveId: id, size: 0 }, "the same id, from the start");
    assert.equal(fs.statSync(archivePath(pid, id)).size, 0, "cut to 0 at the descriptor");
    const n2 = await source(ctx, pid, 1, "begin", { bytes: fresh.length, fresh: true, name: "new.zip" });
    assert.deepEqual([n2.status, n2.body.size], [200, 0]);
    const s = (await viewIn(ctx, pid)).setup.sources[0];
    assert.deepEqual([s.name, s.bytes], ["new.zip", fresh.length], "the view names the new archive");
    // Without `fresh` the name stays as it is (the archive is empty: there is nothing to protect).
    assert.equal((await source(ctx, pid, 1, "begin", { bytes: fresh.length, name: "foreign.zip" })).status, 200);
    assert.equal(store.sourceOf(pid, 1).name, "new.zip");

    await performUpload(ctx, pid, 1, fresh);
    await waitUntil(pid, (x) => x?.sources[0].state === "staged", "unpacked anew");
    assert.equal((await source(ctx, pid, 2, "leaveOut")).status, 202);
    await setupFinished(pid);
    assert.equal(read(path.join(proj.path, "proj", "fresh.txt")), "fresh");
    assert.equal(fs.existsSync(path.join(proj.path, "proj", "old.txt")), false, "nothing from the old archive");
  });
});

test("(R12) findings 3 and 7 at the server: a Finder ZIP (NFD) is placed in NFC and its code repo is created; a flat ZIP with `from: \"\"` lands under ONE target", async () => {
  await withCreation(async ({ ctx }) => {
    const nfd = (s) => s.normalize("NFD");
    const finder = fs.readFileSync(buildZip(path.join(ctx.root, "zips", "customers.zip"), [
      { name: nfd("Kunden/Projekt Müller/index.html"), text: "i" }, { name: nfd("Kunden/Projekt Müller/css/a.css"), text: "a" },
    ]));
    const flat = fs.readFileSync(buildZip(path.join(ctx.root, "zips", "site.zip"), [{ name: "index.html", text: "f" }, { name: "img/x.svg", text: "<svg/>" }]));
    const nfc = "Kunden/Projekt Müller".normalize("NFC");
    const proj = await create(ctx, {
      name: "Kunden", codeRepos: [nfc],
      sources: [zipSource(finder, [{ from: "Kunden", to: "Kunden" }], "customers.zip"), zipSource(flat, [{ from: "", to: "site" }], "site.zip")],
    });
    const pid = proj.id;
    await inSources(pid);
    await performUpload(ctx, pid, 1, finder);
    await performUpload(ctx, pid, 2, flat);
    await setupFinished(pid);
    const customers = path.join(proj.path, "Kunden");
    const names = fs.readdirSync(customers, { encoding: "buffer" });
    assert.deepEqual(names.map((x) => x.toString("hex")), [Buffer.from("Projekt Müller", "utf8").toString("hex")], "NFC bytes in the project");
    const repo = Buffer.concat([Buffer.from(`${customers}/`), names[0]]);
    assert.ok(fs.lstatSync(Buffer.concat([repo, Buffer.from("/.git")])).isDirectory(), "the plan's code repo was created");
    assert.equal(git(repo.toString(), "log", "--format=%s"), "Code repo created (cbase)");
    assert.equal(read(path.join(proj.path, "site", "index.html")), "f");
    assert.equal(read(path.join(proj.path, "site", "img", "x.svg")), "<svg/>");
  });
});

// ── (H) The post-start hook “project-archive” ────────────────────────────────────────────────────────────────────

test("(H) post-start “project-archive”: a source's archive in wait-upload and in error stays; only files without a row and rows without a project fall", async () => {
  await withCreation(async ({ ctx }) => {
    assert.match(fs.readFileSync(path.join(SERVER, "server.js"), "utf8"), /registerHook\("restartGrace", archiveRestartGrace, \{ name: "project-archive" \}\)/, "registered in server.js");
    const data = fs.readFileSync(buildZip(path.join(ctx.root, "zips", "a.zip"), [{ name: "proj/a.txt", text: "a" }]));
    const proj = await create(ctx, { name: "Post-start", sources: [zipSource(data, [{ from: "proj", to: "proj" }]), zipSource(data, [{ from: "proj", to: "p2" }], "b.zip")] });
    const pid = proj.id;
    await inSources(pid);
    const open = (await source(ctx, pid, 1, "begin", { bytes: data.length })).body.archiveId;
    assert.equal((await chunk(ctx, pid, { archiveId: open, offset: 0, dataB64: part(data, 0, 9) })).status, 200);
    const failed = (await source(ctx, pid, 2, "begin", { bytes: data.length })).body.archiveId;
    store.changeProjectArchive(failed, { state: "error" });
    store.changeSource(pid, 2, { state: "error", code: "PLAN_MATCHES_NOT", error: "x" });

    const empty = await create(ctx, { name: "Another one", sources: [] });
    await setupFinished(empty.id);
    const withoutRow = crypto.randomUUID();
    write(archivePath(pid, withoutRow), "orphaned");
    write(archivePath(empty.id, open), "under the name of a foreign archive");
    const goneId = crypto.randomUUID();
    store.createProjectArchive({ archiveId: goneId, projectId: "p-gone", operation: "", purpose: "creation" });
    write(archivePath("p-gone", goneId), "the project is gone");
    const foreignName = path.join(locationFor({ projectId: pid, converted: true }).setup, "note.txt");
    write(foreignName, "does not belong to cbase");

    assert.deepEqual(cleanArchive(), { files: 2, rows: 1 });
    assert.equal(store.projectArchive(open).state, "upload");
    assert.equal(fs.statSync(archivePath(pid, open)).size, 9, "the waiting source's archive stays (no deadline)");
    assert.equal(store.projectArchive(failed).state, "error");
    assert.ok(fs.existsSync(archivePath(pid, failed)), "the failed source's archive stays");
    assert.equal(fs.existsSync(archivePath(pid, withoutRow)), false, "the file without a row fell");
    assert.equal(fs.existsSync(archivePath(empty.id, open)), false, "the file under the id of another project's archive fell");
    assert.equal(store.projectArchive(goneId), null, "the row without a project fell");
    assert.equal(fs.existsSync(archivePath("p-gone", goneId)), false, "with its file");
    assert.equal(read(foreignName), "does not belong to cbase", "a foreign name stays");
    assert.deepEqual(cleanArchive(), { files: 0, rows: 0 }, "a second run finds nothing");
    for (const seq of [1, 2]) assert.equal((await source(ctx, pid, seq, "leaveOut")).status, 202);
    await setupFinished(pid);
  });
});
