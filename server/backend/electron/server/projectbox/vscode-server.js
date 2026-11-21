// `~/.vscode-server` per project: cleaning up old versions.
//
// WHY. VS Code (Dev Containers over the remote tunnel) attaches to the project container `cbase-p-<project>` and stores its
// server in `~/.vscode-server` — per version `bin/<40-hex-commit>/` (≈ 640 MB unpacked, ≈ 221 MB download). It used to live in the
// container's writable layer, and every recreate threw it away: the next open downloaded ≈ 8½ min through the tunnel relay from
// the Mac. Now the creation mounts `<runtime>/home/.vscode-server` into the container's home (creation.js rule
// `cli-vscode-server`) — the folder survives every recreate but grows by ≈ 640 MB with every VS Code version. This module removes
// the old ones. It changes nothing else.
//
// WHEN. After every transition of the MAIN instance to `ready` through the restore (restore.js `atReady`, registered in
// server.js): restart, recreate, git wake-up, start. Also after every PLACING of a version by the upfront fetch
// (vscode-upfront.js upfrontProject, in the same entry of its queue — otherwise a project would grow with every Microsoft version
// beyond the four below, since nobody cleans before the next `ready`). Never for a copy — it does not mount the folder
// (creation.js mountRulesCopy); its `~/.vscode-server` lies in its writable layer and goes with it.
//
// HOW, in two steps:
//   1. IN B, WITHOUT docker (causeInB): a look at `<cliHome>/.vscode-server/bin` through the descriptor in the area of the runtime
//      folder (runtime/real-path.js inFolderInArea — no link out). `.vscode-server` and `bin` must be real folders, NO link,
//      also none inside the runtime folder (the script would not follow it — B would count a different folder). Only names and
//      dirent type are read (`opendirSync`, a link is never followed), lstat only for the matching names, at most CAUSE_CAP
//      entries — at the cap "cause" applies (with a log line that it was the cap), the script in the container decides. At most
//      KEEP finished versions and no half-done one older than HALF_DONE_MIN ⇒ nothing to do, NO docker call (the usual case).
//      The reason for this step is also one of the tests: a callback at `atReady` that called docker on EVERY restore would run
//      uncounted beside the server (see the header of recreate.js).
//   2. IN THE PROJECT CONTAINER as agent (docker.js execIn — the pause barrier included, never an own `spawn("docker")`): the fixed
//      script CLEAN_UP_SCRIPT against `<home>/.vscode-server` (absolute: the target of the rule from creation.js exceptionTable
//      with the home the creation uses — recreate.js creationOptionsFor, os.homedir() in the product). It decides by itself, in the
//      namespace of the container (the VS Code processes run there, /proc shows them there; a link resolves there only inside the
//      project):
//        - nothing (`no-mount`) if `~/.vscode-server` is NOT a mount point there (field 5 of `/proc/self/mountinfo`, exact, encoded
//          like the kernel: `\040` etc.) — a container without the mount (created before it existed, recreate open or failed, after
//          a rollback) has the server in its writable layer, which it never touches. B then writes a note to the log instead of
//          the case coming back silently at every `ready`;
//        - nothing if `.vscode-server` or `bin` is missing or a link; nothing (`other-folder`) if the inode of `.vscode-server` is
//          not the one B saw;
//        - it touches only entries that are real folders (no link) and named exactly `<40 hex>` (finished version) or
//          `<40 hex>_<digits>` (half-done installation) — checked by `case` and length, never line by line (a name
//          `<40 hex>⏎foo` counted as a version with grep and killed a foreign folder `foo`);
//        - a half-done one only if older than HALF_DONE_MIN minutes (mtime) — a running installation stays;
//        - of the finished ones the KEEP youngest (mtime) stay;
//        - THE PROTECTED VERSIONS (at most TWO): (1) the current Microsoft version — the one the upfront fetch
//          (projectbox/vscode-upfront.js) last knew as "newest", persisted under NEWEST_KEY (app_settings) so that it survives a
//          restart —, and (2) the USED version — the one the Mac last worked with (the youngest trace `data/Machine/.devport-<commit>`
//          or `.connection-token-<commit>` over all converted main instances, at most USED_DAYS old; vscode-upfront.js usedVersion),
//          persisted under USED_KEY. No protected one is deleted, none counts toward KEEP. Reason for (1): the upfront fetch places Y
//          and Z while the Mac still uses X; "the two youngest by mtime" (= build time, see RESIDUAL RISK) would then keep Y and Z and
//          delete X — the opposite of the purpose. Reason for (2): the upfront fetch places the Mac's version in EVERY project;
//          without protection it would fall there as soon as two newer ones are present. Checked strictly: the script takes the list
//          as ONE argument, comma-separated, each member exactly 40 hex characters (B reads the values from the database,
//          protectedVersions, and the script checks them once more); an invalid value in the database is dropped in B, an invalid
//          member in the script is exit 2 without any change;
//        - nothing is deleted that a process of the container runs from: `/proc/<pid>/cmdline` or the target of `/proc/<pid>/exe`
//          contains `/.vscode-server/bin/<name>/`. The process list is read ONCE at the start (a search per candidate would see its
//          own `grep`, whose command line carries the pattern — "running" would then always be true).
//      Output per entry one line `removed <name>` or `running <name>`; a failed `rm` goes to stderr, exit 1.
//
// NEVER THE WRONG ONE (also not in a test). The fake docker of the tests runs `docker exec` LOCALLY; a test that cleans up without
//   `home` would give the script the developer's real `~/.vscode-server`. The protection is carried by the SCRIPT itself, not by an
//   agreement of the tests: it cleans only a folder that (a) is a mount point and (b) has the same inode as the source B just
//   looked at. On the Mac there is no /proc (so never a mount point), on Linux the own `~/.vscode-server` is usually none — and even
//   if (a dev container with a volume for it), its inode is not that of the source in the test's runtime folder. Rejected: "a target
//   only under the creation's home" — without a value the creation's home IS os.homedir(), in a test exactly the developer's home;
//   "tests must set HOME" — a rule the next test forgets. In the product the script runs only in the project container, it never
//   sees B's own `~/.vscode-server`.
// NEVER FATAL. cleanUpVscodeServer never throws: every error (docker, cap, exit of the script, an unreadable folder) goes to the log
//   as `console.warn` with the project id, and no restore waits for it (`atReady` runs after the transition, asynchronously). At
//   most one clean-up per project at a time (`running-already`).
// CAP. CLEAN_UP_CAP_MS per call — ESTIMATED, not measured: an `rm -rf` of two versions of 640 MB takes a few seconds, the cap is
//   ten times that and more. When reached, the message of docker.js says that it was a cap (and that the command may continue in the
//   container — a killed `docker exec` does not end it); it stands in the warning. The output is capped at OUTPUT_CAP_BYTES (docker.js
//   `maxBytes`), the look in B at CAUSE_CAP entries (see step 1).
// RESIDUAL RISK (named).
//   - "Running from it" rarely applies: cleaning happens right after a start, when usually no VS Code server runs yet. The real
//     protection is therefore "the two youngest by mtime" — and mtime is not the last use (but, see the next point, the build time).
//     A version that a second Mac with an older VS Code uses falls after two newer installations and is uploaded again at the next
//     attach (≈ 8 min). A reliable sign of last use in the version folder is not documented — so none was guessed.
//   - mtime is in practice the BUILD time of the version (`bin/<commit>` carries the time of the top level in Microsoft's tarball —
//     tar sets it on unpacking; the upfront fetch sets the same), so the order of the "youngest" is that of the versions, not of the
//     installations.
//   - A Mac that is THREE or more versions behind Microsoft lost its version — the protected one and the two youngest others were then
//     all newer. The used-version protection covers it as long as it opened a project in VS Code within the last USED_DAYS (14) days;
//     a Mac that used a version and then not for longer than 14 days loses the protection (the next run after 14 days deletes the
//     value) and uploads again at the next attach (≈ 8 min). Two Macs with different versions: only the LATEST used one is protected.
//     A value the upfront fetch never wrote (Microsoft never reached, never a trace) protects nothing. Likewise as soon as the upfront
//     fetch is SWITCHED OFF (`CBASE_VSCODE_UPFRONT_MS=0`): the last written values stay in app_settings but then protect nothing —
//     otherwise the last versions would stay undeletable forever although nobody renews them.
//   - Cost: up to FOUR finished versions per project (two protected and the two youngest others), ≈ 640 MB each — held after every
//     `ready` and after every placing by the upfront fetch (WHEN). What Dev Containers itself places (a Mac attaches another version)
//     is cleaned only by the next `ready` or placing. If the upfront fetch adds a just-placed version that is not (yet) saved
//     (`protectedAlongside` — saving failed), there are three protected ones for this run.
//   - The process list is read ONCE: a server that starts from an old version between reading and `rm` loses it.
//   - If the container ends IN THE MIDDLE of an `rm -rf`, a half-emptied OLD version folder with a fresh mtime stays — it then counts
//     among the youngest until two newer versions come (space, not an error: the version was meant to be deleted).
//
// Test seams as options of cleanUpVscodeServer: `home` (the creation's home), `proc` (the root the script reads instead of /proc —
// processes and `self/mountinfo`), `capMs`, `now`, `protectedAlongside` (no test path: the way of the upfront fetch after placing);
// causeInB takes `cap` and `shielded` (the protected versions as a LIST — cleanUpVscodeServer reads them itself, protectedVersions();
// a test sets the values in the database); plus `runningCleanUp(projectId)` (the running promise — the proof that the consumer at
// `atReady` ran). Guards: server/backend/test/projectbox-vscode-server.test.js (the script with a real `sh` against a temp folder,
// the path through the fake docker, the consumer in server.js); the rule itself: server/backend/test/projectbox-creation.test.js.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { locationFor } from "../runs/runtime-location.js";
import { areaInRuntimeFolder } from "../runs/runtime-write.js";
import { serverEnds } from "../runs/server-end.js";
import { inFolderInArea } from "../runtime/real-path.js";
import * as store from "../store.js";
import { MAIN, exceptionTable, containerName, isCopy } from "./creation.js";
import { projectboxOps } from "./ops.js";
import { execIn } from "./docker.js";
import { creationOptionsFor } from "./recreate.js";

/** The rule of the exception table (creation.js) whose target is cleaned up. */
export const RULE = "cli-vscode-server";
/** How many finished versions stay (the youngest by mtime). */
export const KEEP = 2;
/** From which age (minutes, mtime) a half-done installation counts as abandoned. */
export const HALF_DONE_MIN = 60;
/** The cap of the `docker exec` (see header, "CAP") — estimated, not measured. */
export const CLEAN_UP_CAP_MS = 120_000;
/** The cap of the script output: one line per entry, far below. */
export const OUTPUT_CAP_BYTES = 64 * 1024;
/** The name of a finished version (`bin/<commit>`, exactly 40 characters of 0-9a-f) and of a half-done one (`bin/<commit>_<digits>`).
 *  In the script not by grep (line by line: `<40 hex>⏎foo` counted as a version) but by `case` and length. */
const FINISHED = /^[0-9a-f]{40}$/;
const HALF_DONE = /^[0-9a-f]{40}_[0-9]+$/;
/** The cap of the look in B (causeInB): at most this many entries of `bin/` — above it "cause" applies, the script decides. */
export const CAUSE_CAP = 1000;

/** The key in app_settings under which the upfront fetch (vscode-upfront.js) stores the last known NEWEST version from Microsoft —
 *  the protected version of the clean-up (see header). Defined here because this module reads it and vscode-upfront.js imports this
 *  one (never the other way — no cycle). */
export const NEWEST_KEY = "projectbox.vscode_server_newest";
/** The key in app_settings under which the upfront fetch (vscode-upfront.js usedVersion) stores the USED version — the one the Mac
 *  last worked with (header); empty if there was no trace in the last 14 days. Defined here for the same reason as NEWEST_KEY. */
export const USED_KEY = "projectbox.vscode_server_used";

/** The value under `key` in app_settings if it is exactly 40 hex characters — otherwise (nothing stored, invalid, database
 *  unreadable) `null`. Never throws. No look at the knob — protectedVersions does that. */
export function savedVersion(key) {
  try {
    const v = String(store.getSetting(key, "") || "");
    return FINISHED.test(v) ? v : null;
  } catch { return null; }
}

/** The protected versions (header): the newest (NEWEST_KEY) and the used one (USED_KEY), each only if it is exactly 40 hex
 *  characters, without duplicates (the Mac often works with the newest) — so at most two, in this order. If the upfront fetch is
 *  switched off, `[]` (the clean-up then protects nothing). Never throws. "Switched off" reads the knob here itself
 *  (vscode-upfront.js upfrontTickMs: `0` means off, empty or missing means default) — an import from there would be a cycle. */
export function protectedVersions() {
  const slider = process.env.CBASE_VSCODE_UPFRONT_MS;
  if (slider !== undefined && slider !== "" && Number(slider) === 0) return []; // the same reading as upfrontTickMs
  const out = [];
  for (const k of [NEWEST_KEY, USED_KEY]) {
    const v = savedVersion(k);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** The list of protected versions as a set — only a LIST is allowed. A value that is not a list throws: a caller that still passes
 *  the old single value should fail loudly (the caller catches it — nothing is deleted then) instead of its protection silently
 *  dropping and the clean-up deleting more. */
export function protectionSet(shielded) {
  if (!Array.isArray(shielded)) throw new TypeError(`shielded is not a list: ${JSON.stringify(shielded)?.slice(0, 80)}`);
  return new Set(shielded.map(String));
}

/** The stored protected versions together with those a caller protects IN ADDITION (the upfront fetch after placing: the versions it
 *  just placed — even if saving in app_settings failed). `alongside` is a LIST (protectionSet), each member exactly 40 hex
 *  characters — otherwise a throw (the caller catches it, nothing is deleted; never silently one member less, never exit 2 in the
 *  script). Without duplicates, the stored ones first. The knob (switched off ⇒ no stored ones) acts only on the stored ones: whoever
 *  passes `alongside` is just placing, so is not switched off. */
export function protectedWith(saved, alongside) {
  protectionSet(alongside);
  const out = [...saved];
  for (const v of alongside) {
    if (!FINISHED.test(String(v))) throw new TypeError(`protected version is not a commit of 40 hex characters: ${JSON.stringify(v)?.slice(0, 80)}`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * The script (see header, step 2). Arguments: $1 `<home>/.vscode-server` (absolute), $2 KEEP, $3 HALF_DONE_MIN, $4 the root of
 * /proc (processes and `self/mountinfo`), $5 the inode B saw at the source, $6 the protected versions as a list, comma-separated —
 * empty allowed, otherwise each member exactly 40 hex characters (an empty member, `a,` or `,a`, is invalid: exit 2 without a
 * change); if $6 is missing it counts as empty. POSIX sh with tr, readlink, grep, cut, sed (coreutils, grep, sed), find (`-mmin`,
 * findutils), ls (`-t`), rm — all in the `basis` stage of both images (Debian bookworm). No values in the text: paths and numbers
 * come as arguments, the text is fixed. Output per line `removed <name>`, `running <name>` or ONCE `no-mount` or `other-folder` (then
 * without any change).
 */
export const CLEAN_UP_SCRIPT = [
  "set -u",
  "LC_ALL=C; export LC_ALL",
  "vs=$1; keep=$2; minutes=$3; proc=$4; ino=$5; protect_list=${6:-}",
  // Only if `$vs` is a MOUNT POINT here (field 5 of mountinfo, exact, encoded like the kernel): a container without the mount (created
  // before it existed, recreate open or failed, after a rollback) has `~/.vscode-server` in its writable layer — this script never
  // cleans that. A line break in the path is never a mount point of this rule.
  "nl='",
  "'",
  "case $vs in *\"$nl\"*) echo no-mount; exit 0;; esac",
  "encoded_mount=$(printf '%s\\n' \"$vs\" | sed -e 's/\\\\/\\\\134/g' -e 's/ /\\\\040/g' -e 's/\t/\\\\011/g')",
  "cut -d ' ' -f 5 \"$proc/self/mountinfo\" 2>/dev/null | grep -qxF -- \"$encoded_mount\" || { echo no-mount; exit 0; }",
  "[ -d \"$vs\" ] && [ ! -L \"$vs\" ] || exit 0",
  // The same folder B looked at (causeInB): the same inode — otherwise nothing (header, "NEVER THE WRONG ONE").
  "set -- $(ls -di -- \"$vs\" 2>/dev/null)",
  "[ \"${1:-}\" = \"$ino\" ] || { echo other-folder; exit 0; }",
  "b=$vs/bin",
  "[ -d \"$b\" ] && [ ! -L \"$b\" ] || exit 0",
  // The names by `case` and length, never line by line (grep): exactly 40 characters of 0-9a-f, or that, `_` and only digits.
  "hex40() { case $1 in ''|*[!0-9a-f]*) return 1;; esac; [ \"${#1}\" -eq 40 ]; }",
  "half() { c=${1%%_*}; z=${1#*_}; [ \"$c\" != \"$1\" ] || return 1; hex40 \"$c\" || return 1; case $z in ''|*[!0-9]*) return 1;; esac; return 0; }",
  // The protected versions — empty or a comma list, each member exactly 40 hex characters, otherwise touch nothing (exit 2). Member by
  // member from the front: `${rest%%,*}` is the first, `${rest#*,}` the rest (strictly shorter each time — the loop ends).
  "if [ -n \"$protect_list\" ]; then",
  "  rest=$protect_list",
  "  while :; do",
  "    g=${rest%%,*}",
  "    if ! hex40 \"$g\"; then echo \"protected version invalid\" >&2; exit 2; fi",
  "    [ \"$g\" = \"$rest\" ] && break",
  "    rest=${rest#*,}",
  "  done",
  "fi",
  // Whether a (checked, never empty) name is in the list — with a comma on both sides, so whole members only.
  "shielded() { case \",$protect_list,\" in *\",$1,\"*) return 0;; esac; return 1; }",
  // The processes ONCE, before any grep with a name (header): command lines (NUL → space) and targets of exe.
  "procs=$(for d in \"$proc\"/[0-9]*; do [ -d \"$d\" ] || continue; tr \"\\000\" \" \" < \"$d/cmdline\"; echo; readlink \"$d/exe\"; done 2>/dev/null)",
  "running() { printf \"%s\\n\" \"$procs\" | grep -qF \"/.vscode-server/bin/$1/\"; }",
  "status=0",
  "removed() {",
  "  if running \"$1\"; then echo \"running $1\"; return 0; fi",
  "  if rm -rf -- \"$b/$1\"; then echo \"removed $1\"; else echo \"rm failed: $1\" >&2; status=1; fi",
  "}",
  "finished_list=",
  "for e in \"$b\"/*; do",
  "  [ -d \"$e\" ] && [ ! -L \"$e\" ] || continue",
  "  n=${e##*/}",
  "  if hex40 \"$n\"; then finished_list=\"$finished_list $n\"",
  "  elif half \"$n\"; then",
  "    if [ -n \"$(find \"$e\" -prune -mmin +\"$minutes\" 2>/dev/null)\" ]; then removed \"$n\"; fi",
  "  fi",
  "done",
  // The finished ones, youngest first (mtime); the names are checked (exactly 40 hex characters) and therefore go unquoted to ls.
  "if [ -n \"$finished_list\" ]; then",
  "  i=0",
  "  for n in $(cd \"$b\" && ls -dt -- $finished_list); do",
  // A protected version always stays and does not count toward KEEP.
  "    if shielded \"$n\"; then continue; fi",
  "    i=$((i + 1))",
  "    if [ \"$i\" -le \"$keep\" ]; then continue; fi",
  "    removed \"$n\"",
  "  done",
  "fi",
  "exit \"$status\"",
].join("\n");

/** Source (in B, in the CLI home of the project) and target (in the container, `<home>/.vscode-server`) — from the ONE exception table. */
export function vscodeServerLocations(projectId, { home = os.homedir() } = {}) {
  const cliHome = locationFor({ projectId, converted: true }).home;
  const row = exceptionTable({ home, cliHome }).find((a) => a.rule === RULE);
  if (!row) throw new Error(`vscode-server.js: the rule ${RULE} is missing in creation.js exceptionTable`);
  return { source: row.source, target: row.target };
}

/**
 * Step 1 (header): whether a call in the container is worthwhile — from names, dirent type and (for the few matching names) lstat of
 * `<source>/bin`, through the descriptor in the area of the runtime folder. → `{ cause, finished, halfDoneOld, ino?, cap?, reason? }`.
 * No cause (with a reason): no runtime folder, `.vscode-server` or `bin` missing, not a folder, or a LINK — also one that stays inside
 * the runtime folder (the script in the container follows no link, B would otherwise count a different folder than the one it cleans
 * there), a way out. `ino` is the inode of `.vscode-server` — the script cleans only if it sees THE SAME in the container. At the cap
 * (`cap` entries, default CAUSE_CAP) "cause" applies with `cap: true`: B reads no further (a project that fills `bin/` with millions
 * of entries would otherwise hold B up at every `ready`), the script in the container decides. `shielded` (a LIST — protectionSet, a
 * single value throws): the protected versions — they count in `finished` but not toward the cause (they always stay, see header):
 * a cause exists only if WITHOUT them there are more than KEEP finished ones.
 */
export function causeInB(source, { now = Date.now(), cap = CAUSE_CAP, shielded = [] } = {}) {
  const protection = protectionSet(shielded);
  const empty = { cause: false, finished: 0, halfDoneOld: 0 };
  const bin = path.join(source, "bin");
  const area = areaInRuntimeFolder(bin);
  if (!area) return { ...empty, reason: "no runtime folder" };
  let finished = 0;
  let protectedPresent = 0;
  let halfDoneOld = 0;
  let ino = null;
  try {
    // lstat through the pinned parent folder: `.vscode-server`, then `bin` — each a real folder, no link.
    for (const [folder, name] of [[path.dirname(source), path.basename(source)], [source, "bin"]]) {
      const st = inFolderInArea(folder, area, ({ at }) => fs.lstatSync(at(name), { bigint: true }));
      if (st.isSymbolicLink()) return { ...empty, reason: `symbolic link: ${path.join(folder, name)}` };
      if (!st.isDirectory()) return { ...empty, reason: `not a folder: ${path.join(folder, name)}` };
      if (ino === null) ino = String(st.ino); // exact (BigInt), as text — that is how it goes to the script
    }
    const atCap = inFolderInArea(bin, area, ({ at }) => {
      const dir = fs.opendirSync(at(""));
      try {
        let seen = 0;
        for (let d = dir.readSync(); d; d = dir.readSync()) {
          if (++seen > cap) return true;
          if (d.isSymbolicLink()) continue; // never follow a link
          const isFinished = FINISHED.test(d.name);
          if (!isFinished && !HALF_DONE.test(d.name)) continue;
          let st;
          try { st = fs.lstatSync(at(d.name)); } catch { continue; }
          if (!st.isDirectory()) continue;
          if (isFinished) { finished += 1; if (protection.has(d.name)) protectedPresent += 1; }
          else if (now - st.mtimeMs > HALF_DONE_MIN * 60_000) halfDoneOld += 1;
        }
        return false;
      } finally { dir.closeSync(); }
    });
    if (atCap) {
      return { cause: true, finished, halfDoneOld, ino, cap: true, reason: `cap of ${cap} entries in ${bin} reached — B reads no further, the script in the container decides` };
    }
  } catch (e) {
    return { ...empty, reason: e?.code || e?.message || String(e) };
  }
  return { cause: finished - protectedPresent > KEEP || halfDoneOld > 0, finished, halfDoneOld, ino };
}

/** The lines of the script: `removed <name>`, `running <name>`; `no-mount` or `other-folder` (then it touched nothing). */
export function readOutput(text) {
  const removed = [];
  const running = [];
  let nothingTouched = null;
  for (const z of String(text || "").split("\n")) {
    const t = z.trim();
    if (t === "no-mount" || t === "other-folder") { nothingTouched = t; continue; }
    const m = /^(removed|running) (\S+)$/.exec(t);
    if (m) (m[1] === "removed" ? removed : running).push(m[2]);
  }
  return { removed, running, nothingTouched };
}

const running = new Map(); // project id → the running clean-up (its promise, which is never discarded)

/** Test seam: the clean-up currently running for a project (promise of the result) or `null` — a test checks the consumer at `atReady`
 *  (server.js) without a clock: after the tick in which atReady calls, there MUST be one. */
export const runningCleanUp = (projectId) => running.get(String(projectId)) ?? null;

/**
 * Cleans up the old VS Code server versions in the project container of the MAIN instance (header). Never throws; at most one per
 * project at a time (a second call gets `running-already`). `home` default: the home the creation of this project computes with
 * (recreate.js creationOptionsFor — `{}` in the product, so os.homedir()). `protectedAlongside`: versions the caller protects in
 * addition to the stored ones (protectedWith; vscode-upfront.js after placing).
 * @returns {Promise<{ status: "copy"|"no-ops"|"serverEnd"|"running-already"|"nothing"|"no-mount"|"other-folder"|"ok"|"error", removed?, running?, reason? }>}
 */
export function cleanUpVscodeServer(projectId, opts = {}) {
  const pid = String(projectId);
  if (running.has(pid)) return Promise.resolve({ status: "running-already" });
  const run = cleanUp(pid, opts).finally(() => running.delete(pid));
  running.set(pid, run);
  return run;
}

// The body: synchronous up to `execIn` (the options and the home of the creation are read at the call).
async function cleanUp(pid, { instance = MAIN, home, proc = "/proc", capMs = CLEAN_UP_CAP_MS, now, protectedAlongside = [] } = {}) {
  try {
    if (isCopy(instance)) return { status: "copy" };
    if (!projectboxOps()) return { status: "no-ops" };
    if (serverEnds()) return { status: "serverEnd" };
    const { source, target } = vscodeServerLocations(pid, { home: home ?? creationOptionsFor(pid).home ?? os.homedir() });
    // The protected versions (header) — read once, the same for the look in B and the script; plus those of the caller
    // (`protectedAlongside`; an invalid member throws, then nothing is deleted).
    const protection = protectedWith(protectedVersions(), protectedAlongside);
    const look = causeInB(source, { ...(now === undefined ? {} : { now }), shielded: protection });
    if (!look.cause) return { status: "nothing", ...look };
    if (look.cap) console.log(`[projectbox] VS Code server ${pid}: ${look.reason}`);
    const command = ["sh", "-c", CLEAN_UP_SCRIPT, "cbase-vscode-clean-up", target, String(KEEP), String(HALF_DONE_MIN), proc, String(look.ino), protection.join(",")];
    const r = await execIn(containerName(pid, MAIN), command, { capMs, maxBytes: OUTPUT_CAP_BYTES });
    const { removed, running, nothingTouched } = readOutput(r.stdout);
    if (nothingTouched === "no-mount") {
      console.warn(`[projectbox] VS Code server ${pid}: note — ${target} is not a mount point in the project container (created before the mount existed, recreate open or failed, after a rollback); nothing cleaned up, the writable layer stays untouched`);
      return { status: "no-mount" };
    }
    if (nothingTouched === "other-folder") {
      console.warn(`[projectbox] VS Code server ${pid}: note — ${target} is a different folder in the project container than ${source} in B (inode); nothing cleaned up`);
      return { status: "other-folder" };
    }
    if (removed.length) console.log(`[projectbox] VS Code server ${pid}: ${removed.length} old version(s) removed (${removed.join(", ")})${running.length ? `; ${running.length} stays because a process runs from it` : ""}`);
    return { status: "ok", removed, running };
  } catch (e) {
    const reason = e?.message || String(e);
    console.warn(`[projectbox] VS Code server ${pid}: cleaning up old versions failed — ${reason}${e?.code === "CAP" ? ` (cap ${capMs} ms, estimated)` : ""}`);
    return { status: "error", reason };
  }
}
