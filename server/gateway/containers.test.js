import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// A fake `docker` on the PATH: `inspect` returns what inspect.json holds, everything else is only logged. This reproduces the
// race between gateway and deploy that once cost ten inner containers.
// A successful `stop` leaves B STANDING (marker b-stands — like the real thing: a backend that does not answer TERM ends after the
// deadline by SIGKILL, and `docker stop` reports exit 0); an `exec` into a standing B fails and additionally appears as
// "exec-into-the-empty exec <args>" in the log. `rm` and reset() take the marker back.
// `exec` fails with the marker exec-fails (sysbox restart) and HANGS with the marker exec-hangs (a stuck inner dockerd): it writes
// exec-waiting and waits in a loop for the gate exec-gate. The emergency brake is the ONE ripcord of the fakes
// (server/backend/test/ripcord.mjs): if the waiter never ends because the gateway waits without a cap, it writes "ripcord exec"
// into the log and ends with 9 — the test turns red (no cap message) instead of hanging.
// `update` succeeds; with the marker update-fails-once it fails ONCE and first puts after-update-error.json in place as the new
// inspect.json (a deploy replaced the container at that moment).
import { RIPCORD_MS } from "../../server/backend/test/ripcord.mjs";
const RIPCORD_TICKS = Math.ceil(RIPCORD_MS / 50);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-containers-"));
const state = path.join(tmp, "state");
fs.mkdirSync(state);
fs.writeFileSync(path.join(tmp, "docker"), `#!/bin/sh
echo "$@" >> "${state}/calls.log"
case "$1" in
  inspect)
    [ -f "${state}/inspect-fails" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
    [ -f "${state}/gone" ] && { echo "Error: No such object: $2" >&2; exit 1; }
    cat "${state}/inspect.json" ;;
  run) [ -f "${state}/after-run.json" ] && cp "${state}/after-run.json" "${state}/inspect.json"; echo new-id ;;
  stop) [ -f "${state}/stop-fails" ] && { echo "Error response from daemon: cannot stop" >&2; exit 1; }; : > "${state}/b-stands" ;;
  rm) rm -f "${state}/b-stands"; [ -f "${state}/rm-removed" ] && : > "${state}/gone"; : ;;
  volume)
    case "$2" in
      rm) [ -f "${state}/volume-rm-fails" ] && { echo "Error response from daemon: volume is in use" >&2; exit 1; }; : > "${state}/vol-gone-$3" ;;
      inspect) [ -f "${state}/vol-gone-$3" ] && { echo "Error response from daemon: get $3: no such volume" >&2; exit 1; }; : ;;
    esac ;;
  exec)
    [ -f "${state}/b-stands" ] && { echo "exec-into-the-empty $*" >> "${state}/calls.log"; echo "Error response from daemon: container is not running" >&2; exit 1; }
    [ -f "${state}/exec-fails" ] && { echo "Error response from daemon: cannot exec" >&2; exit 1; }
    if [ -f "${state}/exec-hangs" ]; then
      : > "${state}/exec-waiting"
      i=0
      while [ ! -f "${state}/exec-gate" ]; do
        i=$((i + 1))
        if [ "$i" -ge "\${GW_FAKE_RIPCORD_TICKS:-${RIPCORD_TICKS}}" ]; then echo "ripcord exec" >> "${state}/calls.log"; exit 9; fi
        sleep 0.05
      done
    fi
    ;;
  update)
    if [ -f "${state}/update-fails-once" ]; then
      rm -f "${state}/update-fails-once"
      [ -f "${state}/after-update-error.json" ] && cp "${state}/after-update-error.json" "${state}/inspect.json"
      echo "Error response from daemon: No such container" >&2; exit 1
    fi ;;
  *) : ;;
esac
`, { mode: 0o755 });
process.env.PATH = `${tmp}:${process.env.PATH}`;
process.env.GW_HEALTH_GRACE_MS = "1200";
// The tests before "busy is not broken" check the REPLACEMENT of an unhealthy B after the grace period — for them "at once" (0)
// applies; the test "busy is not broken" below sets the knob itself.
process.env.GW_UNHEALTHY_REPLACE_MS = "0";
delete process.env.GW_RUNTIME; // creation WITHOUT a runtime (one inherited from the shell would taint "carries CBASE_USER_ID")
const containers = await import("./containers.js");

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const inspectJson = (id, port) => JSON.stringify([{
  Id: id, State: { Running: true }, NetworkSettings: { Ports: { "7718/tcp": [{ HostPort: String(port) }] } },
}]);
const calls = () => { try { return fs.readFileSync(path.join(state, "calls.log"), "utf8").trim().split("\n"); } catch { return []; } };
// Also the markers of destroy's report — `rm-removed` (rm makes inspect say "No such object" afterwards), `inspect-fails` (the
// daemon does not answer), `volume-rm-fails`, and the remembered removed volumes `vol-gone-*`.
const reset = () => {
  for (const f of ["calls.log", "b-stands", "gone", "rm-removed", "inspect-fails", "volume-rm-fails", "update-fails-once", "after-update-error.json"]) { try { fs.unlinkSync(path.join(state, f)); } catch { /* empty */ } }
  for (const f of fs.readdirSync(state)) if (f.startsWith("vol-gone-")) fs.rmSync(path.join(state, f), { force: true });
};

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

test("a container replaced during the wait is NOT removed but adopted", async () => {
  reset();
  const healthy = http.createServer((req, res) => { res.statusCode = req.url === "/api/health" ? 200 : 404; res.end(); });
  await new Promise((r) => healthy.listen(0, "127.0.0.1", r));
  const newPort = healthy.address().port;
  const deadPort = await freePort();
  // First: the old container whose port nobody serves anymore.
  fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("old-id", deadPort));
  const run = containers.ensureRunning("u1");
  // In the middle of the wait "the deploy" replaces the container: same name, new id, new port.
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("new-id", newPort));
  const { port } = await run;
  assert.equal(port, newPort, "the successor is adopted");
  const c = calls();
  assert.ok(!c.some((l) => l.startsWith("rm ")), `no rm -f, neither old nor new: ${c.join(" | ")}`);
  assert.ok(!c.some((l) => l.startsWith("run ")), "no second docker run");
  await new Promise((r) => healthy.close(r));
});

test("a really dead container is removed by ID, never by name", async () => {
  reset();
  const deadPort = await freePort();
  fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("old-id", deadPort));
  // The restart "succeeds" (run), but the successor gets no host port — so the call ends at once with an error instead of
  // after 90 s of waiting; only WHAT was removed is checked.
  fs.writeFileSync(path.join(state, "after-run.json"), JSON.stringify([{ Id: "new-id", State: { Running: true }, NetworkSettings: { Ports: {} } }]));
  await assert.rejects(containers.ensureRunning("u2"), /no host port/);
  const c = calls();
  assert.ok(c.includes("rm -f old-id"), `removed by id: ${c.join(" | ")}`);
  assert.ok(!c.includes("rm -f cbase-u-u2"), "never by name");
});

// No stop path begins with `rm -f` of a running B — first its project containers are stopped with `-t 30` (docker exec into B), B
// itself gets 60 s (`--stop-timeout` at creation, `stop -t` at the idle stop), because the backend runs the stop chain on TERM.
// Sabotage: these three tests against a containers.js without the stop order => all three red — no B_STOP_DEADLINE, no exec
// before `rm -f`, `stop -t 10`, no `--stop-timeout`; and the old ORDER (in containers.js `rm -f` moved before the exec stop, in
// ensureRunning and destroy) => likewise all three red.
// First thaw the paused ones, then stop all — the script is run by the test "the exec stop thaws ..." below.
// Before it the function `own` (only containers whose label is not inherited from the image).
const PROJECT_STOP = "sh -c own() { e=; for i in $1; do " +
  "x=$(docker inspect -f '{{.Image}}|{{index .Config.Labels \"cbase.project\"}}' \"$i\" 2>/dev/null) || { e=\"$e $i\"; continue; }; " +
  "b=${x%%|*}; w=${x#*|}; " +
  "if bw=$(docker image inspect -f '{{index .Config.Labels \"cbase.project\"}}' \"$b\" 2>/dev/null) && [ -n \"$bw\" ] && [ \"$bw\" = \"$w\" ]; then continue; fi; " +
  "e=\"$e $i\"; done; printf '%s' \"$e\"; }; " +
  "p=$(own \"$(docker ps -q --filter label=cbase.project --filter status=paused)\"); [ -z \"$p\" ] || docker unpause $p; " +
  "ids=$(own \"$(docker ps -q --filter label=cbase.project)\"); [ -z \"$ids\" ] || docker stop -t 30 $ids";

test("an unhealthy B — first stop the project containers via exec, then rm -f by id; the new B with --stop-timeout 60", async () => {
  reset();
  const deadPort = await freePort();
  fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("unhealthy-id", deadPort));
  fs.writeFileSync(path.join(state, "after-run.json"), JSON.stringify([{ Id: "new-id", State: { Running: true }, NetworkSettings: { Ports: {} } }]));
  await assert.rejects(containers.ensureRunning("u-s15"), /no host port/);
  const c = calls();
  const exec = c.indexOf(`exec -u agent unhealthy-id ${PROJECT_STOP}`);
  const rm = c.indexOf("rm -f unhealthy-id");
  assert.ok(exec > c.indexOf(`exec -u root unhealthy-id sh -c ${containers.B_ENDS_SCRIPT}`) && c.indexOf(`exec -u root unhealthy-id sh -c ${containers.B_ENDS_SCRIPT}`) >= 0, `the "B ends" marker (exec -u root) is missing or not before the script: ${c.join(" | ")}`);
  assert.ok(exec >= 0, `exec stop of the project containers is missing: ${c.join(" | ")}`);
  assert.ok(rm > exec, `rm -f only AFTER the exec stop: ${c.join(" | ")}`);
  const run = c.find((l) => l.startsWith("run "));
  assert.ok(run, "B is created anew");
  assert.match(run, /^run -d --init --stop-timeout 60 --name cbase-u-u-s15 /);
  assert.equal(containers.B_STOP_DEADLINE, 60);
  assert.equal(containers.PROJECT_STOP_DEADLINE, 30);
});

test("idle stop with the deadline B_STOP_DEADLINE; destroy first stops the project containers, then rm -f", async () => {
  reset();
  await containers.stop("u-stop");
  assert.deepEqual(calls(), [`stop -t ${containers.B_STOP_DEADLINE} cbase-u-u-stop`]);
  reset();
  await containers.destroy("u-gone");
  const c = calls();
  // First the port for the snapshot (inspect), then the marker, then the script (the project containers, while B is
  // running), then B itself, then rm -f.
  assert.deepEqual(c.slice(0, 5), [
    "inspect cbase-u-u-gone",
    `exec -u root cbase-u-u-gone sh -c ${containers.B_ENDS_SCRIPT}`,
    `exec -u agent cbase-u-u-gone ${PROJECT_STOP}`,
    `stop -t ${containers.B_STOP_DEADLINE} cbase-u-u-gone`,
    "rm -f cbase-u-u-gone",
  ], c.join(" | "));
});

test("if the exec stop fails (sysbox restart, B without an inner Docker), B falls anyway", async () => {
  reset();
  fs.writeFileSync(path.join(state, "exec-fails"), "");
  try {
    await containers.destroy("u-broken");
    const c = calls();
    const exec = c.findIndex((l) => l.startsWith("exec -u agent cbase-u-u-broken "));
    assert.ok(exec >= 0, `the exec stop was attempted: ${c.join(" | ")}`);
    assert.ok(c.indexOf("rm -f cbase-u-u-broken") > exec, c.join(" | "));
  } finally { fs.rmSync(path.join(state, "exec-fails"), { force: true }); }
});

// The exec stop thaws the PAUSED project containers before it stops all — a paused one does not accept TERM, its inner dockerd
// would die hard after the deadline. The script REALLY runs here (sh -c) against a fake docker with state: `ps --filter
// status=paused` reports what is in `paused`, `unpause` takes it out there, and a `stop` of a still paused one writes
// "hard <id>" into the log.
// Built-in counter-test: the script as before the thawing (BEFORE_ST2_3) — no unpause, "hard c-two".
const BEFORE_ST2_3 = `ids=$(docker ps -q --filter label=cbase.project); [ -z "$ids" ] || docker stop -t 30 $ids`;
// `labels` { id: { image, value } } — what `inspect` reports on the container (image and value of cbase.project); `images`
// { image: value } — the value on the image (`image inspect`); an image without an entry is unknown (exit 1).
function runStopScript(script, paused, { labels = {}, images = {} } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "gw-stop-script-"));
  try {
    fs.writeFileSync(path.join(d, "paused"), paused.map((x) => `${x}\n`).join(""));
    for (const [id, { image, value }] of Object.entries(labels)) fs.writeFileSync(path.join(d, `c-${id}`), `${image}|${value}`);
    for (const [image, value] of Object.entries(images)) fs.writeFileSync(path.join(d, `b-${image}`), value);
    fs.writeFileSync(path.join(d, "docker"), `#!/bin/sh
st="${d}"
echo "docker $*" >> "$st/log"
case "$1" in
  ps) case "$*" in *status=paused*) cat "$st/paused";; *) printf '%s\\n' c-one c-two;; esac;;
  inspect) [ -f "$st/c-$4" ] && cat "$st/c-$4";;
  image) [ -f "$st/b-$5" ] || exit 1; cat "$st/b-$5";;
  unpause) shift; for i in "$@"; do grep -vx "$i" "$st/paused" > "$st/p.t"; mv "$st/p.t" "$st/paused"; done;;
  stop) shift 3; for i in "$@"; do grep -qx "$i" "$st/paused" && echo "hard $i" >> "$st/log"; done;;
esac
exit 0
`, { mode: 0o755 });
    execFileSync("/bin/sh", ["-c", script], { env: { ...process.env, PATH: `${d}:${process.env.PATH}` } });
    return fs.readFileSync(path.join(d, "log"), "utf8").trim().split("\n");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
function checkThawBeforeStop(log) {
  const unpause = log.indexOf("docker unpause c-two");
  const stop = log.indexOf("docker stop -t 30 c-one c-two");
  assert.ok(unpause >= 0, `no unpause of the paused one: ${log.join(" | ")}`);
  assert.ok(stop > unpause, `stop not AFTER the unpause: ${log.join(" | ")}`);
  assert.ok(!log.some((l) => l.startsWith("hard ")), `a paused one was stopped: ${log.join(" | ")}`);
}

test("the exec stop first thaws the paused project containers, then stops all; without paused ones no unpause", () => {
  checkThawBeforeStop(runStopScript(containers.PROJECT_STOP_SCRIPT, ["c-two"]));
  const without = runStopScript(containers.PROJECT_STOP_SCRIPT, []);
  assert.ok(!without.some((l) => l.startsWith("docker unpause")), without.join(" | "));
  assert.ok(without.includes("docker stop -t 30 c-one c-two"), without.join(" | "));
  // The script IS what the exec stop sends (otherwise this test would check another one).
  assert.equal(`sh -c ${containers.PROJECT_STOP_SCRIPT}`, PROJECT_STOP);
});

// c-two carries cbase.project=p1 only because its image carries it (inherited) — it is neither thawed nor stopped; c-one (own
// label, image without) is stopped. An image that is not readable lets the label count alone.
// Built-in counter-test: the script before that rule (BEFORE_PE_30) thaws c-two and stops it.
const BEFORE_PE_30 = "p=$(docker ps -q --filter label=cbase.project --filter status=paused); [ -z \"$p\" ] || docker unpause $p; " +
  "ids=$(docker ps -q --filter label=cbase.project); [ -z \"$ids\" ] || docker stop -t 30 $ids";
function checkOnlyOwn(log) {
  assert.ok(!log.some((l) => l.startsWith("docker unpause")), `an inherited one was thawed: ${log.join(" | ")}`);
  assert.ok(log.includes("docker stop -t 30 c-one"), `not exactly the own one stopped: ${log.join(" | ")}`);
}
test("the exec stop leaves out a container with a cbase.project inherited from the image (neither unpause nor stop); an unreadable image counts by the label", () => {
  const situation = { labels: { "c-one": { image: "sha256:a", value: "p1" }, "c-two": { image: "sha256:b", value: "p1" } }, images: { "sha256:a": "", "sha256:b": "p1" } };
  checkOnlyOwn(runStopScript(containers.PROJECT_STOP_SCRIPT, ["c-two"], situation));
  assert.throws(() => checkOnlyOwn(runStopScript(BEFORE_PE_30, ["c-two"], situation)), assert.AssertionError, "counter-test: the script before that rule is not red");
  // Unknown image (no entry): the label counts alone — both are stopped.
  const unknown = runStopScript(containers.PROJECT_STOP_SCRIPT, [], { labels: situation.labels, images: {} });
  assert.ok(unknown.includes("docker stop -t 30 c-one c-two"), unknown.join(" | "));
  // An own value that differs from the image's value is own.
  const different = runStopScript(containers.PROJECT_STOP_SCRIPT, [], { labels: { ...situation.labels, "c-two": { image: "sha256:b", value: "p2" } }, images: situation.images });
  assert.ok(different.includes("docker stop -t 30 c-one c-two"), different.join(" | "));
});

test("counter-test: the script before the thawing stops a paused project container without thawing it — the check is red", () => {
  // BEFORE_ST2_3 is the stop script of server/gateway/containers.js as it stood before the thaw, with its deadline filled in:
  // a stop, no thaw. It is written out here, not fetched from history, so the counter-test bites on any checkout.
  assert.ok(BEFORE_ST2_3.includes("docker stop -t 30 $ids") && !BEFORE_ST2_3.includes("unpause"), "the fixture is not the form before the thawing");
  const log = runStopScript(BEFORE_ST2_3, ["c-two"]);
  assert.ok(log.includes("hard c-two"), `the counter-test does not bite: ${log.join(" | ")}`);
  assert.throws(() => checkThawBeforeStop(log), assert.AssertionError);
});

// The cap on the exec stop: whoever removed it left this file green, and every user request hung on the single flight of
// ensureRunning/destroy as long as the exec hung. Here it really hangs (exec-hangs, gate never open); the knob
// GW_PROJECT_STOP_CAP_MS sets the cap small (clock seam).
// Sabotage:
//   containers.js without the knob => red: the cap reports 55000 instead of 200 ms
//   containers.js with `{ timeout: 0 }` at the exec stop (cap removed) => red: no cap, the waiter ends via the fake's ripcord
//     ("ripcord exec" in the log, no message) — without it the test would hang
async function withHangingExec(fn) {
  reset();
  for (const f of ["exec-waiting", "exec-gate"]) fs.rmSync(path.join(state, f), { force: true });
  fs.writeFileSync(path.join(state, "exec-hangs"), "");
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(" ")); };
  process.env.GW_PROJECT_STOP_CAP_MS = "200";
  try {
    return await fn(warnings);
  } finally {
    console.warn = warn;
    delete process.env.GW_PROJECT_STOP_CAP_MS;
    fs.writeFileSync(path.join(state, "exec-gate"), ""); // a still waiting one ends at once
    fs.rmSync(path.join(state, "exec-hangs"), { force: true });
  }
}

function checkCap(warnings, container) {
  const c = calls();
  assert.ok(fs.existsSync(path.join(state, "exec-waiting")), `the exec did not hang — then the test does not check the cap: ${c.join(" | ")}`);
  assert.ok(!c.includes("ripcord exec"), `no cap: the exec ended only via the fake's ripcord: ${c.join(" | ")}`);
  const exec = c.findIndex((l) => l.startsWith(`exec -u agent ${container} `));
  assert.ok(exec >= 0 && c.indexOf(`rm -f ${container}`) > exec, `rm -f only after the exec stop: ${c.join(" | ")}`);
  assert.ok(warnings.some((w) => w === `[gateway] Project containers in ${container}: cap of 200 ms reached — B is removed anyway`),
    `no cap message: ${JSON.stringify(warnings)}`);
}

test("if the exec stop hangs (inner dockerd stuck), ensureRunning returns anyway — with the cap message", async () => {
  await withHangingExec(async (warnings) => {
    const deadPort = await freePort();
    fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("hangs-id", deadPort));
    fs.writeFileSync(path.join(state, "after-run.json"), JSON.stringify([{ Id: "new-id", State: { Running: true }, NetworkSettings: { Ports: {} } }]));
    await assert.rejects(containers.ensureRunning("u-hangs"), /no host port/);
    checkCap(warnings, "hangs-id");
  });
});

test("if the exec stop hangs, destroy returns too — with the cap message; without the knob PROJECT_STOP_CAP_MS applies", async () => {
  await withHangingExec(async (warnings) => {
    await containers.destroy("u-hangs-gone");
    checkCap(warnings, "cbase-u-u-hangs-gone");
  });
  assert.equal(containers.projectStopCapMs(), containers.PROJECT_STOP_CAP_MS, "without the knob not the constant's cap");
  assert.equal(containers.PROJECT_STOP_CAP_MS, (containers.B_STOP_DEADLINE - 5) * 1000);
  for (const wrong of ["", "0", "-5", "1.5", "x"]) {
    process.env.GW_PROJECT_STOP_CAP_MS = wrong;
    try { assert.equal(containers.projectStopCapMs(), containers.PROJECT_STOP_CAP_MS, `knob "${wrong}"`); }
    finally { delete process.env.GW_PROJECT_STOP_CAP_MS; }
  }
});

// The gateway's stop bypassed the backend's docker() in B — no "cbase stops itself" marker, serverEnds() false, and the observer
// (projectbox/resumption.js) restarted the project containers in a LIVE B at once before `rm -f B` killed them hard. Fixed in two
// parts, one test each:
//   (1) destroy() stops B with `docker stop -t B_STOP_DEADLINE` (B runs its stop chain with serverEnds()) — AFTER marker and
//       script: a backend that does not answer TERM ends after the deadline by SIGKILL together with the inner dockerd and
//       stacks, and a script afterwards would hit a standing B (the "fallback" never took effect). A failing stop does not hold
//       up the rm -f;
//   (2) before the script the gateway sets, via `exec -u root`, the marker /run/cbase/b-ends (atomic: .fresh, then mv), in
//       ensureRunning (unhealthy B, relic after start) as in destroy. It is read by serverEnds():
//       server/backend/test/server-end-marker.test.js.
// Sabotage: see the head of server/backend/test/server-end-marker.test.js (the table for both files is there).
function withoutDocker(c, l) { return c.filter((x) => x !== l); }
// Sabotage: destroy again with `docker stop -t 60` BEFORE stopProjectContainer
//       => red (3 of 16): "destroy sets the marker ..." (exec into the empty), "idle stop ... destroy", "if the exec stop hangs,
//         destroy returns too" (the exec did not hang — it hit a standing B)
// The promise as ONE log check — as a function, so that the same check turns red on the old order.
function checkDestroyOrder(c, b) {
  const stop = c.indexOf(`stop -t 60 ${b}`);
  const marker = c.findIndex((l) => l.startsWith(`exec -u root ${b} `));
  const script = c.findIndex((l) => l.startsWith(`exec -u agent ${b} `));
  const rm = c.indexOf(`rm -f ${b}`);
  assert.ok(stop >= 0, `no docker stop -t 60 in destroy: ${c.join(" | ")}`);
  assert.ok(marker >= 0 && marker < script && script < stop && stop < rm, `order marker < script < stop -t 60 < rm -f violated: ${c.join(" | ")}`);
  assert.deepEqual(c.filter((l) => l.startsWith("exec-into-the-empty ")), [], `an exec hit a standing B — the project containers would die hard with it: ${c.join(" | ")}`);
  assert.equal(withoutDocker(c, c[stop]).filter((l) => l.startsWith("stop ")).length, 0, "only ONE stop of B");
}
test("destroy sets the marker and stops the project containers via exec script WHILE B runs, then `docker stop -t 60 <B>`, then rm -f; if the stop fails, rm -f runs anyway", async () => {
  reset();
  await containers.destroy("u-rp94");
  checkDestroyOrder(calls(), "cbase-u-u-rp94");
  reset();
  fs.writeFileSync(path.join(state, "stop-fails"), "");
  try {
    await containers.destroy("u-rp94-broken");
    const k = calls();
    assert.ok(k.some((l) => l.startsWith("exec -u agent cbase-u-u-rp94-broken ")), `script before the failing stop: ${k.join(" | ")}`);
    assert.ok(k.includes("rm -f cbase-u-u-rp94-broken"), `rm -f after a failing stop: ${k.join(" | ")}`);
  } finally { fs.rmSync(path.join(state, "stop-fails"), { force: true }); }
});

// destroy asks the backend in B for the `desired` snapshot (POST SNAPSHOT_ROUTE on the host port from inspect) BEFORE marker and
// script run — afterwards the project containers stand, their inside is no longer readable. An endpoint that closes the
// connection does not hold destroy up (destroy's end is awaited, without a deadline).
// Sabotage: containers.js without `if (port) await snapshotBeforeTheStop(port);` => red ("no snapshot before marker and script").
test("destroy requests the snapshot from the backend BEFORE marker and script run; an endpoint that closes the connection does not hold destroy up", async () => {
  const remember = (row) => fs.appendFileSync(path.join(state, "calls.log"), `${row}\n`);
  reset();
  const srv = http.createServer((req, res) => { remember(`snapshot ${req.method} ${req.url}`); res.statusCode = 200; res.end("{}"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("snap-id", srv.address().port));
    await containers.destroy("u-snap");
    const c = calls();
    const s = c.indexOf(`snapshot POST ${containers.SNAPSHOT_ROUTE}`);
    const marker = c.findIndex((l) => l.startsWith("exec -u root cbase-u-u-snap "));
    const script = c.findIndex((l) => l.startsWith("exec -u agent cbase-u-u-snap "));
    assert.ok(s >= 0 && s < marker && marker < script, `no snapshot before marker and script: ${c.join(" | ")}`);
    checkDestroyOrder(c, "cbase-u-u-snap");
  } finally { await new Promise((r) => srv.close(r)); }
  reset();
  const closed = net.createServer((sock) => { remember("snapshot closed"); sock.destroy(); });
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  try {
    fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("snap-closed-id", closed.address().port));
    await containers.destroy("u-snap-closed");
    const c = calls();
    assert.ok(c.includes("snapshot closed"), `the endpoint was not asked: ${c.join(" | ")}`);
    checkDestroyOrder(c, "cbase-u-u-snap-closed");
  } finally { await new Promise((r) => closed.close(r)); }
});

// Built-in counter-test: the old order (stop -t 60 FIRST, the script as a "fallback" afterwards) against the same fake docker —
// the script hits a standing B (a backend that does not answer TERM ends by SIGKILL; `docker stop` reports 0 anyway), the check
// is red. Run with the calls of the old version, not with its source.
test("counter-test: the old order (stop -t 60 before marker and script) lets the script run into the void — the check is red", async () => {
  reset();
  const b = "cbase-u-u-rp97-old";
  const { execFile } = await import("node:child_process");
  const d = (args) => new Promise((res) => execFile("docker", args, () => res()));
  await d(["stop", "-t", "60", b]);
  await d(["exec", "-u", "root", b, "sh", "-c", containers.B_ENDS_SCRIPT]);
  await d(["exec", "-u", "agent", b, "sh", "-c", containers.PROJECT_STOP_SCRIPT]);
  await d(["rm", "-f", b]);
  const c = calls();
  assert.ok(c.some((l) => l.startsWith(`exec-into-the-empty exec -u agent ${b} `)), `the fake docker does not model the standing B: ${c.join(" | ")}`);
  assert.throws(() => checkDestroyOrder(c, b), assert.AssertionError, "the check does not notice the old order");
});

test("ensureRunning (unhealthy B) sets the marker via `exec -u root` BEFORE the script and the rm -f; the marker is atomic, belongs to root and carries epoch ms", async () => {
  reset();
  const deadPort = await freePort();
  fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("unhealthy-rp94", deadPort));
  fs.writeFileSync(path.join(state, "after-run.json"), JSON.stringify([{ Id: "new-id", State: { Running: true }, NetworkSettings: { Ports: {} } }]));
  await assert.rejects(containers.ensureRunning("u-rp94-ens"), /no host port/);
  const c = calls();
  const marker = c.indexOf(`exec -u root unhealthy-rp94 sh -c ${containers.B_ENDS_SCRIPT}`);
  const script = c.findIndex((l) => l.startsWith("exec -u agent unhealthy-rp94 "));
  const rm = c.indexOf("rm -f unhealthy-rp94");
  assert.ok(marker >= 0, `no marker via exec -u root: ${c.join(" | ")}`);
  assert.ok(marker < script && script < rm, `order marker < script < rm -f violated: ${c.join(" | ")}`);
  // The content of the script: the path serverEnds() reads, written atomically, readable by all, not writable.
  const sk = containers.B_ENDS_SCRIPT;
  assert.match(sk, /mkdir -p \/run\/cbase && chmod 755 \/run\/cbase/);
  assert.match(sk, /> \/run\/cbase\/b-ends\.fresh/);
  assert.match(sk, /chmod 644 \/run\/cbase\/b-ends\.fresh && mv \/run\/cbase\/b-ends\.fresh \/run\/cbase\/b-ends$/);
  assert.match(sk, /date \+%s000 >/); // seconds times 1000 = epoch ms; without a backslash (the fake `echo` would interpret it)
});

// `busy` no longer counts running dynamic workflows (the deploy does not wait for them). The idle reaper reads the same route —
// it must still count them as busy, otherwise it puts a container to sleep in the middle of a run, and unlike after a deploy
// nobody wakes it.
// Sabotage: in containers.js busy() again `resolve(!!JSON.parse(b).busy)` => this test red at "a running workflow is busy".
test("idle reaper: busy:false with a running dynamic workflow is busy; a backend without the field is read by busy alone", async () => {
  let response = null;
  const backend = http.createServer((req, res) => {
    if (req.url !== "/api/runs/active") { res.statusCode = 404; return res.end(); }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(response));
  });
  await new Promise((r) => backend.listen(0, "127.0.0.1", r));
  try {
    fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("reaper-id", backend.address().port));
    const fall = async (body) => { response = body; return containers.busy("u-reaper"); };
    const wf = { chatId: "c1", title: "X", runId: "wf_1", taskId: "t1", name: "tracer", progress: { phase: null, agents: 1, finished: 0 } };
    assert.equal(await fall({ busy: false, runs: 0, agents: [], dynWorkflows: [wf] }), true, "a running workflow is busy");
    assert.equal(await fall({ busy: false, runs: 0, agents: [], dynWorkflows: [] }), false, "nothing runs");
    assert.equal(await fall({ busy: true, runs: 1, agents: [], dynWorkflows: [] }), true, "a turn runs");
    // An older backend: no field — the workflows are still inside busy there.
    assert.equal(await fall({ busy: true, runs: 0 }), true, "old backend, busy");
    assert.equal(await fall({ busy: false, runs: 0 }), false, "old backend, free");
    // The pure reading of it, also for an unreadable response.
    assert.equal(containers.busyFrom(null), true, "no readable response: better not stop");
    assert.equal(containers.busyFrom({ busy: false, dynWorkflows: "?" }), false);
    // A WAITING copy (queue/storage) does not hold `busy`, but the agent was promised the wake-up — the reaper counts it
    // like a dynamic workflow. A backend without the field: as before.
    // Sabotage: drop the `copiesWaiting` line in busyFrom => red at "a waiting copy is busy".
    assert.equal(await fall({ busy: false, runs: 0, agents: [], dynWorkflows: [], copies: 1, copiesWaiting: 1 }), true, "a waiting copy is busy");
    assert.equal(await fall({ busy: false, runs: 0, agents: [], dynWorkflows: [], copies: 2, copiesWaiting: 0 }), false, "ready copies alone are not busy");
    assert.equal(containers.busyFrom({ busy: false, copiesWaiting: "1" }), false, "only a number counts");
    // A PERSISTENT monitor (a watch, no time limit) does not hold `busy` — the deploy must not wait days for it — but a backend put
    // to sleep would end the watch silently: the reaper counts every live monitor.
    // Sabotage: drop the `monitors` line in busyFrom => red at "a persistent monitor keeps the container awake".
    const watch = { chatId: "c1", title: "X", taskId: "m1", name: "Teams watch", report: "rows", startedAt: 1, persistent: true };
    assert.equal(await fall({ busy: false, runs: 0, agents: [], dynWorkflows: [], monitors: [watch] }), true, "a persistent monitor keeps the container awake");
    assert.equal(await fall({ busy: false, runs: 0, agents: [], dynWorkflows: [], monitors: [] }), false, "no monitor, nothing runs");
  } finally {
    await new Promise((r) => backend.close(r));
  }
});

test("hostResources: RAM, CPU load and disk of the host in a fixed shape", async () => {
  const h = await containers.hostResources();
  assert.ok(h.mem.totalBytes > 0 && h.mem.availableBytes >= 0 && h.mem.availableBytes <= h.mem.totalBytes);
  assert.ok(h.cpu.count >= 1 && Number.isFinite(h.cpu.load1));
  assert.ok(h.swap === null || (h.swap.totalBytes > 0 && h.swap.freeBytes <= h.swap.totalBytes));
  assert.ok(h.disk === null || (h.disk.totalBytes > 0 && h.disk.freeBytes <= h.disk.totalBytes));
  assert.ok(Math.abs(Date.now() - h.at) < 5000);
  // cbase's share (cbase-share.js, the rules are there): always the six fields, each a number or null. The fake docker
  // here knows no container (`ps` empty) => RAM, swap and CPU 0 (measured; the CPU at once — no container, no window needed),
  // the disk null until the first background measurement — and the measurement itself (`system df`) is only kicked off.
  assert.deepEqual(Object.keys(h.cbase).sort(), ["at", "cpuCores", "diskAt", "diskBytes", "memBytes", "swapBytes"]);
  assert.deepEqual([h.cbase.memBytes, h.cbase.swapBytes, h.cbase.cpuCores, h.cbase.diskBytes], [0, 0, 0, null]);
  await containers.cbaseMeter.diskFinished();
  assert.ok(calls().some((l) => l.startsWith("ps -q --no-trunc --filter label=cbase.gateway=1")), calls().join(" | "));
  assert.ok(calls().some((l) => l.startsWith("system df -v")), calls().join(" | "));
});

// The table of all `rm -f` of a user container in containers.js: the behavior tests above run two of the three paths (unhealthy
// B, destroy) — the third (a broken relic after a failed `docker start`) and every future one stands only here. Each
// `docker(["rm", "-f", X])` needs IMMEDIATELY before it (next code line above) `await stopProjectContainer(X)` with the same
// X — between them only the stop of B itself may stand (`docker(["stop", "-t", String(B_STOP_DEADLINE), X])`, in destroy: first
// the project containers, then B); every `docker(["stop", ...])` the deadline B_STOP_DEADLINE. Sabotage: the form before the
// stop order (CONTAINERS_BEFORE_STOP_ORDER, see the counter-test below) => all three rm -f without a stop, the stop with `-t 10`.
import { execFileSync } from "node:child_process";
const GW_DIR = path.dirname(new URL(import.meta.url).pathname);

function rmTable(text) {
  const rows = text.split("\n");
  const code = (z) => z.trim() && !z.trim().startsWith("//");
  const rm = [];
  const stops = [];
  rows.forEach((z, i) => {
    const m = z.match(/docker\(\["rm", "-f", ([^\]]+)\]\)/);
    if (m) {
      let j = i - 1;
      const bStop = `docker(["stop", "-t", String(B_STOP_DEADLINE), ${m[1].trim()}])`;
      while (j >= 0 && (!code(rows[j]) || rows[j].includes(bStop))) j--;
      const beforehand = rows[j] || "";
      rm.push({ seq: i + 1, target: m[1].trim(), stopped: beforehand.includes(`await stopProjectContainer(${m[1].trim()})`) });
    }
    const s = z.match(/docker\(\["stop", ([^\]]+)\]\)/);
    if (s) stops.push({ seq: i + 1, deadline: s[1].includes("String(B_STOP_DEADLINE)") });
  });
  return { rm, stops };
}

test("every rm -f of a B in containers.js stands directly behind the stop of its project containers, every stop carries B_STOP_DEADLINE", () => {
  const { rm, stops } = rmTable(fs.readFileSync(path.join(GW_DIR, "containers.js"), "utf8"));
  assert.equal(rm.length, 3, `three paths expected (unhealthy, relic after start, destroy): ${JSON.stringify(rm)}`);
  assert.deepEqual(rm.filter((r) => !r.stopped), [], "rm -f without a preceding stopProjectContainer");
  assert.ok(stops.length >= 1 && stops.every((s) => s.deadline), JSON.stringify(stops));
});

// containers.js before the stop order (reduced from 4f1eb0d): the three `rm -f` of a B — unhealthy, broken relic after a failed
// start, destroy — without a preceding stop of its project containers, and the stop of B with a deadline of its own.
const CONTAINERS_BEFORE_STOP_ORDER = [
  "export async function ensureRunning(userId) {",
  "  if (info && !healthy) {",
  '    await docker(["rm", "-f", info.Id]).catch(() => {});',
  "  }",
  "  if (info && !started) {",
  '    await docker(["rm", "-f", after?.Id || info.Id]).catch(() => {}); // replace the broken relic (the volume stays)',
  "  }",
  "}",
  "",
  "export async function destroy(userId) {",
  '  await docker(["stop", "-t", "10", cname(userId)]).catch(() => {});',
  '  await docker(["rm", "-f", cname(userId)]).catch(() => {});',
  "}",
  "",
].join("\n");

test("counter-test: containers.js before the stop order fails", () => {
  const { rm, stops } = rmTable(CONTAINERS_BEFORE_STOP_ORDER);
  assert.equal(rm.length, 3);
  assert.equal(rm.filter((r) => !r.stopped).length, 3);
  assert.ok(stops.some((s) => !s.deadline));
});

// ── deleting a user against their running requests ───────────────────────────────────────────────────────────────────────────
// `destroy` ran without a single flight next to ensureRunning: a request arriving in the middle of the deletion created a new B
// (`--restart unless-stopped`, with purge=0 with the old home) — orphaned, and the route reported `purged:true`. Now: while
// destroy runs, ensureRunning refuses; a running start is awaited; destroy reports what is REALLY missing. The route's side
// (lock first, delete the user only after the removal) is in index.test.js.
// Sabotage: without it all three red: ensureRunning delivered a port in the middle of the teardown (and a second destroy was a
// second teardown), the teardown overtook the running start (`rm -f` before its `run`), destroy reported nothing.
const waitFile = async (f) => { while (!fs.existsSync(path.join(state, f))) await new Promise((r) => setTimeout(r, 20)); };

test("while destroy runs, ensureRunning creates nothing (plain message instead of start/run); a second destroy shares the first", async () => {
  reset();
  for (const f of ["exec-waiting", "exec-gate"]) fs.rmSync(path.join(state, f), { force: true });
  const healthy = http.createServer((req, res) => { res.statusCode = 200; res.end("{}"); });
  await new Promise((r) => healthy.listen(0, "127.0.0.1", r));
  fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("m26-id", healthy.address().port));
  fs.writeFileSync(path.join(state, "exec-hangs"), "");
  try {
    const teardown = containers.destroy("u-m26");
    await waitFile("exec-waiting"); // destroy stands in the stop of the project containers
    await assert.rejects(containers.ensureRunning("u-m26"), /is currently being removed/, "in the middle of the teardown ensureRunning delivered a container");
    assert.equal(containers.destroy("u-m26"), teardown, "a second destroy started a second teardown");
    fs.writeFileSync(path.join(state, "exec-gate"), "");
    await teardown;
    assert.deepEqual(calls().filter((l) => /^(run|start) /.test(l)), [], "a container was created anew or started");
  } finally {
    fs.writeFileSync(path.join(state, "exec-gate"), "");
    fs.rmSync(path.join(state, "exec-hangs"), { force: true });
    await new Promise((r) => healthy.close(r));
  }
});

test("destroy awaits a running start of the same user instead of overtaking it (otherwise its `run` came after the `rm -f`)", async () => {
  reset();
  const deadPort = await freePort();
  fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("m26b-old", deadPort));
  fs.writeFileSync(path.join(state, "after-run.json"), JSON.stringify([{ Id: "m26b-new", State: { Running: true }, NetworkSettings: { Ports: {} } }]));
  const start = containers.ensureRunning("u-m26b").catch((e) => e); // unhealthy: waits the grace period, removes by id, run
  const teardown = containers.destroy("u-m26b");
  await start;
  await teardown;
  const c = calls();
  const run = c.findIndex((l) => l.startsWith("run "));
  const rmName = c.indexOf("rm -f cbase-u-u-m26b");
  assert.ok(run >= 0 && rmName > run, `the teardown overtook the start — its run then created an orphaned B: ${c.join(" | ")}`);
});

test("destroy reports what is REALLY missing — container and, with purge, both volumes; if `volume rm` fails, nothing is \"purged\"; unknown is not gone", async () => {
  const marker = (f) => fs.writeFileSync(path.join(state, f), "");
  fs.writeFileSync(path.join(state, "inspect.json"), "[]");
  reset(); marker("rm-removed");
  assert.deepEqual(await containers.destroy("u-ber-1", { purge: true }), { containerAway: true, volumesGone: true });
  assert.ok(calls().includes("volume rm cbase-u-u-ber-1-docker"), "the inner Docker belongs to the purge");
  reset(); marker("rm-removed"); marker("volume-rm-fails");
  assert.deepEqual(await containers.destroy("u-ber-2", { purge: true }), { containerAway: true, volumesGone: false });
  reset(); // rm removes nothing: inspect still finds the container afterwards
  assert.deepEqual(await containers.destroy("u-ber-3"), { containerAway: false, volumesGone: null });
  reset(); marker("rm-removed"); marker("inspect-fails"); // the daemon does not answer: unknown, not "gone"
  assert.deepEqual(await containers.destroy("u-ber-4"), { containerAway: false, volumesGone: null });
  reset();
});

// The single flight of destroy ignored `purge` — a deletion WITH purge that came during a teardown WITHOUT purge got its report
// (`volumesGone: null`), no `volume rm` ran, the route answered 500, the first one deleted the user meanwhile, and the volumes
// stayed behind with no way in the UI.
// Sabotage: without the purge handling — red: `volumesGone: null`, no `volume rm`.
test("a deletion WITH purge during a teardown WITHOUT purge — both volumes are removed, its report says volumesGone:true", async () => {
  reset();
  fs.writeFileSync(path.join(state, "inspect.json"), "[]");
  fs.writeFileSync(path.join(state, "rm-removed"), "");
  const without = containers.destroy("u-pg", { purge: false });
  const including = containers.destroy("u-pg", { purge: true });
  await without;
  const third = containers.destroy("u-pg"); // during the purge step: it still belongs to the running teardown
  const [b1, b2, b3] = [await without, await including, await third];
  assert.deepEqual(b2, { containerAway: true, volumesGone: true }, "the call with purge got the report of the teardown without purge");
  for (const v of ["cbase-u-u-pg-home", "cbase-u-u-pg-docker"]) assert.ok(calls().includes(`volume rm ${v}`), `no volume rm ${v}: ${calls().join(" | ")}`);
  assert.deepEqual(b1, { containerAway: true, volumesGone: null }, "the first call (without purge) gets its own report");
  assert.deepEqual(b3, b2, "a third call shares the extended teardown (while it runs, ensureRunning refuses)");
  assert.equal(calls().filter((l) => l === "rm -f cbase-u-u-pg").length, 1, "the purge step does not tear down a second time");
  reset();
});

// ── questions to the container with a total deadline and a cap ──────────────────────────────────────────────────────────────────
// busy and nextScheduleOccurrence collected the body without a limit and had only an IDLE deadline (`timeout: 2500` of
// http.get): a backend that writes without end filled the gateway, one that drips stopped the schedule alarm of ALL users (it
// asked in sequence). What is measured is, from the backend side, who closes the connection (as in push.test.js).
// Sabotage: without the cap/total deadline — both red ("backend" instead of "gateway"; the drip test only after the fake's
// ripcord).
function countBackend(fall) {
  const v = { finished: false, whenClosed: null, url: null };
  const srv = http.createServer((req, res) => {
    v.url = req.url;
    let ripcord = null;
    v.whenClosed = new Promise((r) => res.on("close", () => { clearTimeout(ripcord); r(v.finished ? "backend" : "gateway"); }));
    ripcord = setTimeout(() => { v.finished = true; res.end("1}"); }, RIPCORD_MS);
    ripcord.unref();
    res.writeHead(200, { "content-type": "application/json" });
    fall(res, v);
  });
  return { srv, v };
}

test("busy reads at most BUSY_CAP_BYTES — a backend without end is aborted and counts as busy", async () => {
  const EIGHT_MIB = 8 * 1024 * 1024;
  const { srv, v } = countBackend((res, z) => {
    let written = 0;
    const chunk = "x".repeat(64 * 1024);
    const further = () => {
      while (written < EIGHT_MIB && !res.destroyed) { written += chunk.length; if (!res.write(chunk)) { res.once("drain", further); return; } }
      if (!res.destroyed) { z.finished = true; res.end(); }
    };
    further();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  reset();
  fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("flood-id", srv.address().port));
  try {
    assert.equal(await containers.busy("u-flood"), true, "an unreadable response is busy");
    assert.equal(await v.whenClosed, "gateway", "the gateway read the flood to the end");
  } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
});

test("the next schedule occurrence has a TOTAL deadline — a dripping backend is aborted (null = unknown, the stored value stays)", async () => {
  const { srv, v } = countBackend((res) => {
    res.write('{"nextAt":');
    const drip = setInterval(() => { if (!res.destroyed) res.write(" "); }, 100); // faster than any idle deadline
    res.on("close", () => clearInterval(drip));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  reset();
  fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("drip-id", srv.address().port));
  try {
    assert.equal(await containers.nextScheduleOccurrence("u-drip"), null);
    // Asked under the ONE constant against which the seam guard (server/backend/test/scheduled-wakeup-seam.test.js) checks the backend.
    assert.equal(v.url, containers.SCHEDULED_OCCURRENCE_PATH);
    assert.equal(await v.whenClosed, "gateway", "the gateway waited on the dripping backend without a total deadline");
  } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
});

// Soft priority: the limits of a new user container. Without GW_CONTAINER_CPUS no hard limit, the weight only as a whole number in
// Docker's range (2…262144) — a typo in the unit drops out instead of letting `docker run` fail (then the user would get NO
// container at all).
test("limitsArgs: memory, hard limit and weight; without cpus no hard limit; a wrong weight drops out", () => {
  assert.deepEqual(containers.limitsArgs({ mem: "12g", cpus: "", cpuShares: "1287" }), ["--memory", "12g", "--cpu-shares", "1287"]);
  assert.deepEqual(containers.limitsArgs({ mem: "8g", cpus: "2" }), ["--memory", "8g", "--cpus", "2"], "the old setup stays possible");
  assert.deepEqual(containers.limitsArgs({}), []);
  for (const wrong of ["0", "1", "262145", "512k", "-5", " 512", "5.5", "abc"]) {
    assert.deepEqual(containers.limitsArgs({ cpuShares: wrong }), [], `weight "${wrong}" drops out`);
  }
  assert.deepEqual(containers.limitsArgs({ cpuShares: 262144 }), ["--cpu-shares", "262144"]);
});

// ── administration ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// The docker side of the resources per user: the re-creation reads the stored row (the unit only without a row), applying goes by
// id, awaits a running start and refuses during the teardown. The path through the routes is in administration.test.js.
// Sabotage:
//   in ensureRunning `resourcesSource ? resourcesSource(userId) : null` -> `null` => "re-creation ..." red (the unit instead of the row);
//   in applyResources drop the `await inflight.get(userId)` => "... awaits a running start" red (update inside the start);
//   drop both `teardown.has` checks in applyResources => "... during the teardown 409" red;
//   drop the second attempt at the new id (`throw` instead of update) => "... by id ..." red.
import { CPU_PRIO_SHARES } from "./administration-contract.js";
const GIB = 1024 ** 3;

test("administration: a re-creation takes the limits of the resources source (swap 2 x RAM, without a limit no --cpus); without a row the unit as before", async () => {
  reset();
  fs.writeFileSync(path.join(state, "gone"), ""); // no container: ensureRunning creates one (and then fails at the missing port)
  const rows = { "u-source": { ramGiB: 3, cpuPrio: "up", cpuMax: 1 }, "u-open": { ramGiB: 2, cpuPrio: "low", cpuMax: null } };
  containers.setResourcesSource((uid) => rows[uid] ?? null);
  try {
    for (const u of ["u-source", "u-open", "u-unit"]) await assert.rejects(containers.ensureRunning(u), /no host port/);
  } finally { containers.setResourcesSource(null); }
  const from = (u) => calls().find((l) => l.startsWith("run ") && l.includes(` --name cbase-u-${u} `)) || "";
  assert.ok(from("u-source").includes(` --memory ${3 * GIB} --memory-swap ${6 * GIB} --cpu-shares ${CPU_PRIO_SHARES.up} --cpus 1 `), from("u-source"));
  assert.ok(from("u-open").includes(` --memory ${2 * GIB} --memory-swap ${4 * GIB} --cpu-shares ${CPU_PRIO_SHARES.low} `), from("u-open"));
  assert.ok(!from("u-open").includes("--cpus"), `without a limit no --cpus: ${from("u-open")}`);
  const unit = containers.limitsArgs(containers.UNIT_TEMPLATE).join(" ");
  assert.ok(from("u-unit") && !from("u-unit").includes("--memory-swap") && from("u-unit").includes(unit), `without a row the unit (${unit || "empty"}): ${from("u-unit")}`);
});

test("administration: applyResources — by id with swap 2 x RAM and --cpus <threads> for \"no limit\"; a container replaced in the meantime gets the update at the new id; nothing without a container; docker silent => error", async () => {
  const threads = containers.hostSpecs().threads;
  const values = { ramGiB: 4, cpuPrio: "normal", cpuMax: null };
  const expected = (id) => `update --memory ${4 * GIB} --memory-swap ${8 * GIB} --cpu-shares ${CPU_PRIO_SHARES.normal} --cpus ${threads} ${id}`;
  const updates = () => calls().filter((l) => l.startsWith("update "));
  reset();
  fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("w-id", 1));
  const situation = await containers.applyResources("u-w", values);
  assert.deepEqual(updates(), [expected("w-id")]);
  assert.deepEqual([situation.state, situation.id], ["running", "w-id"]);

  reset();
  fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("w-old", 1));
  fs.writeFileSync(path.join(state, "after-update-error.json"), inspectJson("w-new", 1));
  fs.writeFileSync(path.join(state, "update-fails-once"), "");
  assert.equal((await containers.applyResources("u-w", values)).id, "w-new");
  assert.deepEqual(updates(), [expected("w-old"), expected("w-new")], "the successor carries the old values of the deploy swap — it gets the update");

  reset();
  fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("w-id", 1));
  fs.writeFileSync(path.join(state, "update-fails-once"), "");
  await assert.rejects(containers.applyResources("u-w", values), /docker update/, "same id: the error goes up");

  reset();
  fs.writeFileSync(path.join(state, "gone"), "");
  assert.equal((await containers.applyResources("u-w", values)).state, "missing");
  assert.deepEqual(updates(), [], "without a container there is nothing to apply — the next creation reads the row");

  reset();
  fs.writeFileSync(path.join(state, "inspect-fails"), "");
  await assert.rejects(containers.applyResources("u-w", values), /docker inspect/, "unknown is not \"missing\"");
  await assert.rejects(containers.situation("u-w"), /docker inspect/);
  reset();
});

test("administration: applyResources awaits a running start — the update goes only afterwards (otherwise it would come before its run)", async () => {
  reset();
  let held;
  const inside = new Promise((r) => { held = r; });
  let open;
  const gate = new Promise((r) => { open = r; });
  const healthy = http.createServer(async (req, res) => { held(); await gate; res.statusCode = 200; res.end("{}"); });
  await new Promise((r) => healthy.listen(0, "127.0.0.1", r));
  try {
    fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("flight-id", healthy.address().port));
    const start = containers.ensureRunning("u-flight");
    await inside; // the start stands in its health check
    const apply = containers.applyResources("u-flight", { ramGiB: 2, cpuPrio: "up", cpuMax: null });
    // A window for an absence (under load at most falsely green, never red): while the start runs, no update.
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(calls().filter((l) => l.startsWith("update ")), [], "the update overtook the running start");
    open();
    await start;
    await apply;
    assert.equal(calls().filter((l) => l.startsWith("update ")).length, 1);
  } finally {
    open();
    healthy.closeAllConnections?.();
    await new Promise((r) => healthy.close(r));
  }
});

test("administration: during the teardown applyResources and restart refuse with 409 (instead of working on a B that is just falling)", async () => {
  reset();
  for (const f of ["exec-waiting", "exec-gate"]) fs.rmSync(path.join(state, f), { force: true });
  fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("teardown-id", await freePort()));
  fs.writeFileSync(path.join(state, "exec-hangs"), "");
  try {
    const teardown = containers.destroy("u-teardown");
    await waitFile("exec-waiting");
    assert.equal(containers.teardownRunning("u-teardown"), true);
    const ist409 = (e) => e?.status === 409 && /being removed/.test(e.message);
    await assert.rejects(containers.applyResources("u-teardown", { ramGiB: 2, cpuPrio: "up", cpuMax: null }), ist409);
    await assert.rejects(containers.restart("u-teardown"), ist409);
    assert.deepEqual(calls().filter((l) => /^(update|start|run) /.test(l)), []);
    fs.writeFileSync(path.join(state, "exec-gate"), "");
    await teardown;
    assert.equal(containers.teardownRunning("u-teardown"), false);
  } finally {
    fs.writeFileSync(path.join(state, "exec-gate"), "");
    fs.rmSync(path.join(state, "exec-hangs"), { force: true });
  }
});

// B knows its user id — `-e CBASE_USER_ID=<id>` on EVERY creation, also without GW_RUNTIME (the gateway used to set only
// CBASE_DIND, and only inside `if (RUNTIME)`).
// Sabotage: move the variable into the `if (RUNTIME)` branch => red.
test("a creation without GW_RUNTIME carries -e CBASE_USER_ID=<id> exactly once, from the same source as the label cbase.user", async () => {
  reset();
  fs.writeFileSync(path.join(state, "gone"), ""); // no container: ensureRunning creates one (and then fails at the missing port)
  await assert.rejects(containers.ensureRunning("u-watch"), /no host port/);
  const run = calls().find((l) => l.startsWith("run ") && l.includes(" --name cbase-u-u-watch ")) || "";
  assert.ok(run, calls().join("\n"));
  assert.ok(!run.includes("--runtime"), `without GW_RUNTIME no runtime: ${run}`);
  assert.equal(run.split(" ").filter((w) => w.startsWith("CBASE_USER_ID=")).join(" "), "CBASE_USER_ID=u-watch", run);
  assert.ok(run.includes(" -e CBASE_USER_ID=u-watch "), run);
  assert.ok(run.includes(" --label cbase.user=u-watch "), run);
});

// A B that did not answer for a good 30 s must not be stopped and removed (the running turn would be gone): a RUNNING B with a
// port that does not answer is "busy" for GW_UNHEALTHY_REPLACE_MS in a row — 503, no exec, no rm, no run. Only after that is it
// replaced. A change of the id restarts the clock.
// Sabotage: without the busy rule the first call removes "busy-id" (rm -f in calls.log) and throws "no host port" instead of 503
// => red.
test("busy is not broken: a running B without an answer gets 503 and stays — replaced only after the duration in a row", async () => {
  const prior = process.env.GW_UNHEALTHY_REPLACE_MS;
  reset();
  const deadPort = await freePort();
  fs.writeFileSync(path.join(state, "inspect.json"), inspectJson("busy-id", deadPort));
  fs.writeFileSync(path.join(state, "after-run.json"), JSON.stringify([{ Id: "new-id", State: { Running: true }, NetworkSettings: { Ports: {} } }]));
  try {
    process.env.GW_UNHEALTHY_REPLACE_MS = "3000";
    const e1 = await containers.ensureRunning("u-busy").then(() => null, (e) => e);
    assert.ok(e1, "a non-answering B delivered a port");
    assert.deepEqual([e1.status, e1.busy], [503, true], String(e1?.message));
    const c1 = calls();
    assert.equal(c1.some((l) => l.startsWith("rm ") || l.startsWith("run ") || l.startsWith("exec ")), false, `nothing touched: ${c1.join(" | ")}`);
    // After the duration has passed (grace period 1.2 s per call, clock from the first failure minus the grace period): replaced.
    await new Promise((r) => setTimeout(r, 1500));
    await assert.rejects(containers.ensureRunning("u-busy"), /no host port/, "after the duration in a row it is replaced (and here fails at the new one's missing port)");
    const c2 = calls();
    assert.ok(c2.includes("rm -f busy-id"), `replaced by id: ${c2.join(" | ")}`);
    assert.ok(c2.some((l) => l.startsWith("run ")), "created anew");
  } finally {
    if (prior === undefined) delete process.env.GW_UNHEALTHY_REPLACE_MS; else process.env.GW_UNHEALTHY_REPLACE_MS = prior;
  }
});
