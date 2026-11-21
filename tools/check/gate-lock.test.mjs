// Guard for the gate lock (lib/gate-lock.mjs): only one full gate at a time, machine-wide.
//
// Three states count — free, occupied, dead — and the third is where a lock fails in everyday use: an aborted gate does not
// clean up, and a lock that then held forever would be worse than none. So "occupied" and "dead" run against REAL second
// processes, not staged pids.
//
// No time limit at which a test turns red: it waits on events (a line from the child, its `exit`), and the lock's waiting
// step (`sleep`) is passed in by the test itself — it returns when the test has released or killed the holder, not after a duration.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LOCK, alive, takeLock, lockState, startOf } from "./lib/gate-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = pathToFileURL(path.join(HERE, "lib", "gate-lock.mjs")).href;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cbase-gate-lock-"));
}

// A child waiting for a line — for "alive" and "reused".
function durationKind() {
  const subprocess = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"], { stdio: ["pipe", "ignore", "ignore"] });
  return subprocess;
}

// A child that takes the lock through the REAL module, reports "held" and releases on "go".
function holderKind(file) {
  const code = `
    const { takeLock } = await import(${JSON.stringify(MODULE)});
    const s = await takeLock({ file: ${JSON.stringify(file)}, who: "holder-child" });
    process.stdout.write("held " + s.taken + "\\n");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { if (d.includes("go")) { s.release(); process.stdout.write("free\\n"); process.exit(0); } });
  `;
  const subprocess = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["pipe", "pipe", "inherit"] });
  subprocess.stdout.setEncoding("utf8");
  const rows = [];
  const waiters = [];
  let rest = "";
  subprocess.stdout.on("data", (d) => {
    rest += d;
    const parts = rest.split("\n");
    rest = parts.pop();
    for (const z of parts) {
      rows.push(z);
      for (const w of [...waiters]) if (w.matches(z)) { waiters.splice(waiters.indexOf(w), 1); w.done(z); }
    }
  });
  const row = (pattern) => {
    const hit = rows.find((z) => pattern.test(z));
    if (hit) return Promise.resolve(hit);
    return new Promise((done) => waiters.push({ matches: (z) => pattern.test(z), done }));
  };
  const end2 = new Promise((done) => subprocess.on("exit", (code, signal) => done({ code, signal })));
  return { kind: subprocess, row, end: end2 };
}

function end(kind) {
  if (kind.exitCode === null && kind.signalCode === null) {
    try { kind.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

test("the pure decision: none, unreadable, dead, reused, occupied", () => {
  const live = { alive: () => true, startOf: () => "Sun Sep 27 00:41:12 2026" };
  assert.deepEqual(lockState(null, live), { free: true, reason: "no" });
  assert.equal(lockState("{broken", live).reason, "unreadable");
  assert.equal(lockState(JSON.stringify({ pid: "x" }), live).reason, "unreadable");
  assert.equal(lockState(JSON.stringify({ pid: 0 }), live).reason, "unreadable");

  const tot = lockState(JSON.stringify({ pid: 4242, start: "Sun Sep 27 00:41:12 2026" }), { alive: () => false, startOf: () => null });
  assert.deepEqual([tot.free, tot.reason, tot.pid], [true, "tot", 4242]);

  // A DIFFERENT process runs under the pid (macOS hands out pids from the start again after 99,999).
  const foreign = lockState(JSON.stringify({ pid: 4242, start: "Sat Sep 26 10:00:00 2026" }), live);
  assert.deepEqual([foreign.free, foreign.reason], [true, "reused"]);

  const occupied = lockState(JSON.stringify({ pid: 4242, start: "Sun Sep 27 00:41:12 2026", since: "2026-09-27T00:41:13.000Z", who: "/repo" }), live);
  assert.deepEqual([occupied.free, occupied.pid, occupied.who], [false, 4242, "/repo"]);

  // If `ps` knows nothing (or is missing), the liveness check stands — better to wait than to run two gates.
  assert.equal(lockState(JSON.stringify({ pid: 4242, start: "x" }), { alive: () => true, startOf: () => null }).free, false);
  // And a lock without a start time (foreign, older version) likewise.
  assert.equal(lockState(JSON.stringify({ pid: 4242 }), live).free, false);
});

test("the real checkers: alive and startOf on a real child", async () => {
  const kind = durationKind();
  try {
    assert.equal(alive(kind.pid), true);
    const s = startOf(kind.pid);
    assert.ok(s && s.length > 5, `ps -o lstart= returns nothing for a living child: ${s}`);
    assert.equal(startOf(kind.pid), s, "the start time is stable — otherwise every lock would count as reused");
  } finally {
    const end2 = new Promise((done) => kind.on("exit", done));
    kind.stdin.end();
    await end2;
  }
  assert.equal(alive(kind.pid), false, "an ended child is no longer alive");
});

// Two gates from sessions with different locale/time zone read the same start time differently and took the lock of the LIVING
// other for "reused". The guard asks startOf in two children with differing environments about the SAME pid — both must
// return the same text.
test("startOf: the same start time whatever locale and time zone the asking session has", async () => {
  const target = durationKind();
  try {
    const question = (env) => new Promise((resolve, reject) => {
      const code = `const { startOf } = await import(${JSON.stringify(MODULE)}); process.stdout.write(String(startOf(${target.pid})));`;
      const k = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      k.stdout.on("data", (d) => { out += d; });
      k.on("error", reject);
      k.on("exit", () => resolve(out));
    });
    const a = await question({ LANG: "en_NZ.UTF-8", LC_ALL: "", TZ: "Europe/Berlin" });
    const b = await question({ LANG: "", LC_ALL: "", TZ: "UTC" });
    assert.ok(a && a !== "null", `startOf returned nothing: ${a}`);
    assert.equal(a, b, "terminal session (en_NZ, Berlin) and desktop session (no LANG, UTC) must read the same start time");
  } finally {
    target.stdin.end();
  }
});

test("free: created with own pid, and release() cleans up exactly once", async () => {
  const dir = tempDir();
  const file = path.join(dir, "gate.lock");
  try {
    const s = await takeLock({ file, who: "test" });
    assert.equal(s.taken, true);
    assert.equal(s.waited, false);
    assert.equal(s.takenOver, null);
    const content = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(content.pid, process.pid);
    assert.equal(content.who, "test");
    assert.equal(content.start, startOf(process.pid));
    // No intermediate file lies around (atomic via link).
    assert.deepEqual(fs.readdirSync(dir), ["gate.lock"]);
    s.release();
    assert.equal(fs.existsSync(file), false);
    s.release();
    // If a FOREIGN lock already lies there on release (our own was cleared as dead and re-taken), release() does
    // not touch it — it belongs to the other gate.
    const s2 = await takeLock({ file });
    const foreign = JSON.stringify({ pid: 1, start: "foreign" });
    fs.writeFileSync(file, foreign);
    s2.release();
    assert.equal(fs.readFileSync(file, "utf8"), foreign);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dead: a lock with an ended process is free and is taken over without waiting", async () => {
  const dir = tempDir();
  const file = path.join(dir, "gate.lock");
  const kind = durationKind();
  try {
    const start = startOf(kind.pid);
    const end2 = new Promise((done) => kind.on("exit", done));
    kind.stdin.end();
    await end2;
    fs.writeFileSync(file, JSON.stringify({ pid: kind.pid, start, since: new Date().toISOString(), who: "aborted" }));
    let reported = 0;
    const s = await takeLock({ file, report: () => reported++, sleep: () => assert.fail("a dead lock must not be waited for") });
    assert.equal(s.taken, true);
    assert.equal(s.waited, false);
    assert.equal(reported, 0);
    assert.deepEqual(s.takenOver, { pid: kind.pid, reason: "tot" });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
    s.release();
  } finally {
    end(kind);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reused: another process runs under the pid — free", async () => {
  const dir = tempDir();
  const file = path.join(dir, "gate.lock");
  const kind = durationKind();
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: kind.pid, start: "Thu Jan  1 00:00:00 1970", since: new Date().toISOString() }));
    const s = await takeLock({ file, sleep: () => assert.fail("a reused pid is no holder") });
    assert.equal(s.taken, true);
    assert.deepEqual(s.takenOver, { pid: kind.pid, reason: "reused" });
    s.release();
  } finally {
    end(kind);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("occupied: a second gate waits, reports the holder ONCE and takes the lock as soon as it is free", async () => {
  const dir = tempDir();
  const file = path.join(dir, "gate.lock");
  const h = holderKind(file);
  try {
    assert.equal(await h.row(/^held /), "held true");
    const notices = [];
    let slept = 0;
    const s = await takeLock({
      file,
      report: (z) => notices.push(z),
      // On the first look the lock is occupied: only now does the holder release, and we return when it is
      // gone. A second look would mean "the release was not seen" — that is red, no second attempt (otherwise a
      // bug would become an endless loop).
      sleep: async () => {
        slept++;
        assert.equal(slept, 1, "waited again after the release — the free lock was not taken");
        assert.equal(notices.length, 1, "the one line stands before the first wait");
        h.kind.stdin.write("go\n");
        await h.row(/^free$/);
        await h.end;
      },
    });
    assert.equal(s.taken, true);
    assert.equal(s.waited, true);
    assert.equal(slept, 1);
    assert.equal(notices.length, 1, "ONE line per holder, not one per look");
    assert.equal(notices[0].pid, h.kind.pid);
    assert.equal(notices[0].who, "holder-child");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
    s.release();
  } finally {
    end(h.kind);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("occupied, then dead: if the holder dies without release (SIGKILL), the waiting gate takes over", async () => {
  const dir = tempDir();
  const file = path.join(dir, "gate.lock");
  const h = holderKind(file);
  try {
    await h.row(/^held true$/);
    let slept = 0;
    const s = await takeLock({
      file,
      // Wait once, kill the holder meanwhile; a second wait would mean "dead was taken for occupied" — red
      // instead of an endless loop.
      sleep: async () => {
        slept++;
        assert.equal(slept, 1, "kept waiting for a dead holder");
        h.kind.kill("SIGKILL");
        await h.end;
      },
    });
    assert.equal(s.taken, true);
    assert.equal(s.waited, true);
    assert.deepEqual(s.takenOver, { pid: h.kind.pid, reason: "tot" });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
    s.release();
  } finally {
    end(h.kind);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("own: a leftover of THIS process does not hold it up", async () => {
  const dir = tempDir();
  const file = path.join(dir, "gate.lock");
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, start: startOf(process.pid), since: new Date().toISOString() }));
    const s = await takeLock({ file, sleep: () => assert.fail("waiting for oneself would mean forever") });
    assert.equal(s.taken, true);
    assert.deepEqual(s.takenOver, { pid: process.pid, reason: "own" });
    s.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cannot be created: the gate continues without a lock and says why", async () => {
  const dir = tempDir();
  try {
    const s = await takeLock({ file: path.join(dir, "missing", "gate.lock"), sleep: () => assert.fail("nothing to wait for") });
    assert.equal(s.taken, false);
    assert.match(s.reason, /cannot be created: ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("machine-wide: the lock lies outside every working tree", () => {
  // Several worktrees run their gate on the same machine — a lock in the repo would see only itself.
  const repo = path.resolve(HERE, "../..");
  assert.ok(!LOCK.startsWith(repo + path.sep), `the lock lies in the working tree: ${LOCK}`);
  assert.equal(path.dirname(LOCK), fs.existsSync("/tmp") ? "/tmp" : os.tmpdir());
  // Not with the prefix that the cleanup before every run throws away (check.mjs, cleanTestLeftovers).
  assert.ok(!path.basename(LOCK).startsWith("cbase-"), path.basename(LOCK));
});

test("check.mjs: the lock sits BEHIND the quick path, BEFORE the suites, and is released in the finally", () => {
  const check = fs.readFileSync(path.join(HERE, "targets", "check.mjs"), "utf8");
  const fast = check.indexOf("if (quick) {");
  const take = check.indexOf("await takeLock({");
  const run = check.indexOf("await runSuites(");
  const release = check.indexOf("lock.release()");
  assert.ok(fast !== -1 && take !== -1 && run !== -1 && release !== -1, "anchor in check.mjs not found — update it, do NOT delete the test");
  assert.equal(check.indexOf("await takeLock({", take + 1), -1, "exactly one place takes the lock");
  assert.ok(fast < take, "the quick path (pre-push hook, --quick) must never take the lock");
  assert.ok(take < run && run < release, "order: lock → suites → release");
  assert.match(check.slice(run, release + 20), /\} finally \{\s*if \(lock\.taken\) lock\.release\(\);/, "the release is in the finally — a red run would otherwise hold it");
  // The ONE line while waiting names the holder's pid.
  assert.match(check, /waiting for the gate of pid \$\{z\.pid\}/);
  // Whoever waited measures the load anew — the first measurement contained the gate that was waited for,
  // and the backend would otherwise run with 3 although the machine is free by now.
  const fresh = check.indexOf("if (lock.waited) lastStart = os.loadavg()[0];");
  assert.ok(fresh !== -1 && take < fresh && fresh < run, "after waiting at the lock the start load is not measured anew");
});
