// The ways IN the pause. projectbox-pause.test.js holds the barrier at starts (dockerIn, the child behind the barrier, the main
// seam) - here are the ways that a RUNNING start, a deadline and a failed thaw take in the pause:
//
//   (P2)  runtime/inProject.js, the group kills of a running start: TERM to a frozen container waits at the barrier - no exec
//         at the daemon, the escalation stays open, its deadline does not run yet; after the thaw TERM reaches the group. A
//         stubborn group gets KILL after the thaw (the escalation works through the pause). A pause that cbase does NOT hold:
//         the "is paused" of the follow-up check is no "group empty" - a later KILL still goes out and hits.
//   (P3)  runtime/git-run.js commandRun: the deadline counts only from the barrier's release - a command in the pause waits
//         beyond its deadline and delivers its result after the thaw, instead of ending as "cap reached". The verdict without
//         a clock: `runningCommandDeadlines` counts the running deadlines; at the barrier the command has none.
//   (P4)  projectbox/docker.js thawOut: if the thaw fails (STILL_PAUSED), the watcher schedules a retry instead of leaving the
//         container frozen until the next start of B; the retry (clock seam advanceRethaw) thaws, and a waiter runs.
//
// The new exports come as a namespace (`?.`): so the file also loads against the state before the repair and is RED there,
// not unloadable.
//
// COUNTER-TESTS (each by putting the old file in place or by the sabotage, the whole file run, then reverted):
//   runtime/inProject.js in the old state                    => (P2) red, both tests ("the group kill does not wait at the
//                                                                barrier"; "the KILL after the foreign pause fizzled")
//   runtime/git-run.js in the old state                      => (P3) red ("the deadline ran at the barrier")
//   projectbox/docker.js: thawOut without `rethawSchedule`   => (P4) red ("no retry scheduled")
//   all five product files of the repair in the old state     => all red (docker.js, services.js, browser-network.js,
//     inProject.js, git-run.js)
//
// No clock as criterion: waiting is on waitingForThaw(), openEscalations(), process ends and log entries (waitForTruthy,
// without deadline). Every wait that could hang on a red state also ends on the counter-event.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as dockerMod from "../electron/server/projectbox/docker.js";
import * as imp from "../electron/server/runtime/inProject.js";
import { commandRun, runningCommandDeadlines } from "../electron/server/runtime/git-run.js";
import { waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";

const { dockerIn, dockerKind, dockerChildAfterThaw, dockerProgram, isFrozen, pause, thawOut, waitingForThaw } = dockerMod;
const { inProject, openEscalations, sentGroupsKills, setInProjectSeam } = imp;

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
// The escalation deadline at 200 ms: it speeds things up, the verdict is on openEscalations() and the log.
const ops = (bin) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: bin, CBASE_IN_PROJECT_ESCALATION_MS: "200", CBASE_PAUSE_CAP_MS: undefined });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8", env: { ...process.env, ...fd.env } }).trim();
const pausedIn = (fd, name) => Boolean(Object.values(fd.state().container).find((c) => c.name === name || c.name === `/${name}`)?.paused);
const killCalls = (fd, container) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec" && a.args.includes("kill") && a.args.includes(container));
const signalsTo = (fd, container) => killCalls(fd, container).map((a) => a.args[5]);
const INST = (name) => ({ projectId: "p1", instance: "main", identifier: "p1/main", containerId: name });
async function thawFallsNeeded(...names) {
  for (const n of names) if (n && isFrozen(n)) await thawOut(n).catch((e) => console.warn(`[pause-ways] cleaning up ${n}: ${e?.message || e}`));
}

// The seam as in server.js - WITH the pause barrier (frozen + childAfterThaw).
async function unit(fn, { bin } = {}) {
  const fd = await fakeDocker();
  const location = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-pause-ways-"));
  const stem = path.basename(location).replace(/[^a-z0-9]/gi, "").toLowerCase();
  const names = [`cbase-p-${stem}a`, `cbase-p-${stem}b`];
  try {
    return await withEnvironment(ops(bin ? bin(fd, location) : fd.bin), async () => {
      for (const n of names) dx(fd, "run", "-d", "--name", n, "--label", `cbase.project=${n}`, "cbase-projectbox:test");
      setInProjectSeam({
        kind: dockerKind, program: dockerProgram, processLocation: () => path.join(location, "processes"), container: (i) => i.containerId,
        frozen: isFrozen, childAfterThaw: dockerChildAfterThaw,
      });
      try {
        return await fn({ fd, location, name: names[0], second: names[1] });
      } finally {
        // Own groups that a red state left behind (only the remembered pgids, never by pattern).
        for (const g of groups.splice(0)) { try { process.kill(-g, "SIGKILL"); } catch { /* gone */ } }
        await thawFallsNeeded(...names);
        for (const n of names) if (pausedIn(fd, n)) dx(fd, "unpause", n);
        // A red state can leave waiters at the barrier (an entry nobody releases): their pause cap (5 min) would hold the test
        // process open - the clock seam lets it expire at once instead of turning red into a hang.
        if (waitingForThaw() > 0) dockerMod.advanceCap();
        // A pending follow-up check of the escalation still needs the fake docker - clean up only afterwards.
        await waitForTruthy(() => openEscalations() === 0, "escalations done");
      }
    });
  } finally {
    setInProjectSeam(null);
    fd.cleanUp();
    fs.rmSync(location, { recursive: true, force: true });
  }
}

const groups = [];
// A start with a long-runner; `stubborn` ignores TERM (leader and long-runner).
function start(inst, location, { stubborn = false } = {}) {
  const duration = path.join(location, `duration-${Math.random().toString(36).slice(2)}`);
  const kind = inProject(inst, "/bin/sh", ["-c", `${stubborn ? "trap '' TERM; " : ""}sleep 100000 & echo $! > ${duration}; wait`], { cwd: location });
  const finished = new Promise((r) => kind.once("close", r));
  return { kind, duration, finished };
}
async function ready({ kind, duration }) {
  await waitForTruthy(() => fs.existsSync(kind.inProject.pgidFile) && fs.existsSync(duration) && fs.readFileSync(duration, "utf8").trim(), "pgid file and long-runner");
  const g = { pgid: Number(fs.readFileSync(kind.inProject.pgidFile, "utf8")), durationPid: Number(fs.readFileSync(duration, "utf8")) };
  groups.push(g.pgid);
  return g;
}

// ── (P2) group kills of a running start ───────────────────────────────────────────────────────────────────────

test("(P2) Group kill in the pause: TERM waits at the barrier (escalation open, deadline not running), reaches the group after the thaw; a stubborn group gets KILL afterwards", async () => {
  await unit(async ({ fd, location, name }) => {
    const inst = INST(name);
    // 1. An ordinary group.
    const s = start(inst, location);
    const g = await ready(s);
    await pause(name);
    const prior = killCalls(fd, name).length;
    s.kind.kill("SIGTERM"); // like stopRun (runs/state.js)
    await s.finished; // the docker child in B is gone; the group in the container is not
    // Ends on the counter-event too: without a barrier the TERM goes out raw, gets "is paused", and the escalation ends.
    await waitForTruthy(() => waitingForThaw() === 1 || openEscalations() === 0, "TERM at the barrier");
    assert.equal(waitingForThaw(), 1, "the group kill does not wait at the barrier - it went to the daemon during the pause");
    assert.equal(killCalls(fd, name).length, prior, "a kill exec at the daemon while the container is frozen");
    assert.equal(openEscalations(), 1, "the escalation ended in the pause (an \"is paused\" read as \"group empty\")");
    assert.equal(imp.runningEscalationDeadlines?.(), 0, "the escalation deadline already runs although the TERM still stands at the barrier");
    assert.ok(alive(-g.pgid), "the group died in the pause - the test measures nothing");
    await thawOut(name);
    await waitForTruthy(() => !alive(-g.pgid) && !alive(g.durationPid), "the group got TERM after the thaw");
    await waitForTruthy(() => openEscalations() === 0, "escalation follow-up check");
    const to = signalsTo(fd, name).slice(prior);
    assert.ok(to.includes("-TERM") && to.includes("-0"), `after the thaw TERM and the follow-up check: ${to}`);

    // 2. A stubborn group: the escalation works through the pause - KILL after the thaw, after the follow-up check.
    const t = start(inst, location, { stubborn: true });
    const h = await ready(t);
    await pause(name);
    const mark = killCalls(fd, name).length;
    t.kind.kill("SIGTERM");
    await t.finished;
    await waitForTruthy(() => waitingForThaw() === 1 || openEscalations() === 0, "TERM at the barrier");
    assert.equal(openEscalations(), 1, "the stubborn group's escalation ended in the pause");
    await thawOut(name);
    await waitForTruthy(() => openEscalations() === 0, "escalation done");
    await waitForTruthy(() => !alive(-h.pgid) && !alive(h.durationPid), "stubborn group ended");
    // Each docker child writes the log itself at its start - compared sorted; KILL starts only after the follow-up check ends.
    const sig = signalsTo(fd, name).slice(mark);
    assert.deepEqual([...sig].sort(), ["-0", "-KILL", "-TERM"], `group kills after the thaw: ${sig}`);
    assert.ok(sig.indexOf("-KILL") > sig.indexOf("-0"), `KILL only after the follow-up check: ${sig}`);
  });
});

test("(P2) A pause that cbase does NOT hold: the follow-up check's \"is paused\" is no \"group empty\" - a later KILL goes out and hits", async () => {
  await unit(async ({ fd, location, name }) => {
    const s = start(INST(name), location);
    const g = await ready(s);
    dx(fd, "pause", name); // from outside: not in the set, no barrier
    try {
      s.kind.kill("SIGTERM");
      await s.finished;
      await waitForTruthy(() => openEscalations() === 0, "the follow-up check got \"is paused\"");
      assert.ok(alive(-g.pgid), "the group died in the foreign pause - the test measures nothing");
    } finally {
      dx(fd, "unpause", name);
    }
    // Without a verdict on the group the next kill stays possible; in the old state exit 1 meant "empty", and KILL fizzled.
    const prior = sentGroupsKills();
    s.kind.kill("SIGKILL");
    assert.equal(sentGroupsKills(), prior + 1, "the KILL after the foreign pause fizzled - the follow-up check read \"is paused\" as \"group empty\"");
    await waitForTruthy(() => !alive(-g.pgid) && !alive(g.durationPid), "the group got KILL");
  });
});

// ── (P3) commandRun's deadline counts from the release ──────────────────────────────────────────────────────────────────

test("(P3) commandRun in the pause: the deadline counts only from the release - after the thaw the result arrives, no cap", async () => {
  // Without a clock (no time limit at which the test turns red): the test seam `runningCommandDeadlines` counts the running
  // deadlines. At the barrier the command has none; in the old state it ran from the start (counter-test: 1, red).
  await unit(async ({ location, name }) => {
    const prior = runningCommandDeadlines();
    await pause(name);
    let result = null;
    const p1 = commandRun(INST(name), location, "sh", ["-c", "echo P3-OK"], { timeout: 600000 }).then((r) => { result = r; return r; });
    await waitForTruthy(() => waitingForThaw() === 1 || result, "the command stands at the barrier");
    assert.equal(result, null, `the command ran in the pause: ${JSON.stringify(result)}`);
    assert.equal(runningCommandDeadlines(), prior, "the deadline already ran at the barrier - it counts the pause");
    await thawOut(name);
    const r = await p1;
    assert.deepEqual({ code: r.code, out: r.stdout.trim(), cap: r.cap }, { code: 0, out: "P3-OK", cap: null }, JSON.stringify(r));
    assert.equal(runningCommandDeadlines(), prior, "the deadline stayed after the end");
  });
});

// ── (P4) the thaw watcher ──────────────────────────────────────────────────────────────────────────────────

// A docker in front of the fake one whose `unpause` fails while the file `<location>/unpause-broken` exists (a hanging daemon).
function unpauseBroken(fd, location) {
  const bin = path.join(location, "docker-unpause-broken");
  fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = unpause ] && [ -e '${location}/unpause-broken' ]; then echo "Error response from daemon: Cannot unpause container $2: test" >&2; exit 1; fi\nexec '${fd.bin}' "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("(P4) thawOut fails (STILL_PAUSED): the watcher schedules a retry that thaws and releases the waiters", async () => {
  await unit(async ({ fd, location, name }) => {
    await pause(name);
    let done = null;
    const waiting = dockerIn(name, ["ps", "-q"]).then((r) => { done = { r }; }, (e) => { done = { e }; });
    await waitForTruthy(() => waitingForThaw() === 1 || done, "dockerIn stands at the barrier");
    fs.writeFileSync(path.join(location, "unpause-broken"), "");
    await assert.rejects(thawOut(name), (e) => e.code === "STILL_PAUSED");
    assert.equal(isFrozen(name), true, "the entry dropped despite STILL_PAUSED");
    assert.equal(pausedIn(fd, name), true);
    assert.equal(dockerMod.openRethaw?.() ?? 0, 1, "no retry scheduled - the container would stay frozen until the next start of B");
    fs.rmSync(path.join(location, "unpause-broken"));
    assert.equal(dockerMod.advanceRethaw(), 1, "no running retry");
    await waitForTruthy(() => !isFrozen(name) || dockerMod.openRethaw() === 0, "the retry ran");
    assert.equal(isFrozen(name), false, "the retry did not thaw");
    assert.equal(pausedIn(fd, name), false, "still paused at the daemon");
    assert.equal(dockerMod.openRethaw(), 0);
    await waiting;
    assert.ok(done?.r, `the waiter did not run: ${done?.e?.message}`);
  }, { bin: unpauseBroken });
});
