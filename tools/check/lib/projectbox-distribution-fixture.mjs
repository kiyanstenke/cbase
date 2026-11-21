// Test fixture shared by projectbox-distribution.test.mjs (public: the scripts and plans against the fake docker) and
// the maintainer's private suite (the flow over ssh, the targets, the rollback). Fake ssh/docker/timeout/curl, the
// answers of the entrypoint, `build` (a host with candidates and user containers) — no deploy configuration here: the private half sets it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fakeDocker } from "../../../server/backend/test/fake-docker.mjs";
import { LFS_HELPER_IN_BACKEND, SOURCE_LABEL } from "./projectbox.mjs";
import { STATUS_FILE, PROBE_LABEL } from "./projectbox-scripts.mjs";

export const DEPLOY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = path.resolve(DEPLOY, "..", "..");
export const ORIG_PATH = process.env.PATH;
export const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-pb-distribution-"));
export const BIN = path.join(ROOT, "bin");
export const REMOTE = path.join(ROOT, "remote");
export const RUNS = path.join(ROOT, "runs.json"); // answer of /api/runs/active; if the file is missing, curl fails (B "not reachable")
// The answers carry `converted: 0`, `relocationsOpen: 0`, `copies: 0` and `episodesMultiple: 0` (`build` sets the latter as a
// default), `layoutsOpen: 0`, `projectStopped: 0` and `projectWork: []` —
// without one of the fields the number is "unknown", and the rollback lock (lib/capabilities.mjs) would stop every rollback to a
// release without capabilities.json. The axes of the lock are checked by the maintainer's private suite, not
// by this file.
export const TIMEOUT_LOG = path.join(ROOT, "timeout.log");
export const PATH = `${BIN}:/usr/bin:/bin`;
// The state BEFORE the seam and probe fixes — fixed, not HEAD: after the commit the counter-test would check itself.
export const BEFORE_R1 = "17bb7a6";
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
fs.mkdirSync(BIN, { recursive: true });
const write = (name, text) => fs.writeFileSync(path.join(BIN, name), text, { mode: 0o755 });
write("ssh", '#!/bin/bash\nwhile [ $# -gt 0 ] && [ "$1" != "bash" ]; do shift; done\nshift\nexec bash "$@"\n');
// The fake docker changes per test (fakeDocker creates a new folder); this fixed entry points at the current one. If the pointer
// file is missing, the call fails — it never falls through to a real docker. In front: the mark "only-with-cap" (a docker exec
// without the fake timeout before it fails at once instead of hanging at the gate) and the disruptions of the test.
write("docker", [
  "#!/bin/bash",
  `target=$(cat '${BIN}/docker.target') || exit 125`,
  `if [ -e '${BIN}/only-with-cap' ] && [ "$1" = exec ] && [ -z "\${FAKE_TIMEOUT:-}" ]; then echo "wrong docker: docker exec without a cap: $*" >&2; exit 97; fi`,
  `if [ -f '${BIN}/docker.disruptions' ]; then . '${BIN}/docker.disruptions'; fi`,
  'exec "$target" "$@"',
  "",
].join("\n"));
// The fake GNU timeout: no clock. Without the mark "cap-observe" it only executes (with FAKE_TIMEOUT=1 for the entry above); with
// it it ends with 124 as soon as a command stands at the gate of the fake docker (`<gates>/*.waiting`) — the event "this call
// hangs" instead of an expired duration. Every call stands with its duration in timeout.log.
write("timeout", [
  "#!/bin/bash",
  'while [ $# -gt 0 ]; do case "$1" in -k|-s|--kill-after|--signal) shift 2;; --) shift; break;; -*) shift;; *) break;; esac; done',
  "secs=$1; shift",
  'case "$secs" in ""|*[!0-9]*) echo "wrong timeout: no duration in seconds: $secs" >&2; exit 125;; esac',
  `echo "$secs $*" >> '${TIMEOUT_LOG}'`,
  "export FAKE_TIMEOUT=1",
  `if [ ! -e '${BIN}/cap-observe' ]; then exec "$@"; fi`,
  `target=$(cat '${BIN}/docker.target'); gates="\${target%/docker}/gates"`,
  '"$@" <&0 &',
  "child=$!",
  'while kill -0 "$child" 2>/dev/null; do',
  '  for m in "$gates"/*.waiting; do if [ -e "$m" ]; then kill -KILL "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 124; fi; done',
  "  /bin/sleep 0.02",
  "done",
  'wait "$child"',
  "",
].join("\n"));
write("curl", [
  "#!/bin/sh",
  'url=""; for a in "$@"; do url="$a"; done',
  'case "$url" in',
  "  */api/health) printf 200 ;;",
  `  */api/runs/active) if [ -f '${RUNS}' ]; then cat '${RUNS}'; else echo "curl: (7) Failed to connect" >&2; exit 7; fi ;;`,
  '  *) echo "wrong curl: $url" >&2; exit 7 ;;',
  "esac",
  "",
].join("\n"));
write("pgrep", "#!/bin/sh\nexit 1\n");
// The gate reads the whole process list in the container (`ps -ww -eo pid=,args=`, lib/gates.mjs remoteProcesses) — in the fake B no
// provider process (else it would see the processes of this machine). An empty list is "unknown" (busy) — the fake B shows PID 1
// and itself like every real one.
write("ps", "#!/bin/sh\necho '    1 /sbin/docker-init -- /usr/local/bin/entry.sh'\necho \"$$ ps -ww -eo pid=,args=\"\n");
// sha256sum of the host (on the Mac under /sbin, outside PATH) — for the probe of the release folder.
write("sha256sum", '#!/bin/sh\nif [ -x /sbin/sha256sum ]; then exec /sbin/sha256sum "$@"; fi\n[ "$1" = "--" ] && shift\nexec /usr/bin/shasum -a 256 "$@"\n');
write("sleep", "#!/bin/sh\nexit 0\n");
// The throttle of the deploy's image builds (`nice -n 10 ionice -c3 docker build …`): ionice does not exist on a Mac, and the fakes need no
// scheduling — both only drop their own arguments and run the rest.
write("nice", '#!/bin/sh\n[ "$1" = "-n" ] && shift 2\nexec "$@"\n');
write("ionice", '#!/bin/sh\n[ "$1" = "-c3" ] && shift\nexec "$@"\n');
// The `cat` IN every container (fakeDocker `programs`, not on the PATH of the test). For the status file of the entrypoint it returns
// per call the next entry of the sequence from `probeStatus(…)` (the last one stays; an empty sequence ⇒ the file is not there
// yet), everything else it passes on to /bin/cat. No clock: "the entrypoint is not that far yet" is a number of readings.
export const PROBE_STATUS = path.join(ROOT, "probe-status");
export const PROBE_CAT = path.join(ROOT, "probe-cat");
fs.writeFileSync(PROBE_CAT, [
  "#!/bin/bash",
  `if [ "$#" -ne 1 ] || [ "$1" != '${STATUS_FILE}' ]; then exec /bin/cat "$@"; fi`,
  `d='${PROBE_STATUS}'`,
  'n=$(( $(/bin/cat "$d/counter" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$d/counter"',
  'f="$d/$n"; [ -e "$f" ] || f="$d/last"',
  'if [ -e "$f" ]; then exec /bin/cat "$f"; fi',
  'echo "cat: $1: No such file or directory" >&2; exit 1',
  "",
].join("\n"), { mode: 0o755 });
export const READY = "phase=ready\nnotice=own IP 172.17.0.2, docker0 10.249.0.1, backend 172.17.0.1:7718, limit 1\n";
export function probeStatus(...followUp) {
  fs.rmSync(PROBE_STATUS, { recursive: true, force: true });
  fs.mkdirSync(PROBE_STATUS, { recursive: true });
  followUp.forEach((t, i) => fs.writeFileSync(path.join(PROBE_STATUS, String(i + 1)), t));
  if (followUp.length) fs.writeFileSync(path.join(PROBE_STATUS, "last"), followUp.at(-1));
}
export const statusReadings = (a, b = B) => a.filter((x) => x.daemon === b && x.args[0] === "exec" && x.args.at(-1) === STATUS_FILE).length;
// The `git` IN every container (fakeDocker `programs`, like `cat`). `git lfs version` and `git config --system --get-all
// credential.helper` it answers from `probeLfs(…)` — per file the output, a missing file answers like the real git without git-lfs
// or without an entry (exit 1); the default is a project box with the LFS helper. Everything else it passes on to the git of this
// machine (the distribution calls none in the container otherwise).
export const PROBE_LFS = path.join(ROOT, "probe-lfs");
export const PROBE_GIT = path.join(ROOT, "probe-git");
fs.writeFileSync(PROBE_GIT, [
  "#!/bin/bash",
  `d='${PROBE_LFS}'`,
  'case "$*" in',
  `  "lfs version") if [ -e "$d/lfs" ]; then /bin/cat "$d/lfs"; exit 0; fi; echo "git: 'lfs' is not a git command. See 'git --help'." >&2; exit 1;;`,
  '  "config --system --get-all credential.helper") if [ -e "$d/helper" ]; then /bin/cat "$d/helper"; exit 0; fi; exit 1;;',
  "esac",
  'exec /usr/bin/git "$@"',
  "",
].join("\n"), { mode: 0o755 });
export const LFS_VERSION = "git-lfs/3.3.0 (GitHub; linux amd64; go 1.19.8)\n";
export function probeLfs({ lfs = LFS_VERSION, helper = `${LFS_HELPER_IN_BACKEND}\n` } = {}) {
  fs.rmSync(PROBE_LFS, { recursive: true, force: true });
  fs.mkdirSync(PROBE_LFS, { recursive: true });
  if (lfs !== null) fs.writeFileSync(path.join(PROBE_LFS, "lfs"), lfs);
  if (helper !== null) fs.writeFileSync(path.join(PROBE_LFS, "helper"), helper);
}

export const B = "cbase-u-abc";
export const B2 = "cbase-u-two";
export const R1 = "20260925-1789900000000";
export const R2 = "20260926-1789950000000";
export const R_OLD = "20260927-1790000000000";
export const R_NEW = "20260928-1790100000000";
export const hex = (c) => c.repeat(64);
export const BACKEND = hex("a");
export const BACKEND_OLD = hex("d");
export const BACKEND_NEW = hex("9");
export const PB_NEW = hex("b");
export const PB_OLD = hex("c");
export const PB_R1 = hex("e");
export const PB_R2 = hex("f");
export const cand = (r) => `cbase-projectbox:cand-${r}`;
export const LATEST = "cbase-projectbox:latest";
// ── Disruptions and the answers of the image checks ──

// Per disruption: `pattern` (substring of the arguments, "$*"), `output` (stdout), `notice` (stderr), `code`, `stdinRead` (only for
// a heredoc — else the entry would read the rest of the script from `bash -s`), `command` (a line that runs before — `$target` is
// the fake docker, e.g. to imitate a "build" as a tag of an existing image).
let responseSeq = 0;
export function disruptions(list = []) {
  const file = path.join(BIN, "docker.disruptions");
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const z = ['case "$*" in'];
  for (const s of list) {
    z.push(`  *${q(s.pattern)}*)`);
    if (s.stdinRead) z.push("    cat >/dev/null");
    if (s.command) z.push(`    ${s.command}`);
    if (s.output) {
      const f = path.join(ROOT, `response-${++responseSeq}`);
      fs.writeFileSync(f, s.output);
      z.push(`    cat ${q(f)}`);
    }
    if (s.notice) z.push(`    echo ${q(s.notice)} >&2`);
    z.push(`    exit ${s.code ?? 0};;`);
  }
  z.push("esac", "");
  fs.writeFileSync(file, z.join("\n"));
}
export function sh(script) {
  const r = spawnSync("/bin/bash", ["-s"], { input: `set -euo pipefail\n${script}\n`, env: { ...process.env, PATH: PATH }, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
export function shOk(script) {
  const r = sh(script);
  assert.equal(r.code, 0, `${script}\n${r.stderr}`);
  return r.stdout;
}

// A host with candidates, one running B each from `bImage` (plus `additional` B), inside the images of `inside` ([ref, asLatest]),
// running inner containers `insideRunning` (names) and project containers `projects`. The disruptions stand afterwards on
// `goodChecks()`; an `execGate` is open during setup and closed afterwards, without a mark. `bArgs`: further `docker run` arguments
// for B only (e.g. the login variable and the home volume the login retreat hangs on).
export async function build({
  images = {}, bImage = "cbase-backend:latest", inside = [], runs = null, releases = [], projects = [], insideRunning = [],
  additional = [], bArgs = "", checks = () => [], ...fdOpts
} = {}) {
  const fd = await fakeDocker({
    images: { "cbase-backend:latest": BACKEND, "cbase-backend:alt": BACKEND_OLD, [`cbase-backend:cand-${R_NEW}`]: BACKEND, ...images },
    ...fdOpts,
    programs: { cat: PROBE_CAT, git: PROBE_GIT, ...(fdOpts.programs || {}) },
  });
  probeStatus(READY);
  probeLfs();
  fs.writeFileSync(path.join(BIN, "docker.target"), fd.bin);
  for (const f of ["only-with-cap", "cap-observe", "docker.disruptions"]) fs.rmSync(path.join(BIN, f), { force: true });
  fs.rmSync(TIMEOUT_LOG, { force: true });
  if (fdOpts.execGate) fd.openGate(fdOpts.execGate);
  fs.rmSync(REMOTE, { recursive: true, force: true });
  fs.mkdirSync(path.join(REMOTE, "releases"), { recursive: true });
  for (const r of releases) fs.mkdirSync(path.join(REMOTE, "releases", r, "backend"), { recursive: true });
  if (releases.length) fs.symlinkSync(`releases/${releases[releases.length - 1]}`, path.join(REMOTE, "current"));
  if (runs) fs.writeFileSync(RUNS, JSON.stringify({ episodesMultiple: 0, layoutsOpen: 0, projectStopped: 0, projectWork: [], ...runs })); else fs.rmSync(RUNS, { force: true });
  for (const { name, image, inside: i } of [{ name: B, image: bImage, inside }, ...additional.map((w) => ({ image: bImage, inside: [], ...w }))]) {
    shOk(`docker run -d --init --name ${name} ${name === B ? bArgs : ""} ${image} >/dev/null`);
    for (const [ref, asLatest] of i) {
      shOk(`docker save ${ref} | docker exec -i -u agent ${name} docker load >/dev/null`);
      if (asLatest) shOk(`docker exec -u agent ${name} docker tag ${ref} ${LATEST}`);
    }
  }
  for (const { name, ref, stopped } of projects) {
    shOk(`docker exec -u agent ${B} docker run -d --name ${name} --label cbase.project=1 ${ref} >/dev/null`);
    if (stopped) shOk(`docker exec -u agent ${B} docker stop ${name} >/dev/null`);
  }
  for (const name of insideRunning) shOk(`docker exec -u agent ${B} docker run -d --name ${name} cbase-test/${name}:1 >/dev/null`);
  if (fdOpts.execGate) {
    fd.closeGate(fdOpts.execGate);
    fs.rmSync(path.join(fd.dir, "gates", `${encodeURIComponent(fdOpts.execGate)}.waiting`), { force: true });
  }
  disruptions(checks());
  const start = fd.calls().length;
  return { fd, fresh: () => fd.calls().slice(start) };
}

// Run a target with a captured console; on an error the output hangs on the error.
export async function withOutput(fn) {
  const rows = [];
  const orig = console.log;
  console.log = (...a) => rows.push(a.join(" "));
  try {
    const result = await fn();
    return { result, text: rows.join("\n") };
  } catch (e) {
    e.output = rows.join("\n");
    throw e;
  } finally {
    console.log = orig;
  }
}
export const insideLatest = (fd, b = B) => fd.state(b).images[LATEST]?.id ?? null;
export const inDaemon = (a, d, ...prefix) => a.daemon === d && prefix.every((p, i) => a.args[i] === p);
export const isProbeStart = (a) => a.daemon.startsWith("cbase-u-") && !a.daemon.includes(">") && a.args[0] === "run" && a.args.includes("--privileged") && a.args.includes(PROBE_LABEL);
export const isTagLatest = (a) => a.daemon.startsWith("cbase-u-") && !a.daemon.includes(">") && a.args[0] === "tag" && a.args[2] === LATEST;
export const isLoad = (a) => inDaemon(a, B, "load");
export const isSave = (a) => inDaemon(a, "host", "save");
export const isGate = (a) => inDaemon(a, "host", "exec") && a.args.includes("curl");
export const isSwap = (a) => a.daemon === "host" && ["stop", "rm", "run"].includes(a.args[0]);
export const isHostTag = (a) => inDaemon(a, "host", "tag") && a.args[2] === "cbase-backend:latest";
export const current = () => { try { return fs.readlinkSync(path.join(REMOTE, "current")); } catch { return null; } };
export const probeLeftovers = (fd, b = B) => Object.values(fd.state(b).container).filter((c) => PROBE_LABEL.split("=")[0] in c.labels);

// Every tag on inside :latest has before it: the start of a probe container from the SAME ref in the same B, after it an `info` in
// its daemon and after that its `rm -f -v` by id — all before the tag.
export function tagsOnlyAfterProbe(calls) {
  const tags = calls.map((a, i) => [a, i]).filter(([a]) => isTagLatest(a));
  if (!tags.length) return false;
  return tags.every(([t, i]) => {
    const ref = t.args[1];
    const start = calls.slice(0, i).map((a, j) => [a, j]).filter(([a]) => isProbeStart(a) && a.daemon === t.daemon && a.args.at(-1) === ref).at(-1);
    if (!start) return false;
    const info = calls.slice(start[1], i).findIndex((a) => a.daemon.startsWith(`${t.daemon}>`) && a.args[0] === "info");
    if (info < 0) return false;
    const removed = calls.slice(start[1] + info, i).findIndex((a) => inDaemon(a, t.daemon, "rm", "-f", "-v"));
    return removed >= 0;
  });
}

export const Q1 = "1".repeat(64);
export const Q2 = "2".repeat(64);


// ── (1) The scripts: stream, probe, tag in a step of its own, removal by id ──

export const rowsOf = (s) => s.split("\n");
// Text guard: prepareScript starts the probe, waits in a loop for `docker info` in the probe container, removes it afterwards — and
// does NOT tag :latest; tagScript checks the id of `cand` inside BEFORE it tags exactly once.
export function probeAndTagSeparated(prepare, tagS, hostId) {
  const z = rowsOf(prepare);
  const run = z.findIndex((l) => l.includes("docker run -d --privileged") && l.includes(PROBE_LABEL));
  const wait = z.findIndex((l) => /^\s*info_rc=0; dx docker exec "\$pid" docker info /.test(l));
  const end = z.findIndex((l, i) => i > wait && l === "done");
  const removed = z.findIndex((l, i) => i > end && l.startsWith("probe_remove || {"));
  const t = rowsOf(tagS);
  const check = t.findIndex((l) => l.startsWith(`if [ "$inner" != "${hostId}" ]`));
  const tag = t.findIndex((l) => l.includes("docker tag") && l.includes(LATEST));
  return run >= 0 && wait > run && end > wait && removed > end
    && !z.some((l) => l.includes("docker tag") && l.includes(LATEST))
    && check >= 0 && tag > check && t.filter((l) => l.includes("docker tag") && l.includes(LATEST)).length === 1;
}


// The sabotage "a plan that tags without a probe": the real prepare step without everything from the `run -d` of the probe up to the
// `probe_remove` after the loop — loading and the id check stay, the tagging afterwards too.
export function withoutProbe(script) {
  const z = rowsOf(script);
  const from = z.findIndex((l) => l.startsWith("pid=$(dx docker run -d --privileged"));
  const until = z.findIndex((l, i) => i > from && l.startsWith("probe_remove || {"));
  assert.ok(from >= 0 && until > from);
  return [...z.slice(0, from), ...z.slice(until + 1)].join("\n");
}


// ── git-lfs and the LFS helper in the start probe ──

// The two git calls in the probe container (the inner `exec <pid> git …`), in order.
export const lfsCalls = (a) => a.filter((x) => x.daemon === B && x.args[0] === "exec" && x.args.includes("git"))
  .map((x) => x.args.slice(x.args.indexOf("git")).join(" "));
// The sabotage "a start probe without LFS part": everything from `lfs_rc=0;` to the `fi` of the verdict becomes a fixed value —
// loading, probe, leftovers and tag stay.
export function withoutLfs(script) {
  const z = rowsOf(script);
  const from = z.findIndex((l) => l.startsWith("lfs_rc=0;"));
  const verdict = z.findIndex((l, i) => i > from && l === 'if [ -z "$lfs_row" ]; then');
  const until = z.findIndex((l, i) => i > verdict && l === "fi");
  assert.ok(from >= 0 && verdict > from && until > verdict, "the LFS part no longer has the expected form — the sabotage does not bite");
  return [...z.slice(0, from), 'lfs_row="unchecked"', ...z.slice(until + 1)].join("\n");
}

// Does a `docker start` in B start the probe leftover `rest` (full id)? Only an argument AFTER the command that is the id or a prefix of at
// least 12 characters — before, `rest.startsWith(y)` also hit the name "db" when the random id began with "db" (a flake with p = 1/256).
export function bringsLeftoverBack(a, rest) {
  return a.args.slice(1).some((y) => y === rest || (y.length >= 12 && rest.startsWith(y)));
}
