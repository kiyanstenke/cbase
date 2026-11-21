// The entrypoint of the project container, server/backend/projectbox-entry.sh. server/backend/ is in no glob of the gate,
// so the guard lives here.
//
// The real script runs under /bin/bash (gate: 3.2) AND /bin/dash, with a PATH of fake `dockerd`, `docker`, `iptables`,
// `sysctl`, `ip` and an `rm` that only deletes under the test root. The root seam CBASE_PROJECTBOX_ROOT prefixes
// /sys/fs/cgroup (stub: cgroup.controllers, cgroup.procs), /etc/docker, /run, /var/run; the addresses of the fake `ip` are the
// measured ones (eth0 10.231.0.2, gateway 10.231.0.1, docker0 10.241.0.1).
//
// Course of every run, without a deadline: start (own process group) → wait for the first milestone (a `docker info`, a status
// file "ready/error", a dockerd that is the script itself, or the end) → only THEN the test opens the gate behind which
// `docker info` answers → wait for "ready/error" → TERM (or INT) to the script → wait for its end. The fake dockerd ends on
// TERM with code 7 — if 7 arrives at the script, it waited and passed it on. In the finally the whole group is killed hard.
//
// NO HANG. A run used to wait without exit for the end of the script: a regression where it never ends did not turn the test red,
// it hung until the suite deadline. An event alone cannot report "never ends" — "dockerd is gone, the script still lives" is
// also true in the RIGHT run for a few milliseconds (between the `wait` that reaps dockerd and `exit`: log, status file with
// chmod and mv). So the stub carries the ONE emergency brake of the fakes (server/backend/test/ripcord.mjs, 120 s) at exactly
// the two places where a regression would hang:
//   - dockerd never gets TERM (the passing on is broken): its waiting ends after the ripcord, it writes
//     "ripcord: dockerd got no TERM" and ends with 9;
//   - dockerd is gone, the script does not end: a watchdog that dockerd starts at its end sees the script still alive after
//     the ripcord and writes "ripcord: the script lives after dockerd ended".
// Every wait of the test ends at such a line just like at the end of the script (events, no deadline in the test); `assertEnd`
// demands there is none. The counter-tests "ripcord …" set the ripcord small via the environment.
//
// Promises: leftovers before dockerd; subtree_control = +cpu +io +memory +pids; pool from the environment, size 24 (plus the
// log rotation); DNAT only after "info answers" and after the jump, always with -A; the two forms of the switch; TERM (and
// INT) to the script reaches dockerd, the script ends only afterwards, with its code; the script stays the parent process of
// dockerd. Counter-tests: without a pool exit ≠ 0 and no dockerd; `exec dockerd` has no DNAT row; without the rm step the fake
// dockerd aborts with "pid file found"; `-I` instead of `-A` is red; an iptables error does not end with exit ≠ 0 and fills the
// status file (sabotage: a fatal DNAT error is red); without trap the script dies on TERM (red); DNAT without `docker info` is
// red; at the cap no DNAT, but no end either.
// Step 2 (cgroup) is not fatal — an EBUSY when writing the controllers (fake `sed` with FAKE_SED_ERROR) moves again and tries
// again; after five failures `phase=error`, `notice=cgroup: …`, which stays until the end (also after "info answers" and DNAT),
// dockerd runs. Counter-test against the state before that (BEFORE_PC_7): exit 4 before dockerd, status file on `phase=start` — red.
//
// Step 3a, the resting overlay stage of a copy: the programs come through the seams CBASE_MOUNT_BIN / CBASE_MOUNTPOINT_BIN /
// CBASE_UMOUNT_BIN from the stub (`fake-mount` remembers the target and checks that it exists as a folder; `fake-mountpoint`
// asks this list; `fake-umount` removes the line from the fake mountinfo under the root and fails on a path that is no mount
// point) — a `mount`, `mountpoint` or `umount` from the PATH writes "forbidden". Promises: WITHOUT overlays.tsv the same call
// sequence, status file and code as the script without step 3a (BEFORE_ST2_0; logs normalized: root, pids, repeated "docker info no"),
// also with mount points under /cbase-main; WITH the file every overlay exactly once, sorted outer before inner,
// `LIBMOUNT_FORCE_MOUNT2=always` and only `userxattr,lowerdir,upperdir,workdir`, all before dockerd; `mountpoint -q` prevents
// double mounting — but ONLY if at the target mountinfo shows exactly THIS overlay (type, lowerdir, upperdir); a bind, another
// overlay or no entry ⇒ `phase=error` (counter-test against BEFORE_GL_E: there the script ran past a bind up to dockerd); if
// .prepared is missing, `phase=prepare` stands, and the test opens the gate (the file) only AFTER it has seen all overlays and
// no umount and no dockerd; then every mount point under /cbase-copy and /cbase-main with `umount -l`, inner before outer,
// foreign ones stay. Every error (mount, file, cap, umount, second reading, line break) ⇒ `phase=error`, no daemon.json, no
// dockerd, the script lives until the signal and ends with 143/130.
// Counter-tests: a version that enters 3a without the file breaks the same sequence; without sorting inner before outer;
// without `mountpoint -q` mounted twice; with `exit 1` instead of resting it ends before the signal (exit ≠ 0); without `exit`
// in the trap it keeps resting — the ripcord of the fake `sleep 3600` reports that instead of the test hanging.
//
// Run:  node --test --test-reporter=tap tools/check/projectbox-entry.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RIPCORD_MS } from "../../server/backend/test/ripcord.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const ENTRY = path.join(REPO, "server/backend/projectbox-entry.sh");
const SHELLS = ["/bin/bash", "/bin/dash"];
const POOL = "10.241.0.0/16";
const RC = "7"; // exit code of the fake dockerd after TERM
// The states before three fixes, rebuilt from today's script by taking the fix out again (each replacement must bite, see
// `withoutFix`): the cgroup step of 17bb7a66 (BEFORE_PC_7: nest once under `set -e`, no retry), the script without step 3a as at
// 0bcae4ad (BEFORE_ST2_0), and the skip of 67644b1 (BEFORE_GL_E: `mountpoint -q` alone sufficed to skip a target).
const CGROUP_TODAY = /^if \[ -f "\$CG\/cgroup\.controllers" \] && ! cgroup_nest; then\n(?: {2}[^\n]*\n)+fi\n/m;
const CGROUP_BEFORE_PC_7 = [
  'if [ -f "$CG/cgroup.controllers" ]; then',
  '  mkdir -p "$CG/init"',
  '  xargs -rn1 < "$CG/cgroup.procs" > "$CG/init/cgroup.procs" || :',
  "  sed -e 's/ / +/g' -e 's/^/+/' < \"$CG/cgroup.controllers\" > \"$CG/cgroup.subtree_control\"",
  "fi",
  "",
].join("\n");
const STEP_3A_TODAY = /^if \[ -e "\$OVERLAYS" \] \|\| \[ -L "\$OVERLAYS" \]; then\n(?: {2}[^\n]*\n)+fi\n/m;
const TARGET_CHECK_TODAY = / {6}ov_actual=\$\(target_mount [\s\S]*?\n {6}return 1\n {4}fi\n/;
const SKIP_BEFORE_GL_E = '      log "overlay: $ov_z is already mounted"\n      continue\n    fi\n';
function withoutFix(...pairs) {
  let text = fs.readFileSync(ENTRY, "utf8");
  for (const [from, to] of pairs) {
    const fresh = text.replace(from, () => to);
    assert.notEqual(fresh, text, `the place "${String(from).slice(0, 60)}" has moved — the counter-test does not bite`);
    text = fresh;
  }
  return text;
}
// The ripcord of the stub: dockerd waits at most this long for TERM (seconds), the watchdog counts this many ticks of 50 ms before
// it reports "the script lives after dockerd ended". Both from the ONE number of the fakes.
const RIPCORD_S = String(Math.ceil(RIPCORD_MS / 1000));
const RIPCORD_TICKS = String(Math.ceil(RIPCORD_MS / 50));

const LEFTOVERS = ["var/run/docker.pid", "run/docker/containerd/containerd.pid", "var/run/docker.sock"];

const ONLY_IN_THE_ROOT =
  `for a in "$@"; do case "$a" in /*) case "$a" in "$FAKE_BASE"/*) ;; *) echo "outside the test root: $a" >&2; exit 97;; esac;; esac; done`;
const W = '"$CBASE_PROJECTBOX_ROOT"';

const FAKES = {
  // Checks leftovers, configuration and cgroup at start, writes its pid file ONLY AFTER the trap (only then does `docker info`
  // answer) and ends on TERM with FAKE_DOCKERD_RC. The ripcord (header): without TERM its waiting ends after FAKE_RIPCORD_S with 9
  // and a line; at EVERY one of its ends it starts the watchdog, which watches the script (its parent process) and after
  // FAKE_RIPCORD_TICKS × 50 ms reports that it still lives. The watchdog holds no output of the script open and sits in its
  // process group (the finally hits it).
  dockerd: [
    `printf '%s\\n' "dockerd start pid=$$ ppid=$PPID" >> "$FAKE_LOG"`,
    `sk=$PPID`,
    `watchdog() {`,
    `  ( exec >/dev/null 2>&1 </dev/null; i=0`,
    `    while kill -0 "$sk" 2>/dev/null; do`,
    `      i=$((i + 1))`,
    `      if [ "$i" -ge "$FAKE_RIPCORD_TICKS" ]; then printf '%s\\n' "ripcord: the script lives after dockerd ended" >> "$FAKE_LOG"; exit 0; fi`,
    `      sleep 0.05`,
    `    done ) &`,
    `}`,
    `for r in ${LEFTOVERS.join(" ")}; do [ -e ${W}/$r ] && printf '%s\\n' "dockerd rest=$r" >> "$FAKE_LOG"; done`,
    `if [ -e ${W}/var/run/docker.pid ]; then printf '%s\\n' "dockerd pid file found" >> "$FAKE_LOG"; echo "failed to start daemon: pid file found, ensure docker is not running or delete /var/run/docker.pid" >&2; watchdog; exit 1; fi`,
    `[ -f ${W}/etc/docker/daemon.json ] && printf '%s\\n' "dockerd daemon.json" >> "$FAKE_LOG"`,
    `printf '%s\\n' "dockerd cgroup=$(cat ${W}/sys/fs/cgroup/cgroup.subtree_control 2>/dev/null)" >> "$FAKE_LOG"`,
    `sleep "$FAKE_RIPCORD_S" & sp=$!`,
    `trap 'printf "%s\\n" "dockerd TERM" >> "$FAKE_LOG"; kill "$sp" 2>/dev/null; rm -f ${W}/var/run/docker.pid; watchdog; exit "\${FAKE_DOCKERD_RC:-0}"' TERM`,
    `mkdir -p ${W}/var/run && echo $$ > ${W}/var/run/docker.pid`,
    `wait "$sp"`,
    `printf '%s\\n' "ripcord: dockerd got no TERM" >> "$FAKE_LOG"`,
    `rm -f ${W}/var/run/docker.pid`,
    `watchdog`,
    `exit 9`,
  ].join("\n"),
  docker: [
    `if [ "$1" = info ]; then`,
    `  if [ -e "$FAKE_BASE/info-gate" ] && kill -0 "$(cat ${W}/var/run/docker.pid 2>/dev/null)" 2>/dev/null; then`,
    `    printf '%s\\n' "docker info yes" >> "$FAKE_LOG"; exit 0`,
    `  fi`,
    `  printf '%s\\n' "docker info no" >> "$FAKE_LOG"; echo "Cannot connect to the Docker daemon" >&2; exit 1`,
    `fi`,
    `printf '%s\\n' "docker $*" >> "$FAKE_LOG"; exit 0`,
  ].join("\n"),
  iptables: [
    `printf '%s\\n' "iptables $*" >> "$FAKE_LOG"`,
    `if [ "\${FAKE_IPTABLES_ERROR:-0}" = 1 ] && [ "$3" = -A ]; then echo "iptables: No chain/target/match by that name." >&2; exit 1; fi`,
    `if [ "$*" = "-t nat -C PREROUTING -m addrtype --dst-type LOCAL -j DOCKER" ] && [ "\${FAKE_JUMP:-1}" != 1 ]; then echo "iptables: Bad rule (does a matching rule exist in that chain?)." >&2; exit 1; fi`,
    `exit 0`,
  ].join("\n"),
  sysctl: [
    `printf '%s\\n' "sysctl $*" >> "$FAKE_LOG"`,
    `[ "$1" = -n ] && [ "$2" = net.ipv4.ip_local_port_range ] && printf '32768\\t60999\\n'`,
    `exit 0`,
  ].join("\n"),
  ip: [
    `printf '%s\\n' "ip $*" >> "$FAKE_LOG"`,
    `case "$*" in`,
    `  "-4 -o addr show dev eth0") printf '%s\\n' '2: eth0    inet 10.231.0.2/24 brd 10.231.0.255 scope global eth0\\       valid_lft forever preferred_lft forever';;`,
    `  "-4 -o addr show dev docker0") printf '%s\\n' '3: docker0    inet 10.241.0.1/24 brd 10.241.0.255 scope global docker0\\       valid_lft forever preferred_lft forever';;`,
    `  "-4 route show default") printf '%s\\n' 'default via 10.231.0.1 dev eth0';;`,
    `  *) exit 1;;`,
    `esac`,
  ].join("\n"),
  rm: `printf '%s\\n' "rm $*" >> "$FAKE_LOG"\n${ONLY_IN_THE_ROOT}\nexec /bin/rm "$@"`,
  // `sed` writes the controllers to cgroup.subtree_control in step 2. The first FAKE_SED_ERROR calls fail like the kernel with a
  // process in the root cgroup (EBUSY), after that the real sed. `xargs` is only logged.
  sed: [
    `printf '%s\\n' "sed $*" >> "$FAKE_LOG"`,
    `n=$(cat "$FAKE_BASE/sed-counter" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAKE_BASE/sed-counter"`,
    `if [ "$n" -le "\${FAKE_SED_ERROR:-0}" ]; then echo "sed: couldn't write 23 items to stdout: Device or resource busy" >&2; exit 4; fi`,
    `PATH=/usr/bin:/bin exec sed "$@"`,
  ].join("\n"),
  xargs: `printf '%s\\n' "xargs $*" >> "$FAKE_LOG"\nPATH=/usr/bin:/bin exec xargs "$@"`,
  // The three programs of the overlay stage, through their seams. `fake-mount` fails at the target FAKE_MOUNT_ERROR (without root)
  // and at a target that is no folder (mkdir -p was missing); `fake-umount` is Node (mountinfo with maskings).
  "fake-mount": [
    `printf '%s\\n' "mount LIBMOUNT_FORCE_MOUNT2=\${LIBMOUNT_FORCE_MOUNT2:-} $*" >> "$FAKE_LOG"`,
    `for target in "$@"; do :; done`,
    `case "$target" in "$FAKE_BASE"/*) ;; *) echo "outside the test root: $target" >&2; exit 97;; esac`,
    `if [ -n "\${FAKE_MOUNT_ERROR:-}" ] && [ "$target" = ${W}"$FAKE_MOUNT_ERROR" ]; then echo "mount: $target: wrong fs type, bad option, bad superblock on overlay" >&2; exit 32; fi`,
    `[ -d "$target" ] || { echo "mount: $target: mount point does not exist." >&2; exit 32; }`,
    `printf '%s\\n' "$target" >> "$FAKE_BASE/mounted"`,
  ].join("\n"),
  "fake-mountpoint": [
    `printf '%s\\n' "mountpoint $*" >> "$FAKE_LOG"`,
    `[ "$1" = -q ] && [ $# -eq 2 ] || exit 2`,
    `grep -Fxq -- "$2" "$FAKE_BASE/mounted" 2>/dev/null`,
  ].join("\n"),
  "fake-umount": `exec "$FAKE_NODE" "$FAKE_BASE/umount.cjs" "$@"`,
  mount: `printf '%s\\n' "forbidden: mount from the PATH $*" >> "$FAKE_LOG"; exit 99`,
  mountpoint: `printf '%s\\n' "forbidden: mountpoint from the PATH $*" >> "$FAKE_LOG"; exit 99`,
  umount: `printf '%s\\n' "forbidden: umount from the PATH $*" >> "$FAKE_LOG"; exit 99`,
  // The resting without dockerd (`sleep 3600 &` + `wait`) gets the ripcord: if it does not end at the signal, it writes a line after
  // FAKE_RIPCORD_S, and the test turns red instead of hanging. Every other duration is the real sleep.
  sleep: [
    `if [ "$1" = 3600 ]; then`,
    `  /bin/sleep "$FAKE_RIPCORD_S"`,
    `  printf '%s\\n' "ripcord: the script keeps resting without dockerd although a signal came" >> "$FAKE_LOG"`,
    `  exit 0`,
    `fi`,
    `exec /bin/sleep "$@"`,
  ].join("\n"),
};

// `umount -l <path>` against the fake mountinfo under the root: removes the line (field 5, kernel maskings), fails on a path that
// is no mount point ("not mounted" — as a literal `umount -l /cbase-main` failed), at FAKE_UMOUNT_ERROR (without root) and with
// FAKE_UMOUNT_INEFFECTIVE=1 leaves everything standing.
const UMOUNT_CJS = `
const fs = require("fs");
const path = require("path");
const a = process.argv.slice(2);
const w = process.env.CBASE_PROJECTBOX_ROOT;
fs.appendFileSync(process.env.FAKE_LOG, "umount " + a.join(" ") + "\\n");
if (a.length !== 2 || a[0] !== "-l") { process.stderr.write("wrong call\\n"); process.exit(2); }
const p = a[1];
if (!p.startsWith(process.env.FAKE_BASE + "/")) { process.stderr.write("outside the test root: " + p + "\\n"); process.exit(97); }
if (process.env.FAKE_UMOUNT_ERROR && p === w + process.env.FAKE_UMOUNT_ERROR) { process.stderr.write("umount: " + p + ": target is busy.\\n"); process.exit(32); }
const mi = path.join(w, "proc/self/mountinfo");
const unmask = (s) => s.replace(/\\\\(040|011|012|134)/g, (_, c) => String.fromCharCode(parseInt(c, 8)));
const rows = fs.readFileSync(mi, "utf8").split("\\n").filter(Boolean);
const rest = rows.filter((z) => unmask(z.split(" ")[4]) !== p);
if (rest.length === rows.length) { process.stderr.write("umount: " + p + ": not mounted.\\n"); process.exit(32); }
if (process.env.FAKE_UMOUNT_INEFFECTIVE !== "1") fs.writeFileSync(mi, rest.map((z) => z + "\\n").join(""));
`;

function build(prior) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-pbx-"));
  const w = {
    base,
    root: path.join(base, "root"),
    bin: path.join(base, "bin"),
    log: path.join(base, "log"),
    gate: path.join(base, "info-gate"),
  };
  w.status = path.join(w.root, "run/cbase-projectbox.status");
  w.cg = path.join(w.root, "sys/fs/cgroup");
  for (const d of ["run/docker/containerd", "var/run", "sys/fs/cgroup", "etc"]) fs.mkdirSync(path.join(w.root, d), { recursive: true });
  fs.writeFileSync(path.join(w.cg, "cgroup.controllers"), "cpu io memory pids\n");
  fs.writeFileSync(path.join(w.cg, "cgroup.procs"), "1\n23\n");
  fs.writeFileSync(w.log, "");
  fs.mkdirSync(w.bin);
  for (const [name, body] of Object.entries(FAKES)) {
    const f = path.join(w.bin, name);
    fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(f, 0o755);
  }
  fs.writeFileSync(path.join(base, "umount.cjs"), UMOUNT_CJS);
  if (prior) prior(w);
  return w;
}

const tick = () => new Promise((r) => setTimeout(r, 20)); // a tick, no deadline
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const rows = (w) => read(w.log).split("\n").filter(Boolean);
const phase = (w) => (read(w.status).match(/^phase=(.*)$/m) || [])[1] || "";
const ended = (k) => k.exitCode !== null || k.signalCode !== null;
const isNat = (z) => /^(iptables |sysctl -w )/.test(z);
const ripcords = (w) => rows(w).filter((z) => z.startsWith("ripcord:"));

// Waits without a deadline until `check()` returns something — or the child ends or the stub pulls its ripcord (then `null`).
async function waitForTruthy(check, kind, w) {
  for (;;) {
    const v = check();
    if (v) return v;
    if (ended(kind) || ripcords(w).length) return check() || null;
    await tick();
  }
}

// One run from start to end. `gate: false` never opens the gate (cap); `signal: null` sends none (the script ends by itself);
// `beforeSignal(w)` is an event that is additionally waited for before the signal.
// `during(w)` runs at every tick of the first wait — there the test opens the gate `.prepared`.
async function run(w, { shell = "/bin/bash", script = ENTRY, env = {}, signal = "SIGTERM", gate = true, beforeSignal = null, during = null } = {}) {
  const subprocess = spawn(shell, [script], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      PATH: `${w.bin}:/usr/bin:/bin`,
      CBASE_PROJECTBOX_ROOT: w.root,
      CBASE_DOCKER_POOL: POOL,
      CBASE_PROJECTBOX_TICK: "0.02",
      CBASE_PROJECTBOX_ATTEMPTS: "100000000",
      FAKE_LOG: w.log,
      FAKE_BASE: w.base,
      FAKE_DOCKERD_RC: RC,
      FAKE_RIPCORD_S: RIPCORD_S,
      FAKE_RIPCORD_TICKS: RIPCORD_TICKS,
      FAKE_NODE: process.execPath,
      CBASE_MOUNT_BIN: path.join(w.bin, "fake-mount"),
      CBASE_MOUNTPOINT_BIN: path.join(w.bin, "fake-mountpoint"),
      CBASE_UMOUNT_BIN: path.join(w.bin, "fake-umount"),
      ...env,
    },
  });
  let err = "";
  subprocess.stderr.on("data", (b) => (err += b));
  const end = new Promise((r) => subprocess.once("exit", (code, sig) => r({ code, sig })));
  const b = { kind: subprocess, milestone: null, natBeforeInfo: [], statusBeforeSignal: "", wasAliveAtSignal: false };
  const past = () => ended(subprocess) || ripcords(w).length > 0;
  try {
    const finite = () => /^(ready|error)$/.test(phase(w)) && "status";
    b.milestone = await waitForTruthy(() => {
      if (during) during(w);
      const p = rows(w);
      if (p.some((z) => z.startsWith("docker info"))) return "info";
      if (finite()) return "status";
      const d = p.find((z) => z.startsWith("dockerd start"));
      if (d && Number(d.match(/pid=(\d+)/)[1]) === subprocess.pid) return "exec";
      return null;
    }, subprocess, w) || "end";
    b.natBeforeInfo = rows(w).filter(isNat);
    if (b.milestone === "info") {
      if (gate) fs.writeFileSync(w.gate, "");
      await waitForTruthy(finite, subprocess, w);
    }
    if (beforeSignal) await waitForTruthy(() => beforeSignal(w), subprocess, w);
    b.statusBeforeSignal = read(w.status);
    b.wasAliveAtSignal = !past();
    if (b.wasAliveAtSignal && signal) { try { process.kill(subprocess.pid, signal); } catch { /* just ended */ } }
    // The end of the script OR a ripcord of the stub — never a wait without exit.
    await waitForTruthy(() => past(), subprocess, w);
    const e = ended(subprocess) ? await end : { code: null, sig: null };
    return { ...b, ...e, err, log: rows(w), status: read(w.status), ripcord: ripcords(w) };
  } finally {
    try { process.kill(-subprocess.pid, "SIGKILL"); } catch { /* already gone */ }
    for (const z of rows(w)) {
      const m = z.match(/^dockerd start pid=(\d+)/);
      if (m) { try { process.kill(Number(m[1]), "SIGKILL"); } catch { /* already gone */ } }
    }
  }
}

const way = (w) => fs.rmSync(w.base, { recursive: true, force: true });
const idx = (p, pattern) => p.findIndex((z) => (typeof pattern === "string" ? z === pattern || z.startsWith(pattern) : pattern.test(z)));

const RULES = {
  common: [
    "iptables -t nat -A OUTPUT -d 127.0.0.1/32 -p tcp --dport 7718 -j DNAT --to-destination 10.231.0.1:7718",
    "iptables -t nat -A POSTROUTING -s 127.0.0.1/32 -o eth0 -j MASQUERADE",
    "iptables -t nat -C PREROUTING -m addrtype --dst-type LOCAL -j DOCKER",
  ],
  // Own IP only over eth0, docker0 only below the ephemeral range (stub: 32768).
  limit: [
    "iptables -t nat -A PREROUTING -i eth0 -d 10.231.0.2/32 -p tcp -j DNAT --to-destination 127.0.0.1",
    "iptables -t nat -A PREROUTING -d 10.241.0.1/32 -p tcp --dport 1:32767 -j DNAT --to-destination 127.0.0.1",
  ],
  // The measured form, CBASE_DNAT_LIMIT=0.
  measured: [
    "iptables -t nat -A PREROUTING -d 10.231.0.2/32 -p tcp -j DNAT --to-destination 127.0.0.1",
    "iptables -t nat -A PREROUTING -d 10.241.0.1/32 -p tcp -j DNAT --to-destination 127.0.0.1",
  ],
};
const ROUTE_LOCALNET = ["all", "eth0", "docker0"].map((i) => `sysctl -w net.ipv4.conf.${i}.route_localnet=1`);

// The promises for ONE successful run — as a function so that the same check turns red on a sabotaged copy.
function checkRun(r, w, { limit = true, signal = "SIGTERM" } = {}) {
  const p = r.log;
  const text = `\n${p.join("\n")}\n--- stderr\n${r.err}`;
  // dockerd: started, the script stays its parent process (no exec), no leftovers, configuration and cgroup before.
  const start = p.find((z) => z.startsWith("dockerd start"));
  assert.ok(start, `dockerd never started${text}`);
  const [, dpid, dppid] = start.match(/pid=(\d+) ppid=(\d+)/).map(Number);
  assert.notEqual(dpid, r.kind.pid, "dockerd is the script itself (exec dockerd) — no DNAT comes after");
  assert.equal(dppid, r.kind.pid, "the script is not the parent process of dockerd");
  assert.deepEqual(p.filter((z) => z.startsWith("dockerd rest=") || z === "dockerd pid file found"), [], `leftovers at the start of dockerd${text}`);
  assert.ok(p.includes("dockerd daemon.json"), "daemon.json was missing at the start of dockerd");
  assert.ok(p.includes("dockerd cgroup=+cpu +io +memory +pids"), `subtree_control at the start of dockerd${text}`);
  assert.equal(read(path.join(w.cg, "init/cgroup.procs")), "1\n23\n", "the processes did not move to init/");
  const dj = JSON.parse(read(path.join(w.root, "etc/docker/daemon.json")));
  assert.deepEqual(dj, { "default-address-pools": [{ base: POOL, size: 24 }], "log-opts": { "max-size": "100m", "max-file": "5" } });
  // DNAT: nothing before "info answers", everything after; the jump before the PREROUTING rules; only -A.
  assert.equal(r.milestone, "info", `the first milestone was "${r.milestone}", not a docker info${text}`);
  assert.deepEqual(r.natBeforeInfo, [], "DNAT before the first docker info");
  const iInfoYes = idx(p, "docker info yes");
  const iFirstNat = p.findIndex(isNat);
  assert.ok(iInfoYes >= 0 && iFirstNat > iInfoYes, `DNAT not only after "info answers"${text}`);
  const nat = p.filter(isNat);
  const expected = [...ROUTE_LOCALNET, ...RULES.common, ...(limit ? RULES.limit : RULES.measured)];
  assert.deepEqual(nat, expected, `Rules${text}`);
  assert.ok(nat.filter((z) => z.startsWith("iptables") && !z.includes(" -C ")).every((z) => z.startsWith("iptables -t nat -A ")), "a rule without -A");
  const iJump = idx(p, RULES.common[2]);
  assert.ok(p.filter((z) => z.includes("-A PREROUTING")).every((z) => p.indexOf(z) > iJump), "PREROUTING before the check of the jump");
  assert.ok(p.includes(`sysctl -n net.ipv4.ip_local_port_range`) === limit, "ip_local_port_range read/not read");
  assert.match(r.statusBeforeSignal, /^phase=ready\nnotice=own IP 10\.231\.0\.2, docker0 10\.241\.0\.1, backend 10\.231\.0\.1:7718, limit [01]\n$/, "status file");
  // End: the signal went as TERM to dockerd, the script waited and passed its code on.
  assertEnd(r, signal, text);
}

function assertEnd(r, signal, text = "") {
  assert.deepEqual(r.ripcord, [], `the stub pulled its ripcord — without it the test would hang${text}`);
  assert.equal(r.wasAliveAtSignal, true, `the script ended before the signal${text}`);
  assert.ok(r.log.includes("dockerd TERM"), `${signal} did not reach dockerd${text}`);
  assert.equal(r.sig, null, `the script died of the signal ${r.sig}`);
  assert.equal(String(r.code), RC, `not the code of dockerd — the script did not wait for it${text}`);
  assert.match(r.status, /^phase=ended\nnotice=dockerd ended with 7\n$/);
}

// Five failures ⇒ dockerd runs anyway, and the phase stays `error` with the cgroup notice — also after `docker info` answered and
// DNAT is set (else "ready" would stand there, and the setup would take a container without delegation).
function checkCgroupError(r) {
  const p = r.log;
  const text = `\n${p.join("\n")}\n--- stderr\n${r.err}`;
  assert.equal(p.filter((z) => z.startsWith("sed ")).length, 5, `five attempts expected${text}`);
  assert.ok(p.some((z) => z.startsWith("dockerd start")), `dockerd did not start — step 2 was fatal${text}`);
  assert.ok(p.includes("docker info yes"), `docker info never answered${text}`);
  assert.ok(p.some((z) => z.startsWith("iptables -t nat -A PREROUTING")), `DNAT missing${text}`);
  assert.match(r.statusBeforeSignal, /^phase=error\nnotice=cgroup: subtree_control not written after 5 attempts — sed: couldn't write 23 items to stdout: Device or resource busy ?\n$/,
    `status file after DNAT: ${r.statusBeforeSignal}`);
}

function sabotage(w, name, ...pairs) {
  let text = fs.readFileSync(ENTRY, "utf8");
  for (const [from, after] of pairs) {
    const fresh = text.replace(from, after);
    assert.notEqual(fresh, text, `the place "${String(from).slice(0, 60)}" has moved — the sabotage does not bite`);
    text = fresh;
  }
  const p = path.join(w.base, name);
  fs.writeFileSync(p, text, { mode: 0o755 });
  return p;
}

// ── Promises ──

test("both shells exist (the image runs bash 5.2, the gate bash 3.2; dash for portability)", () => {
  for (const s of SHELLS) assert.ok(fs.existsSync(s), `${s} missing`);
  assert.ok((fs.statSync(ENTRY).mode & 0o111) === 0o111, "the entrypoint is not executable");
});

for (const shell of SHELLS) {
  test(`${shell}: leftovers before dockerd, cgroup, pool 24, DNAT only after "info answers" and the jump, TERM reaches dockerd`, async () => {
    const w = build((w) => { for (const f of LEFTOVERS) fs.writeFileSync(path.join(w.root, f), "999999\n"); fs.writeFileSync(path.join(w.root, "run/cbase-projectbox.status"), "phase=prestart\nnotice=old\n"); });
    try {
      const r = await run(w, { shell });
      checkRun(r, w);
      for (const f of LEFTOVERS) assert.equal(fs.existsSync(path.join(w.root, f)), false, f);
      assert.ok(idx(r.log, /^rm -f .*docker\.pid/) < idx(r.log, "dockerd start"), "leftovers removed only after dockerd");
    } finally { way(w); }
  });

  test(`${shell}: CBASE_DNAT_LIMIT=0 sets the measured form (without -i, without port limit)`, async () => {
    const w = build();
    try {
      checkRun(await run(w, { shell, env: { CBASE_DNAT_LIMIT: "0" } }), w, { limit: false });
    } finally { way(w); }
  });

  test(`${shell}: INT to the script goes as TERM to dockerd`, async () => {
    const w = build();
    try {
      checkRun(await run(w, { shell, signal: "SIGINT" }), w, { signal: "SIGINT" });
    } finally { way(w); }
  });

  test(`${shell}: without a pool (or with one that is no CIDR) exit ≠ 0 and no dockerd`, async () => {
    for (const pool of ["", "10.241.0.0", '10.0.0.0/8", "x": "y']) {
      const w = build();
      try {
        const r = await run(w, { shell, signal: null, env: { CBASE_DOCKER_POOL: pool } });
        assert.equal(r.code, 64, r.err);
        assert.equal(r.log.some((z) => z.startsWith("dockerd")), false, `dockerd despite missing pool "${pool}"`);
        assert.equal(fs.existsSync(path.join(w.root, "etc/docker/daemon.json")), false);
        assert.match(r.status, /^phase=error\nnotice=pool: /);
      } finally { way(w); }
    }
  });

  test(`${shell}: an iptables error does not end with exit ≠ 0 and fills the status file`, async () => {
    const w = build();
    try {
      const r = await run(w, { shell, env: { FAKE_IPTABLES_ERROR: "1" } });
      assert.match(r.statusBeforeSignal, /^phase=error\nnotice=dnat: iptables -t nat -A OUTPUT .* — iptables: No chain\/target\/match by that name\.\n$/, r.statusBeforeSignal);
      assertEnd(r, "SIGTERM");
    } finally { way(w); }
  });

  test(`${shell}: if the jump PREROUTING → DOCKER is missing, no PREROUTING rule comes (status error, the container runs)`, async () => {
    const w = build();
    try {
      const r = await run(w, { shell, env: { FAKE_JUMP: "0" } });
      assert.match(r.statusBeforeSignal, /^phase=error\nnotice=dnat: the jump PREROUTING → DOCKER/);
      assert.deepEqual(r.log.filter((z) => z.includes("-A PREROUTING")), []);
      assert.ok(r.log.includes(RULES.common[0]), "the backend rule (OUTPUT) does not depend on the jump");
      assertEnd(r, "SIGTERM");
    } finally { way(w); }
  });

  test(`${shell}: EBUSY when writing the controllers ⇒ move to init again, new attempt; dockerd starts with delegation`, async () => {
    const w = build();
    try {
      const r = await run(w, { shell, env: { FAKE_SED_ERROR: "2" } });
      checkRun(r, w);
      assert.equal(r.log.filter((z) => z.startsWith("sed ")).length, 3, "three attempts expected");
      assert.equal(r.log.filter((z) => z.startsWith("xargs ")).length, 3, "before every attempt a new move to init");
      assert.ok(r.log.lastIndexOf(r.log.filter((z) => z.startsWith("sed ")).pop()) < idx(r.log, "dockerd start"), "cgroup after dockerd");
      assert.match(r.err, /cgroup: subtree_control written on attempt 3/);
    } finally { way(w); }
  });

  test(`${shell}: if it fails five times, phase=error (cgroup) stands until the end, also after "info answers" and DNAT; dockerd runs, TERM reaches it`, async () => {
    const w = build((w) => fs.writeFileSync(w.gate, "")); // `docker info` answers as soon as dockerd stands
    try {
      const lastRule = RULES.limit[RULES.limit.length - 1];
      const r = await run(w, { shell, env: { FAKE_SED_ERROR: "99" }, beforeSignal: (w) => rows(w).includes(lastRule) });
      checkCgroupError(r);
      assertEnd(r, "SIGTERM");
    } finally { way(w); }
  });

  test(`${shell}: at the cap of the waiting no DNAT, status error — but no end (unless-stopped would loop otherwise)`, async () => {
    const w = build();
    try {
      const r = await run(w, { shell, gate: false, env: { CBASE_PROJECTBOX_ATTEMPTS: "3" } });
      assert.match(r.statusBeforeSignal, /^phase=error\nnotice=info: docker info does not answer after 3 attempts \(cap\)/);
      assert.equal(r.log.filter((z) => z.startsWith("docker info")).length, 3);
      assert.deepEqual(r.log.filter(isNat), []);
      assertEnd(r, "SIGTERM");
    } finally { way(w); }
  });
}

// ── Counter-tests: sabotaged copies turn the check red ──

test("counter-test: a version with `exec dockerd` has no DNAT row", async () => {
  const w = build();
  try {
    const copy = sabotage(w, "exec-dockerd.sh", ["dockerd &\n", "exec dockerd\n"]);
    const r = await run(w, { script: copy });
    assert.equal(r.milestone, "exec");
    assert.deepEqual(r.log.filter(isNat), []);
    assert.throws(() => checkRun(r, w), assert.AssertionError);
  } finally { way(w); }
});

test("counter-test: without the rm step the fake dockerd aborts with \"pid file found\"", async () => {
  const w = build((w) => { for (const f of LEFTOVERS) fs.writeFileSync(path.join(w.root, f), "999999\n"); });
  try {
    const copy = sabotage(w, "without-rm.sh", [/^rm -f "\$W\/var\/run\/docker\.pid".*\n/m, ""]);
    const r = await run(w, { script: copy });
    assert.ok(r.log.includes("dockerd pid file found"));
    assert.equal(r.code, 1, "the code of dockerd (1) did not come through");
    assert.match(r.status, /phase=ended/);
    assert.throws(() => checkRun(r, w), assert.AssertionError);
  } finally { way(w); }
});

test("counter-test: -I instead of -A at PREROUTING is red", async () => {
  const w = build();
  try {
    const copy = sabotage(w, "with-I.sh", [/-A PREROUTING/g, "-I PREROUTING"]);
    const r = await run(w, { script: copy });
    assert.ok(r.log.some((z) => z.startsWith("iptables -t nat -I PREROUTING")));
    assert.throws(() => checkRun(r, w), assert.AssertionError);
  } finally { way(w); }
});

test("counter-test: a fatal DNAT error (without the capsule) is red", async () => {
  const w = build();
  try {
    const copy = sabotage(w, "dnat-fatal.sh", ["  if dnat; then\n", "  dnat\n  if true; then\n"]);
    const r = await run(w, { script: copy, env: { FAKE_IPTABLES_ERROR: "1" } });
    assert.throws(() => assertEnd(r, "SIGTERM"), assert.AssertionError);
  } finally { way(w); }
});

test("counter-test: without trap the script dies on TERM, dockerd stays as an orphan — red", async () => {
  const w = build();
  try {
    const copy = sabotage(w, "without-trap.sh", [/^trap 'passOn 143' TERM\n/m, ""]);
    const r = await run(w, { script: copy });
    assert.equal(r.sig, "SIGTERM");
    assert.throws(() => checkRun(r, w), assert.AssertionError);
  } finally { way(w); }
});

test("counter-test: DNAT without waiting for `docker info` is red", async () => {
  const w = build();
  try {
    const copy = sabotage(w, "without-info.sh", ["  if docker info >/dev/null 2>&1; then READY=1; break; fi\n", "  READY=1; break\n"]);
    const r = await run(w, { script: copy });
    assert.equal(r.milestone, "status");
    assert.ok(r.natBeforeInfo.length > 0);
    assert.throws(() => checkRun(r, w), assert.AssertionError);
  } finally { way(w); }
});

test("counter-test: the state before the cgroup retry (BEFORE_PC_7) dies at the first EBUSY before dockerd, the status file stays on phase=start", async () => {
  const w = build();
  try {
    const old = withoutFix([CGROUP_TODAY, CGROUP_BEFORE_PC_7]);
    assert.ok(!old.includes("! cgroup_nest"), "the rebuilt script is not the state before the cgroup retry");
    const copy = path.join(w.base, "entry-before-pc7.sh");
    fs.writeFileSync(copy, old, { mode: 0o755 });
    const r = await run(w, { script: copy, env: { FAKE_SED_ERROR: "1" } });
    assert.equal(r.milestone, "end");
    assert.notEqual(r.code, 0);
    assert.equal(r.log.some((z) => z.startsWith("dockerd start")), false, "the old state started dockerd after all");
    assert.match(r.status, /^phase=start\n/);
    assert.throws(() => checkRun(r, w), assert.AssertionError);
  } finally { way(w); }
});

test("counter-test: if TERM does not reach dockerd, the run turns red instead of hanging — dockerd ends via the ripcord", async () => {
  const w = build();
  try {
    const copy = sabotage(w, "without-pass-on.sh", ['    kill -TERM "$DOCKERD_PID" 2>/dev/null || :\n', "    :\n"]);
    const r = await run(w, { script: copy, env: { FAKE_RIPCORD_S: "1" } });
    assert.ok(r.ripcord.includes("ripcord: dockerd got no TERM"), JSON.stringify(r.ripcord));
    assert.throws(() => assertEnd(r, "SIGTERM"), assert.AssertionError);
  } finally { way(w); }
});

test("counter-test: if the script does not end after dockerd, the run turns red instead of hanging — the watchdog reports it", async () => {
  const w = build();
  try {
    const copy = sabotage(w, "ends-not.sh", ['log "dockerd ended with $rc"\n', 'sleep 100000\nlog "dockerd ended with $rc"\n']);
    const r = await run(w, { script: copy, env: { FAKE_RIPCORD_TICKS: "20" } });
    assert.ok(r.log.includes("dockerd TERM"), "TERM reached dockerd — the regression lies after it");
    assert.deepEqual(r.ripcord, ["ripcord: the script lives after dockerd ended"]);
    assert.equal(r.code, null, "the script was still alive when the test went on");
    assert.throws(() => assertEnd(r, "SIGTERM"), assert.AssertionError);
  } finally { way(w); }
});

// ── The overlay stage of a copy (step 3a) ──

const Z = "/home/agent/ws/with space/proj"; // a project folder with a space (mountinfo masks it as \040)
// Deliberately NOT outer before inner: the script sorts itself.
const OVERLAYS = [
  [`${Z}/.git/objects`, "/cbase-copy/objects/p", "/cbase-copy/layer/p.objects", "/cbase-copy/work/p.objects"],
  [`${Z}/repo`, `/cbase-main${Z}/repo`, "/cbase-copy/layer/r0", "/cbase-copy/work/r0"],
  [Z, `/cbase-main${Z}`, "/cbase-copy/layer/p", "/cbase-copy/work/p"],
  ["/home/agent/.local", "/home/agent/.cbase/runtime/home/.local", "/cbase-copy/layer/local", "/cbase-copy/work/local"],
];
const ORDER = ["/home/agent/.local", Z, `${Z}/.git/objects`, `${Z}/repo`]; // C locale: "." < "w", "\t" < "/"
const tsv = (rows) => rows.map((z) => `${z.join("\t")}\n`).join("");
const masked = (p) => p.replace(/\\/g, "\\134").replace(/ /g, "\\040").replace(/\t/g, "\\011").replace(/\n/g, "\\012");
const FOREIGN = (wu) => ["/", `${wu}/home/agent/.cache/npm`, `${wu}/cbase-mainstuff`];
const RAW = (wu) => [`${wu}/cbase-copy`, `${wu}/cbase-copy/layer`, `${wu}/cbase-main${Z}`];
const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// An entry is a path (an ext4 mount like a bind from the Docker configuration) or { path, type, source, options }.
function writeMountinfo(w, paths) {
  const d = path.join(w.root, "proc/self");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "mountinfo"), paths.map((p, i) => (typeof p === "string"
    ? `${100 + i} 1 0:${50 + i} / ${masked(p)} rw,relatime - ext4 /dev/vda1 rw\n`
    : `${100 + i} 1 0:${50 + i} / ${masked(p.path)} rw,relatime shared:${i} - ${p.type} ${p.source} ${p.options}\n`)).join(""));
}
// The kernel masks the superblock options like paths, plus the comma (seq_show_option: ", \t\n\\").
const optMasked = (p) => masked(p).replace(/,/g, "\\054");
// The overlay of a row of OVERLAYS as mountinfo shows it (layers under the root w); `different` shifts upperdir.
const overlayEntry = (wu, [target, bottom, top, work], { different = false } = {}) => ({
  path: `${wu}${target}`, type: "overlay", source: "overlay",
  options: `rw,relatime,lowerdir=${optMasked(wu + bottom)},upperdir=${optMasked(wu + top + (different ? "-other" : ""))},workdir=${optMasked(wu + work)},userxattr`,
});
const pathOf = (e) => (typeof e === "string" ? e : e.path);
const mountinfoPaths = (w) => read(path.join(w.root, "proc/self/mountinfo")).split("\n").filter(Boolean)
  .map((z) => z.split(" ")[4].replace(/\\(040|011|012|134)/g, (_, c) => String.fromCharCode(parseInt(c, 8))));

// A copy: overlays.tsv (text), optionally .prepared, mountinfo with raw roots and foreign mounts.
function copyBuild({ file = tsv(OVERLAYS), prepared = true, mounted = [], raw = RAW, foreign = FOREIGN } = {}) {
  return build((w) => {
    fs.mkdirSync(path.join(w.root, "cbase-copy"), { recursive: true });
    if (file !== null) fs.writeFileSync(path.join(w.root, "cbase-copy/overlays.tsv"), file);
    if (prepared) fs.writeFileSync(path.join(w.root, "cbase-copy/.prepared"), "");
    fs.writeFileSync(path.join(w.base, "mounted"), mounted.map((p) => `${w.root}${p}\n`).join(""));
    writeMountinfo(w, [...foreign(w.root), ...raw(w.root)]);
  });
}
const mountRow = (w, [target, bottom, top, work]) =>
  `mount LIBMOUNT_FORCE_MOUNT2=always -t overlay overlay -o userxattr,lowerdir=${w.root}${bottom},upperdir=${w.root}${top},workdir=${w.root}${work} ${w.root}${target}`;
const rowFor = (target) => OVERLAYS.find((z) => z[0] === target);

// The promises for a copy run that reaches dockerd — as a function so that the same check turns red on sabotage.
function checkCopy(r, w, { without = [], waited = null, foreign = FOREIGN } = {}) {
  const p = r.log;
  const text = `\n${p.join("\n")}\n--- stderr\n${r.err}`;
  assert.deepEqual(p.filter((z) => z.startsWith("forbidden")), [], `a program from the PATH instead of the seam${text}`);
  const expected = ORDER.filter((z) => !without.includes(z)).map((z) => mountRow(w, rowFor(z)));
  assert.deepEqual(p.filter((z) => z.startsWith("mount ")), expected, `overlays (exactly once, outer before inner)${text}`);
  for (const z of ORDER) assert.ok(fs.statSync(`${w.root}${z}`).isDirectory(), `${z} not created`);
  const iDockerd = idx(p, "dockerd start");
  const iLastMount = p.map((z) => z.startsWith("mount ")).lastIndexOf(true);
  // inner before outer (copy/layer before copy), the masking \040 resolved.
  const umounts = p.filter((z) => z.startsWith("umount "));
  assert.deepEqual(umounts, RAW(w.root).slice().sort().reverse().map((q) => `umount -l ${q}`), `umount of the raw roots${text}`);
  assert.ok(p.findIndex((z) => z.startsWith("umount ")) > iLastMount, "umount before the last overlay");
  assert.ok(iDockerd > p.map((z) => z.startsWith("umount ")).lastIndexOf(true), `dockerd before the unmounting${text}`);
  assert.deepEqual(mountinfoPaths(w), foreign(w.root).map(pathOf), "foreign mounts touched or raw ones left");
  if (waited) {
    assert.match(waited.status, /^phase=prepare\nnotice=Overlays mounted, waiting for \/cbase-copy\/\.prepared\n$/);
    assert.deepEqual(waited.log.filter((z) => z.startsWith("mount ")), expected, "not all overlays were there while waiting");
    assert.equal(waited.log.some((z) => z.startsWith("umount ") || z.startsWith("dockerd")), false, "umount or dockerd before .prepared");
  }
  checkRun(r, w);
}

// A failed copy run: phase=error with the notice, NO daemon.json, NO dockerd, the script lived at the signal and ended at it
// (143 or 130) — not before, not with a code of its own.
function checkCopyError(r, w, notice, { signal = "SIGTERM" } = {}) {
  const text = `\n${r.log.join("\n")}\n--- stderr\n${r.err}`;
  assert.deepEqual(r.ripcord, [], `the stub pulled its ripcord — the script kept resting after the signal${text}`);
  assert.equal(r.milestone, "status", `no status "error" before the signal${text}`);
  assert.equal(r.wasAliveAtSignal, true, `the script ended before the signal (exit instead of resting)${text}`);
  assert.match(r.statusBeforeSignal, new RegExp(`^phase=error\\nnotice=${notice.source}`), `status file: ${r.statusBeforeSignal}`);
  assert.equal(r.log.some((z) => z.startsWith("dockerd") || z.startsWith("docker ")), false, `dockerd despite the error${text}`);
  assert.equal(fs.existsSync(path.join(w.root, "etc/docker/daemon.json")), false, "daemon.json despite the error");
  assert.deepEqual(r.log.filter((z) => z.startsWith("forbidden")), []);
  assert.equal(r.sig, null, `the script died of the signal ${r.sig}`);
  assert.equal(r.code, signal === "SIGINT" ? 130 : 143, `Code ${r.code}${text}`);
  assert.equal(r.status, r.statusBeforeSignal, "the status file changed after the signal");
}

// Normalized for comparing two runs: root, pids, and the waiting for the daemon. Every "docker info no" is dropped: how often
// it comes AND whether the first stands before or after "dockerd start" depends only on the clock (dockerd runs in the
// background, the wait loop in the foreground; under load both orders occur, per shell). The statement "waited until it
// answers" is carried by "docker info yes".
function norm(r, w) {
  const out = [];
  for (const z of r.log.map((x) => x.split(w.base).join("<B>").replace(/^dockerd start pid=\d+ ppid=\d+$/, "dockerd start"))) {
    if (z === "docker info no") continue;
    out.push(z);
  }
  // Mapping of the German notice wordings that the recorded old states still emit to today's English ones.
  const s = (t) => t.split(w.base).join("<B>").replace("eigene IP ", "own IP ").replace(", Backend ", ", backend ").replace(", Grenze ", ", limit ").replace("dockerd endete mit ", "dockerd ended with ");
  return { log: out, beforeSignal: s(r.statusBeforeSignal), status: s(r.status), code: r.code, sig: r.sig, milestone: r.milestone };
}
function sameFollowUp(fresh, wNew, old, wOld) {
  assert.deepEqual(norm(fresh, wNew), norm(old, wOld), "without overlays.tsv not the same sequence as without step 3a (BEFORE_ST2_0)");
}
// Without overlays.tsv, but with everything else a copy would have: .prepared, raw mounts under both roots.
const withoutFileBuild = () => copyBuild({ file: null });
function oldScript(w) {
  const old = withoutFix([STEP_3A_TODAY, ""]);
  assert.ok(!/^\s*if ! copy_prepare; then$/m.test(old), "the rebuilt script is not the state before step 3a");
  const p = path.join(w.base, "entry-before-st2-0.sh");
  fs.writeFileSync(p, old, { mode: 0o755 });
  return p;
}

for (const shell of SHELLS) {
  test(`${shell}: without overlays.tsv the same call sequence, status file and code as BEFORE_ST2_0 (also with mounts under /cbase-main)`, async () => {
    const wOld = withoutFileBuild();
    const wNew = withoutFileBuild();
    try {
      const old = await run(wOld, { shell, script: oldScript(wOld) });
      const fresh = await run(wNew, { shell });
      checkRun(fresh, wNew);
      sameFollowUp(fresh, wNew, old, wOld);
      assert.equal(fresh.log.some((z) => /^(mount|umount|mountpoint|forbidden)/.test(z)), false, "3a entered without the file");
      assert.deepEqual(mountinfoPaths(wNew), [...FOREIGN(wNew.root), ...RAW(wNew.root)], "something unmounted without the file");
    } finally { way(wOld); way(wNew); }
  });

  test(`${shell}: with overlays.tsv every overlay outer before inner before dockerd; without .prepared phase=prepare, only the gate frees dockerd; then the raw roots go`, async () => {
    const w = copyBuild({ prepared: false });
    let waited = null;
    try {
      const r = await run(w, {
        shell,
        during: (w) => {
          if (waited || phase(w) !== "prepare") return;
          waited = { status: read(w.status), log: rows(w) };
          fs.writeFileSync(path.join(w.root, "cbase-copy/.prepared"), ""); // the gate
        },
      });
      assert.ok(waited, "phase=prepare never seen");
      checkCopy(r, w, { waited });
    } finally { way(w); }
  });

  test(`${shell}: mountpoint -q prevents double mounting (if EXACTLY this overlay is mounted at the target, it stays as it is)`, async () => {
    const foreign = (wu) => [...FOREIGN(wu), overlayEntry(wu, rowFor(Z))];
    const w = copyBuild({ mounted: [Z], foreign });
    try {
      const r = await run(w, { shell });
      checkCopy(r, w, { without: [Z], foreign });
      assert.equal(r.log.filter((z) => z.startsWith("mountpoint -q ")).length, OVERLAYS.length, "not every target asked");
    } finally { way(w); }
  });

  test(`${shell}: if something else is mounted at the target (bind, other overlay, no entry): phase=error, no dockerd, never on without the overlay`, async () => {
    const cases = [
      ["bind from the Docker configuration", (wu) => [...FOREIGN(wu), `${wu}${Z}`], /already a mount point \(ext4 \/dev\/vda1\), not the overlay from overlays\.tsv/],
      ["overlay with another upper layer", (wu) => [...FOREIGN(wu), overlayEntry(wu, rowFor(Z), { different: true })], /already a mount point \(overlay overlay with other layers\)/],
      ["no entry in mountinfo", FOREIGN, /already a mount point \(no entry in \/proc\/self\/mountinfo\)/],
    ];
    for (const [what, foreign, notice] of cases) {
      const w = copyBuild({ mounted: [Z], foreign });
      try {
        const r = await run(w, { shell });
        checkCopyError(r, w, new RegExp(`overlay: ${re(Z)} — ${notice.source}`));
        // Outer before inner: /home/agent/.local comes before Z and is mounted; after Z nothing more, no umount.
        assert.deepEqual(r.log.filter((z) => z.startsWith("mount ")), [mountRow(w, rowFor("/home/agent/.local"))], what);
        assert.equal(r.log.some((z) => z.startsWith("umount ")), false, what);
      } finally { way(w); }
    }
  });

  test(`${shell}: if a mount fails: phase=error (overlay: <target>), no dockerd, no exit, the script lives until TERM`, async () => {
    const w = copyBuild();
    try {
      const r = await run(w, { shell, env: { FAKE_MOUNT_ERROR: `${Z}/repo` } });
      checkCopyError(r, w, new RegExp(`overlay: ${re(Z)}/repo — mount: .*wrong fs type`));
      assert.equal(r.log.filter((z) => z.startsWith("mount ")).length, 4, "mounted on after the error or stopped before");
      assert.equal(r.log.some((z) => z.startsWith("umount ")), false, "unmounted after a failed overlay");
    } finally { way(w); }
  });

  test(`${shell}: a broken overlays.tsv mounts NOTHING and starts nothing`, async () => {
    const cases = [
      ["", /overlay: \/cbase-copy\/overlays\.tsv without a line/],
      ["\n\n", /overlay: \/cbase-copy\/overlays\.tsv without a line/],
      [tsv([...OVERLAYS, ["/a", "/b", "/c"]]), /overlay: line “\/a\t\/b\t\/c” does not have four fields/],
      [tsv([...OVERLAYS, ["/a", "/b", "/c", "/d", "/e"]]), /overlay: line .* does not have four fields/],
      [tsv([...OVERLAYS, ["/a", "/b", "", "/d"]]), /overlay: \/a — “” is not an absolute path/],
      [tsv([...OVERLAYS, ["rel/a", "/b", "/c", "/d"]]), /overlay: rel\/a — “rel\/a” is not an absolute path/],
      [tsv([...OVERLAYS, ["/a", "/b", "/c,d", "/e"]]), /overlay: \/a — “\/c,d” contains ,/],
      [tsv([...OVERLAYS, ["/a", "/b:x", "/c", "/d"]]), /overlay: \/a — “\/b:x” contains : \(lowerdir/],
      [tsv([...OVERLAYS, ["/a", "/b", "/c\\x", "/d"]]), /overlay: \/a — “\/c\\x” contains ,/],
      [tsv([...OVERLAYS, ["/a", "/b", "/c\"x", "/d"]]), /overlay: \/a — “\/c"x” contains ,/],
      [tsv([...OVERLAYS, [Z, "/x", "/y", "/z"]]), new RegExp(`overlay: ${re(Z)} — appears twice in overlays\\.tsv`)],
    ];
    for (const [file, notice] of cases) {
      const w = copyBuild({ file });
      try {
        const r = await run(w, { shell });
        checkCopyError(r, w, notice);
        assert.equal(r.log.some((z) => /^(mount|umount|mountpoint) /.test(z)), false, `mounted after all with ${JSON.stringify(file.slice(-30))}`);
      } finally { way(w); }
    }
    for (const kind of ["folder", "dead-link"]) {
      const w = copyBuild({ file: null });
      const t = path.join(w.root, "cbase-copy/overlays.tsv");
      if (kind === "folder") fs.mkdirSync(t); else fs.symlinkSync(path.join(w.base, "exists-not"), t);
      try {
        checkCopyError(await run(w, { shell }), w, /overlay: \/cbase-copy\/overlays\.tsv is not a readable file/);
      } finally { way(w); }
    }
  });

  test(`${shell}: cap of the waiting for .prepared, failed umount, ineffective umount, line break in mountinfo: each phase=error, no dockerd`, async () => {
    const cases = [
      [{ prepared: false }, { CBASE_PROJECTBOX_PREPARE_S: "0" }, /prepare: \/cbase-copy\/\.prepared not there after 0 s \(cap CBASE_PROJECTBOX_PREPARE_S\)/, 0],
      [{}, { FAKE_UMOUNT_ERROR: "/cbase-copy" }, /unmount: \/cbase-copy — umount: .*target is busy\./, 3],
      [{}, { FAKE_UMOUNT_INEFFECTIVE: "1" }, new RegExp(`unmount: still mounted afterwards: /cbase-copy /cbase-copy/layer /cbase-main${re(Z)} ?\\n`), 3],
      [{ raw: (wu) => [...RAW(wu), `${wu}/cbase-main/a\nb`] }, {}, /unmount: a mount point below \/cbase-copy or \/cbase-main contains a newline/, 0],
    ];
    for (const [on, env, notice, umounts] of cases) {
      const w = copyBuild(on);
      try {
        const r = await run(w, { shell, env });
        checkCopyError(r, w, notice);
        assert.equal(r.log.filter((z) => z.startsWith("mount ")).length, 4, "not all overlays before the error");
        assert.equal(r.log.filter((z) => z.startsWith("umount ")).length, umounts, JSON.stringify(env));
      } finally { way(w); }
    }
  });
}

test("INT in the error state ends the script with 130", async () => {
  const w = copyBuild();
  try {
    checkCopyError(await run(w, { signal: "SIGINT", env: { FAKE_MOUNT_ERROR: Z } }), w, /overlay: /, { signal: "SIGINT" });
  } finally { way(w); }
});

// ── Counter-tests of step 3a ──

test("counter-test: a version that enters 3a even without overlays.tsv breaks the same sequence — red", async () => {
  const wOld = withoutFileBuild();
  const wNew = withoutFileBuild();
  try {
    const old = await run(wOld, { script: oldScript(wOld) });
    const copy = sabotage(wNew, "always-3a.sh", ['if [ -e "$OVERLAYS" ] || [ -L "$OVERLAYS" ]; then\n', "if true; then\n"]);
    const fresh = await run(wNew, { script: copy });
    assert.throws(() => sameFollowUp(fresh, wNew, old, wOld), assert.AssertionError);
  } finally { way(wOld); way(wNew); }
});

test("counter-test: without sorting the file mounts inner before outer — red", async () => {
  const w = copyBuild();
  try {
    const copy = sabotage(w, "without-sort.sh", ['ov_list=$(LC_ALL=C sort -- "$OVERLAYS")', 'ov_list=$(cat -- "$OVERLAYS")']);
    const r = await run(w, { script: copy });
    assert.throws(() => checkCopy(r, w), /outer before inner/);
  } finally { way(w); }
});

test("counter-test: without mountpoint -q an already mounted target is mounted twice — red", async () => {
  const foreign = (wu) => [...FOREIGN(wu), overlayEntry(wu, rowFor(Z))];
  const w = copyBuild({ mounted: [Z], foreign });
  try {
    const copy = sabotage(w, "without-mountpoint.sh", ['    if "$MOUNTPOINT_BIN" -q "$W$ov_z" 2>/dev/null; then\n', "    if false; then\n"]);
    const r = await run(w, { script: copy });
    assert.throws(() => checkCopy(r, w, { without: [Z], foreign }), /exactly once/);
  } finally { way(w); }
});

test("counter-test: the state BEFORE_GL_E skipped a target with a bind and started dockerd — red", async () => {
  const w = copyBuild({ mounted: [Z], foreign: (wu) => [...FOREIGN(wu), `${wu}${Z}`] });
  try {
    const old = withoutFix([TARGET_CHECK_TODAY, SKIP_BEFORE_GL_E]);
    assert.ok(!old.includes("ov_actual=$(target_mount"), "the rebuilt script still has the check");
    const script = path.join(w.base, "entry-before-gl-e.sh");
    fs.writeFileSync(script, old, { mode: 0o755 });
    const r = await run(w, { script });
    assert.ok(r.log.some((z) => z.startsWith("dockerd")), `the old state did not reach dockerd — the counter-test does not bite\n${r.log.join("\n")}`);
    assert.throws(() => checkCopyError(r, w, /overlay: /), assert.AssertionError);
  } finally { way(w); }
});

test("counter-test: `exit 1` instead of resting ends before the signal with exit ≠ 0 — red", async () => {
  const w = copyBuild();
  try {
    const copy = sabotage(w, "exit-1.sh", ["    without_dockerd_rest\n", "    exit 1\n"]);
    const r = await run(w, { script: copy, env: { FAKE_MOUNT_ERROR: Z } });
    assert.equal(r.code, 1);
    assert.throws(() => checkCopyError(r, w, /overlay: /), assert.AssertionError);
  } finally { way(w); }
});

test("counter-test: without `exit` in the trap the script keeps resting after the signal — the ripcord turns it red instead of hanging", async () => {
  const w = copyBuild();
  try {
    const copy = sabotage(w, "rests-continue.sh", ['    [ -z "$QUIET_PID" ] || kill "$QUIET_PID" 2>/dev/null || :\n    exit "$1"\n', '    [ -z "$QUIET_PID" ] || kill "$QUIET_PID" 2>/dev/null || :\n']);
    const r = await run(w, { script: copy, env: { FAKE_MOUNT_ERROR: Z, FAKE_RIPCORD_S: "1" } });
    // At least one line (if it keeps resting, it sleeps again — a second may already stand by the time the test reads it).
    assert.ok(r.ripcord.length >= 1, JSON.stringify(r.ripcord));
    assert.ok(r.ripcord.every((z) => z === "ripcord: the script keeps resting without dockerd although a signal came"), JSON.stringify(r.ripcord));
    assert.equal(r.code, null, "the script was still alive when the test went on");
    assert.throws(() => checkCopyError(r, w, /overlay: /), assert.AssertionError);
  } finally { way(w); }
});
