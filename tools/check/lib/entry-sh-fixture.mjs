// Test fixture shared by entry-sh.test.mjs (public: server/backend/entry.sh in both shells against fakes) and entry-sh.ops.test.mjs
// (private: the retreat the deploy tool writes, run through the same harness). Fake iptables/docker/setpriv, the working folder `build`,
// `run` of the script, the states of the entry script before its fixes (rebuilt from today's script, the oldest one recorded).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_PREFIX } from "../../../server/backend/electron/server/projectbox/creation.js";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../../..");
export const ENTRY = path.join(REPO, "server/backend/entry.sh");
// The last state BEFORE the network separation — a fixed commit, not HEAD: after its commit HEAD would be the new version, and the
// counter-proof would check itself.
export const BEFORE_S1_3 = "4f1eb0d80f20bd12f8aca6f5934860173e5c86d2";
// The last state BEFORE the login-variable fix — fixed, for the same reason.
export const BEFORE_PB_1 = "88969b1aab4ceaae79064dac7501c50d8187ec47";
// The last state BEFORE the missing-marker stop — fixed, for the same reason.
export const BEFORE_PB_6 = "17bb7a66bebbcdce4568e23acee3bd9aada46bdd";
// The last state BEFORE the thaw of paused containers — fixed, for the same reason.
export const BEFORE_ST2_3 = "7013a14";
export const SHELLS = ["/bin/bash", "/bin/dash"];
// The ONE jump of the separation — over the bridge prefix of the backend (projectbox/creation.js BRIDGE_PREFIX, `cbp-`): a project
// network whose bridge entry.sh does not match stands unprotected.
export const JUMP = `-A INPUT -i ${BRIDGE_PREFIX}+ -j CBASE-PROJ`;
export const START = "4242";
export const STAT = `1 (docker-init) S 0 1 1 0 -1 4194560 1060 0 0 0 1 2 0 0 20 0 1 0 ${START} 1150976 1 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n`;

// The real rm/chmod only on paths under the test root: a script that does NOT prefix a path (the state before the separation
// does not know the seam) would otherwise touch the machine's /var/run/docker.sock.
export const ONLY_IN_THE_ROOT =
  `for a in "$@"; do case "$a" in /*) case "$a" in "$FAKE_BASE"/*) ;; *) echo "outside the test root: $a" >&2; exit 97;; esac;; esac; done`;

export const FAKES = {
  id: `[ "$1" = "-u" ] && { printf '%s\\n' "\${FAKE_UID:-0}"; exit 0; }; exit 0`,
  dockerd: "exit 0",
  setpriv: `printf '%s' "\${CLAUDE_SECURESTORAGE_CONFIG_DIR-<unset>}" > "$FAKE_BASE/setpriv-var"; exit 0`,
  node: "exit 0",
  chown: "exit 0",
  chgrp: `exit "\${FAKE_EXIT_CHGRP:-0}"`,
  chmod: `[ "\${FAKE_EXIT_CHMOD:-0}" = 0 ] || exit "$FAKE_EXIT_CHMOD"\n${ONLY_IN_THE_ROOT}\nexec /bin/chmod "$@"`,
  rm: `${ONLY_IN_THE_ROOT}\nexec /bin/rm "$@"`,
  docker: [
    `case "$1" in`,
    `  info) exit "\${FAKE_DOCKER_INFO:-0}";;`,
    // `status=paused` reports only what FAKE_PAUSED names (else nothing) — every other ps both.
    `  ps) case "$*" in *status=paused*) [ -z "\${FAKE_PAUSED:-}" ] || printf '%s\\n' $FAKE_PAUSED;; *) printf '%s\\n' c-one c-two;; esac;;`,
    `esac`,
    `exit 0`,
  ].join("\n"),
  // Stateful: every chain as "-N <chain>", every rule as "-A <chain> …" in $FAKE_IPT, file order = rule order of a chain.
  // -I inserts at the start.
  iptables: [
    `[ "\${FAKE_EXIT_IPTABLES:-0}" = 0 ] || exit "$FAKE_EXIT_IPTABLES"`,
    `st="$FAKE_IPT"; touch "$st"`,
    `case "$1" in`,
    `  -N) grep -qxF -- "-N $2" "$st" && exit 1; printf '%s\\n' "-N $2" >> "$st";;`,
    `  -F) grep -qxF -- "-N $2" "$st" || exit 1; grep -vF -- "-A $2 " "$st" > "$st.t"; mv "$st.t" "$st";;`,
    `  -A) shift; printf '%s\\n' "-A $*" >> "$st";;`,
    `  -I) shift; { printf '%s\\n' "-A $*"; cat "$st"; } > "$st.t"; mv "$st.t" "$st";;`,
    `  -C) shift; grep -qxF -- "-A $*" "$st"; exit $?;;`,
    `  *) exit 2;;`,
    `esac`,
  ].join("\n"),
};

export function fakeBin(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(FAKES)) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$FAKE_LOG"\n${body}\n`);
    fs.chmodSync(f, 0o755);
  }
}

// A fresh setup: root (etc, run, var, proc), home, log. `prior(w)` creates the initial state.
export function build(prior) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-entry-"));
  const w = {
    base,
    root: path.join(base, "root"),
    home: path.join(base, "home"),
    bin: path.join(base, "bin"),
    log: path.join(base, "log"),
    ipt: path.join(base, "iptables"),
  };
  w.login = path.join(w.home, ".claude-login");
  w.old = path.join(w.home, ".claude", ".credentials.json");
  w.fresh = path.join(w.login, ".credentials.json");
  w.marker = path.join(w.root, "run/cbase/network-separation.ok");
  w.bEnds = path.join(w.root, "run/cbase/b-ends"); // the gateway's "B ends" marker
  w.hosts = path.join(w.root, "etc/hosts");
  for (const d of ["etc", "run/docker/containerd", "var/run", "var/log", "proc/1"]) fs.mkdirSync(path.join(w.root, d), { recursive: true });
  fs.writeFileSync(w.hosts, "127.0.0.1 localhost\n");
  fs.writeFileSync(path.join(w.root, "proc/1/stat"), STAT);
  fs.mkdirSync(w.home);
  fs.writeFileSync(w.log, "");
  fakeBin(w.bin);
  if (prior) prior(w);
  return w;
}

export function run(w, { shell = "/bin/bash", script = ENTRY, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const subprocess = spawn(shell, [script], {
      env: {
        PATH: `${w.bin}:/usr/bin:/bin`,
        HOME: w.home,
        CBASE_DIND: "1",
        CBASE_ENTRY_ROOT: w.root,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: w.login,
        FAKE_LOG: w.log,
        FAKE_IPT: w.ipt,
        FAKE_BASE: w.base,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    subprocess.stdout.on("data", (b) => (out += b));
    subprocess.stderr.on("data", (b) => (err += b));
    subprocess.on("error", reject);
    subprocess.on("close", (code) => {
      const log = fs.readFileSync(w.log, "utf8").split("\n").filter(Boolean);
      const rules = fs.existsSync(w.ipt) ? fs.readFileSync(w.ipt, "utf8").split("\n").filter(Boolean) : [];
      resolve({ code, out, err, log, rules });
    });
  });
}

export const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
export const way = (w) => fs.rmSync(w.base, { recursive: true, force: true });
export const index = (p, pattern) => p.findIndex((z) => (typeof pattern === "string" ? z.startsWith(pattern) : pattern.test(z)));

// Everything under the home, without following: kind, mode, content or link target, mtime.
export function snapshot(dir) {
  const out = {};
  const run = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      const rel = path.relative(dir, p);
      if (st.isSymbolicLink()) out[rel] = { kind: "link", target: fs.readlinkSync(p), mtime: st.mtimeMs };
      else if (st.isDirectory()) { out[rel] = { kind: "dir", mode: st.mode & 0o777 }; run(p); }
      else out[rel] = { kind: "file", mode: st.mode & 0o777, content: fs.readFileSync(p, "utf8"), mtime: st.mtimeMs, links: st.nlink };
    }
  };
  run(dir);
  return out;
}

export const WRONG = (t) => JSON.stringify({ claudeAiOauth: { accessToken: `wrong-${t}`, refreshToken: "wrong", expiresAt: 1 } });
export function file(p, content, { mtime = null, mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, { mode });
  if (mtime !== null) fs.utimesSync(p, mtime, mtime);
}
// The value of the variable that setpriv (so the backend and everything it starts) sees; null = setpriv not reached.
export const varAtSetpriv = (w) => (exists(path.join(w.base, "setpriv-var")) ? fs.readFileSync(path.join(w.base, "setpriv-var"), "utf8") : null);
export const aside = (w) => fs.readdirSync(w.login).filter((n) => n.startsWith(".credentials.json.aside-"));

// The entry script at BEFORE_S1_3 (before the network separation), word for word without its comments: the inner dockerd, then
// the switch to agent — no chain, no permission, no marker, no login relocation.
const ENTRY_BEFORE_S1_3 = [
  "#!/bin/bash",
  "set -e",
  "",
  'if [ "${CBASE_DIND:-0}" = "1" ] && [ "$(id -u)" = "0" ]; then',
  "  rm -f /var/run/docker.pid /run/docker/containerd/containerd.pid /var/run/docker.sock",
  "  dockerd >/var/log/dockerd.log 2>&1 &",
  "fi",
  "",
  "exec setpriv --reuid=agent --regid=agent --init-groups node /app/headless.js",
  "",
].join("\n");

// The promises about ONE successful run — as a function, so the same check turns red on the old version. The state before the
// separation does not know the root seam: rewrite its absolute paths for the run in the fake (otherwise the rm guard would abort
// it before setpriv, and the counter-proof would check an abort instead of the version).
export function oldRevision() {
  const old = ENTRY_BEFORE_S1_3;
  assert.ok(!/iptables|chgrp|credentials/.test(old), "the fixture is not the state before the separation");
  const rewritten = old.replace(/(^|[\s>])\/(var\/run|run|var\/log)\//gm, "$1$CBASE_ENTRY_ROOT/$2/");
  assert.notEqual(rewritten, old, "the paths of the old version were not rewritten");
  return rewritten;
}

// Today's entry script with one fix taken out again — the state before that fix as far as the counter-proof needs it. Each
// replacement must bite (otherwise the place has moved and the counter-proof would check today's script).
function withoutFix(...pairs) {
  let text = fs.readFileSync(ENTRY, "utf8");
  for (const [from, to] of pairs) {
    const fresh = text.replace(from, to);
    assert.notEqual(fresh, text, `the place "${String(from).slice(0, 60)}" has moved — the counter-proof does not bite`);
    text = fresh;
  }
  return text;
}
// BEFORE_PB_6: a missing marker was only reported (`network_marker_write || echo …`), the project containers kept running.
export const entryBeforePb6 = () => withoutFix([/ {4}network_marker_write \|\| \{\n {6}echo ("[^\n]*") >&2\n {6}project_container_stop\n {4}\}\n/,
  "    network_marker_write || echo $1 >&2\n"]);
// BEFORE_ST2_3: the stop of the project containers without thawing the paused ones first.
export const entryBeforeSt23 = () => withoutFix([/ {6}ps_paused=\$\(docker ps [^\n]*\n {6}if \[ -n "\$ps_paused" \]; then\n(?: {8}[^\n]*\n)+ {6}fi\n/, ""]);
// BEFORE_PB_1: after an early abort of the login relocation the login variable was passed on (pointing at a directory without
// the login).
export const entryBeforePb1 = () => withoutFix([/ {2}if \[ -n "\$\{CLAUDE_SECURESTORAGE_CONFIG_DIR:-\}" \] && \[ ! -e [^\n]*\n(?: {4}[^\n]*\n)+ {2}fi\n/, ""]);

// dockerd runs in the background: the child writes its log line whenever it is due — measured even AFTER chgrp. Only "after the
// last iptables" is certain (it starts only then); "before chgrp" is checked by the source order in the script.
export function checkSeparation(r, w, scriptText = fs.readFileSync(ENTRY, "utf8")) {
  const all = r.log;
  const iDockerd = index(all, "dockerd");
  const iLastIpt = all.map((z) => z.startsWith("iptables ")).lastIndexOf(true);
  assert.ok(iDockerd >= 0 && iLastIpt >= 0 && iLastIpt < iDockerd, `dockerd started before the separation:\n${all.join("\n")}`);
  const p = all.filter((z) => !z.startsWith("dockerd"));
  const iRm = index(p, /^rm -f .*network-separation\.ok/);
  const iIpt = index(p, "iptables ");
  const iChgrp = index(p, `chgrp agent ${w.hosts}`);
  const iChmod = index(p, `chmod g+w ${w.hosts}`);
  const iSetpriv = index(p, "setpriv ");
  assert.ok(iRm >= 0, `no rm of the marker in the log:\n${all.join("\n")}`);
  assert.ok(iRm < iIpt && iIpt < iChgrp && iChgrp < iChmod && iChmod < iSetpriv,
    `order leftovers → iptables → chgrp/chmod → setpriv violated:\n${all.join("\n")}`);
  assert.equal(iSetpriv, p.length - 1, "setpriv is not the last step");
  const q = { separation: scriptText.indexOf("if network_separation"), dockerd: scriptText.indexOf("dockerd >"), hosts: scriptText.indexOf("chgrp agent") };
  assert.ok(q.separation >= 0 && q.separation < q.dockerd && q.dockerd < q.hosts, `source order separation → dockerd → /etc/hosts: ${JSON.stringify(q)}`);
  assert.deepEqual(r.rules.filter((z) => z.startsWith("-A CBASE-PROJ") || z === "-N CBASE-PROJ"), [
    "-N CBASE-PROJ",
    "-A CBASE-PROJ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
    "-A CBASE-PROJ -p tcp --dport 7718 -j ACCEPT",
    "-A CBASE-PROJ -p tcp -j REJECT --reject-with tcp-reset",
  ], "chain or rule order");
  assert.deepEqual(r.rules.filter((z) => z.startsWith("-A INPUT")), [JUMP], "the jump exactly once");
  assert.ok(!p.some((z) => z.includes("br-")), "a rule for br-* would cut off today's stacks");
  assert.equal(fs.readFileSync(w.marker, "utf8").trim(), START, "the marker does not carry the start time of PID 1");
  assert.equal(fs.statSync(w.marker).mode & 0o777, 0o644, "the marker is not readable for agent");
  assert.ok(!p.some((z) => z.startsWith("docker stop")), "with separation nothing is stopped");
  assert.equal(fs.statSync(w.hosts).mode & 0o020, 0o020, "/etc/hosts is not group-writable");
}

// If the separation stands but the marker is missing, the backend rejects every project container (projectbox network marker) —
// the inner dockerd would bring them back anyway with `unless-stopped`. So the same background stop as without separation.
// As a function, so the same check turns red on the state before that fix.
export function checkMarkerMissing(r, w) {
  const p = r.log;
  const text = `\n${p.join("\n")}\n--- stderr\n${r.err}`;
  assert.ok(r.rules.includes(JUMP), `the separation did not stand — then this case checks something else${text}`);
  assert.equal(fs.existsSync(w.marker), false, "a marker although it could not be written");
  assert.ok(index(p, "setpriv ") >= 0, `setpriv not reached${text}`);
  assert.ok(index(p, "dockerd") >= 0, `dockerd must start anyway${text}`);
  assert.match(r.err, /network separation stands, but the marker .* is missing/);
  const iInfo = index(p, "docker info");
  const iPs = index(p, "docker ps -q --filter label=cbase.project");
  const iStop = index(p, "docker stop -t 30 c-one c-two");
  assert.ok(iInfo >= 0 && iInfo < iPs && iPs < iStop, `without a marker the stop of the project containers after "info answers" is missing${text}`);
}

// `docker unpause c-two` (only the paused one) stands after "info answers" and BEFORE the stop of all. As a function, so the
// same check turns red on the state before that fix.
export function checkThaw(r) {
  const p = r.log;
  const text = `\n${p.join("\n")}\n--- stderr\n${r.err}`;
  const iInfo = index(p, "docker info");
  const iPaused = index(p, /^docker ps -q --filter label=cbase\.project --filter status=paused$/);
  const iUnpause = index(p, "docker unpause");
  const iStop = index(p, "docker stop -t 30 c-one c-two");
  assert.ok(iInfo >= 0 && iInfo < iPaused, `the paused ones are not looked up after "info answers"${text}`);
  assert.equal(p[iUnpause], "docker unpause c-two", `not exactly the paused one thawed${text}`);
  assert.ok(iPaused < iUnpause && iUnpause < iStop, `unpause not BEFORE the stop${text}`);
}

// ── network separation ───────────────────────────────────────────────────────────────────────────────────────────

