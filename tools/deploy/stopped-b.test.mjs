// Step 0 of `./deploy server` — lib/stopped-b.mjs (start stopped user containers before the idle gate) and its place in
// targets/server.mjs; the reading of `docker ps -a` that targets/status.mjs uses for the row "stopped user containers".
//
// GUARANTEES, each with its counter-way:
//   (1) Order in the source text: `rollOutAfterBackendBuild` starts stopped B before preparing the project box and thus before
//       `swapContainerValue`, whose `remoteGate` precedes `swapContainer`. COUNTER-TEST: the call moved behind `prepareProjectbox(`
//       => (1) red.
//   (2) containerSituation: only names with the prefix and the name form count; stopped means `exited` or `created`, anything else
//       (restarting, paused, dead) is `other`; startCommand refuses a name that is not a container name (shell text).
//   (3) On a fake docker: startStoppedB starts every stopped B and returns their names; a B whose `docker start` fails does not make
//       it throw — the others run through, the failed one is named as "NOT swapped"; a B in another state is named and not touched;
//       running ones are not touched. COUNTER-TEST: startStoppedB without the `check: false` on the start => (3) red (it throws).
//   (4) `--dry-run` shows the `docker start` and executes only the reading `docker ps -a`.
//   (5) targets/status.mjs reads the stopped B through the same two functions (the row "stopped user containers").
//
// HOW. Fake ssh (runs the script with bash), fake docker (per B a file with the state; `start`, `ps -a`, `exec … curl /api/health`).
// PATH is ${BIN}:/usr/bin:/bin — no real docker or ssh is reachable.
//
// Run:  node --test --test-reporter=tap tools/deploy/stopped-b.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-stopped-b-"));
const BIN = path.join(ROOT, "bin");
const BS = path.join(ROOT, "b"); // one file per B: its state
const DOCKER_LOG = path.join(ROOT, "docker.log");
const ORIG = { PATH: process.env.PATH, HOME: process.env.HOME };
test.after(() => {
  process.env.PATH = ORIG.PATH;
  process.env.HOME = ORIG.HOME;
  fs.rmSync(ROOT, { recursive: true, force: true });
});
for (const d of [BIN, BS, path.join(ROOT, "home"), path.join(ROOT, "remote")]) fs.mkdirSync(d, { recursive: true });

const write = (name, text) => fs.writeFileSync(path.join(BIN, name), text, { mode: 0o755 });
write("ssh", '#!/bin/bash\nwhile [ $# -gt 0 ] && [ "$1" != "bash" ]; do shift; done\nshift\nexec bash "$@"\n');
// The fake docker. `<name>.start-broken` => docker start ends with exit 1.
write("docker", [
  "#!/bin/bash",
  `echo "$*" >> '${DOCKER_LOG}'`,
  `BS='${BS}'`,
  'case "$1" in',
  '  ps) for f in "$BS"/*.state; do [ -e "$f" ] || continue; n=$(basename "$f" .state); echo "$n $(cat "$f")"; done; echo "foreign-container running" ;;',
  '  start) [ -e "$BS/$2.start-broken" ] && { echo "Error response from daemon: port is already allocated" >&2; exit 1; }; echo running > "$BS/$2.state" ;;',
  '  exec) url="${@: -1}"; case "$*" in *"/api/health"*) printf 200 ;; *) exit 7 ;; esac ;;',
  '  *) echo "fake docker: $*" >&2; exit 125 ;;',
  "esac",
  "",
].join("\n"));
process.env.PATH = `${BIN}:/usr/bin:/bin`;
process.env.HOME = path.join(ROOT, "home");
process.env.CBASE_SSH_HOST = "wrong";
process.env.CBASE_REMOTE_ROOT = path.join(ROOT, "remote");
process.env.CBASE_DEPLOY_HEALTHY_MS = "0";

const lib = await import("./lib/stopped-b.mjs");
const sh = await import("../check/lib/sh.mjs");
const log = await import("../check/lib/log.mjs");
const { config } = await import("./config.mjs");
const P = config.remote.containerPrefix;

const calls = () => (fs.existsSync(DOCKER_LOG) ? fs.readFileSync(DOCKER_LOG, "utf8").split("\n").filter(Boolean) : []);
function scene(states, { broken = [] } = {}) {
  fs.rmSync(DOCKER_LOG, { force: true });
  for (const n of fs.readdirSync(BS)) fs.rmSync(path.join(BS, n), { force: true });
  for (const [name, state] of Object.entries(states)) fs.writeFileSync(path.join(BS, `${P}${name}.state`), state);
  for (const name of broken) fs.writeFileSync(path.join(BS, `${P}${name}.start-broken`), "");
}
const stateOf = (name) => fs.readFileSync(path.join(BS, `${P}${name}.state`), "utf8").trim();
async function withLog(fn) {
  const file = log.openLog(path.join(ROOT, "logs"), `t-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try { return { r: await fn(), text: () => fs.readFileSync(file, "utf8") }; } finally { await log.closeLog(); }
}

test("(1) source text: stopped B before the project box and the swap, the gate before the swap", () => {
  const server = fs.readFileSync(path.join(HERE, "targets/server.mjs"), "utf8");
  const body = (text, header) => { const i = text.indexOf(header); assert.ok(i >= 0, header); return text.slice(i, text.indexOf("\n}\n", i)); };
  const pos = (t, s) => { const i = t.indexOf(s); assert.ok(i >= 0, s); return i; };
  const r = body(server, "export async function rollOutAfterBackendBuild(");
  assert.ok(pos(r, "await startStoppedB()") < pos(r, "prepareProjectbox(") && pos(r, "prepareProjectbox(") < pos(r, "return swapContainerValue("));
  const t = body(server, "export async function swapContainerValue(");
  assert.ok(pos(t, "remoteGate(") < pos(t, "swapContainer("));
  assert.match(server, /import \{ startStoppedB \} from "\.\.\/lib\/stopped-b\.mjs";/);
});

test("(2) containerSituation: only prefix names, stopped means exited/created; startCommand refuses what is no container name", () => {
  assert.deepEqual(lib.containerSituation(`${P}a running\n${P}b exited\n${P}c created\n${P}d restarting\n${P}e\nfremd running\n${P}x;rm exited\n`, P),
    { running: [`${P}a`], stopped: [`${P}b`, `${P}c`], other: [{ name: `${P}d`, state: "restarting" }, { name: `${P}e`, state: "?" }] });
  assert.deepEqual(lib.containerSituation("", P), { running: [], stopped: [], other: [] });
  assert.equal(lib.startCommand(`${P}a`), `docker start ${P}a >/dev/null`);
  assert.throws(() => lib.startCommand(`${P}a; rm -rf /`), /not a valid container name/);
  assert.throws(() => lib.checkName(""), /not a valid container name/);
  assert.equal(lib.situationCommand(P), `docker ps -a --filter name=${P} --format '{{.Names}} {{.State}}'`);
});

test("(3) startStoppedB starts the stopped B; a failed start does not throw and is named; another state is named and not touched", async () => {
  scene({ a: "running", b: "exited", c: "exited", d: "created", r: "restarting" }, { broken: ["c"] });
  const { r, text } = await withLog(() => lib.startStoppedB());
  assert.deepEqual(r, [`${P}b`, `${P}d`]);
  assert.deepEqual([stateOf("a"), stateOf("b"), stateOf("c"), stateOf("d"), stateOf("r")], ["running", "running", "exited", "running", "restarting"]);
  assert.match(text(), new RegExp(`${P}c: the start failed \\(Error response from daemon: port is already allocated\\) — stays stopped and is NOT swapped`));
  assert.match(text(), new RegExp(`${P}r: state restarting — neither running nor stopped, not started\\.`));
  assert.match(text(), new RegExp(`${P}b: started, backend answers`));
  assert.equal(calls().some((z) => new RegExp(`^(start|exec)( .*)? ${P}[ar]( |$)`).test(z)), false, `a running or restarting B was touched: ${JSON.stringify(calls())}`);
  // Nothing stopped: nothing started, no step.
  scene({ a: "running" });
  const none = await withLog(() => lib.startStoppedB());
  assert.deepEqual(none.r, []);
  assert.deepEqual([...new Set(calls().map((z) => z.split(" ")[0]))], ["ps"]);
});

test("(4) --dry-run shows the docker start and executes only the reading docker ps -a", async () => {
  scene({ a: "running", b: "exited" });
  sh.setDryRun(true);
  let out;
  try {
    out = await withLog(() => lib.startStoppedB());
  } finally {
    sh.setDryRun(false);
  }
  assert.deepEqual(out.r, [`${P}b`]);
  assert.match(out.text(), new RegExp(`docker start ${P}b `));
  assert.match(out.text(), new RegExp(`\\(dry run: ${P}b would be started and then swapped like every other\\)`));
  assert.deepEqual([...new Set(calls().map((z) => z.split(" ")[0]))], ["ps"], JSON.stringify(calls()));
  assert.equal(stateOf("b"), "exited");
});

test("(5) targets/status.mjs reads the stopped B through the same functions", () => {
  const status = fs.readFileSync(path.join(HERE, "targets/status.mjs"), "utf8");
  assert.match(status, /import \{ containerSituation, situationCommand \} from "\.\.\/lib\/stopped-b\.mjs";/);
  assert.match(status, /containerSituation\(\(await sshProbe\(situationCommand\(config\.remote\.containerPrefix\)\)\)\.stdout, config\.remote\.containerPrefix\)/);
  assert.match(status, /\["stopped user containers", situation\.stopped\.length \?/);
});
