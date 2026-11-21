// The process-group wrapper of the project container, server/backend/cbase-wrapper (perl). server/backend/ is in no glob of the
// gate, hence the guard lives here. The REAL file runs with the real group semantics of macOS (perl is there as in bookworm) — no
// replica.
//
// Setup of each run: the test starts a "caller" (sh, own process group — so no group kill ever hits the test process), the caller
// calls the wrapper, the wrapper the long runner (sh), the long runner a grandchild (sleep). Caller and long runner write who has
// which pid into files (atomically via mv); the test waits for these files and for the children to end, never for a duration. Every
// group is killed hard in `finally`.
//
// Guarantees and their counter-tests:
//   - without --log the command itself runs (exec, argv[0] stays, no wrapper in ps) and leads its OWN group; the id is in P;
//     `kill -TERM -<pgid>` ends long runner AND grandchild, the caller lives on and sees 143.
//     Counter-test: a kill on the command's pid alone leaves the grandchild alive.
//     Sabotage: a copy without setsid writes the caller's group — the check is red.
//   - with --log/--exit a child leads the group, the parent is not part of it, survives the group kill and writes the code (143)
//     to E; output appends to L; a normal end writes its code (7).
//     Sabotage: a copy without setsid in the child — the check is red.
//   - without a written P the command never runs (missing folder => 125, no run), likewise when L cannot be opened; usage error =>
//     125; missing command => 127 (with --log: 127 in E).
//
// Run:  node --test --test-reporter=tap tools/check/wrapper.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const WRAPPER = path.join(REPO, "server/backend/cbase-wrapper");

const tick = () => new Promise((r) => setTimeout(r, 20)); // a beat, not a deadline
const read = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; } };
const ps = (field, pid) => spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
const groupOf = (pid) => Number(ps("pgid", pid));
// A zombie counts as dead: its parent just has not reaped it yet.
const alive = (pid) => { const s = ps("stat", pid); return s !== "" && !s.startsWith("Z"); };
const ended = (k) => k.exitCode !== null || k.signalCode !== null;

// Waits until `check()` yields something. If one of the `children` ends first, one last check is made and otherwise it throws —
// a dead caller does not leave the test hanging.
async function waitUntil(check, children = [], what = "event") {
  for (;;) {
    const w = check();
    if (w) return w;
    if (children.some(ended)) {
      const w2 = check();
      if (w2) return w2;
      throw new Error(`${what}: a child ended earlier`);
    }
    await tick();
  }
}

function build() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-group-test-"));
  const b = {
    d,
    pgid: path.join(d, "run.pgid"),
    exit: path.join(d, "run.exit"),
    log: path.join(d, "run.log"),
    rc: path.join(d, "caller.rc"),
    longRunnerPid: path.join(d, "duration.pid"),
    grandchild: path.join(d, "grandchild.pid"),
    duration: path.join(d, "duration.sh"),
    marker: path.join(d, "ran"),
    bin: path.join(d, "bin"),
    groups: new Set(),
  };
  // The long runner: starts the grandchild, reports both pids, waits. Nothing in it ends by itself.
  fs.writeFileSync(b.duration, [
    "sleep 100000 &",
    `echo $! > "${b.grandchild}.new" && mv "${b.grandchild}.new" "${b.grandchild}"`,
    `echo $$ > "${b.longRunnerPid}.new" && mv "${b.longRunnerPid}.new" "${b.longRunnerPid}"`,
    "echo duration-running",
    "wait",
    "",
  ].join("\n"));
  fs.mkdirSync(b.bin);
  return b;
}

// The caller: an sh in its OWN group (detached) that calls the wrapper and then writes its exit code to `rc`.
function startCaller(b, args, wrapper = WRAPPER) {
  const a = spawn("/bin/sh", ["-c", 'h="$1"; shift; "$h" "$@"; echo "rc=$?" > "$WRAPPER_RC.fresh" && mv "$WRAPPER_RC.fresh" "$WRAPPER_RC"', "caller", wrapper, ...args], {
    detached: true,
    stdio: "ignore",
    env: { PATH: "/usr/bin:/bin", WRAPPER_RC: b.rc },
  });
  b.groups.add(a.pid);
  return a;
}

function cleanUp(b) {
  for (const p of [read(b.pgid), read(b.longRunnerPid)].map(Number).filter((n) => n > 1)) b.groups.add(p);
  for (const g of b.groups) { try { process.kill(-g, "SIGKILL"); } catch { /* already gone */ } }
  const e = Number(read(b.grandchild));
  if (e > 1) { try { process.kill(e, "SIGKILL"); } catch { /* already gone */ } }
  fs.rmSync(b.d, { recursive: true, force: true });
}

// Up to just before the kill: what the wrapper created, and who is in which group.
async function startLongRunner(b, args, wrapper) {
  const a = startCaller(b, [...args, "--", "/bin/sh", b.duration], wrapper);
  await waitUntil(() => read(b.pgid) && read(b.longRunnerPid) && read(b.grandchild), [a], "pgid and pid files");
  const pgid = Number(read(b.pgid));
  const duration = Number(read(b.longRunnerPid));
  const grandchild = Number(read(b.grandchild));
  const parent = Number(ps("ppid", duration));
  return {
    a, pgid, duration, grandchild, parent,
    groupDuration: groupOf(duration), groupGrandchild: groupOf(grandchild), groupCaller: groupOf(a.pid), groupParent: groupOf(parent),
    row: ps("command", duration),
  };
}

// The group guarantee on a run — as a function so the same check turns red on a sabotaged copy.
function checkGroup(s, { withLog }) {
  assert.equal(s.pgid, s.duration, `P names ${s.pgid}, the command is led by ${s.duration}`);
  assert.equal(s.groupDuration, s.duration, "the command is not leader of its group");
  assert.equal(s.groupGrandchild, s.pgid, "the grandchild is not in the group from P");
  assert.notEqual(s.groupCaller, s.pgid, "the caller is in the group — a kill would hit it too");
  assert.equal(s.groupCaller, s.a.pid);
  if (withLog) {
    assert.notEqual(s.parent, s.a.pid, "with --log the wrapper waits as the parent — it is missing");
    assert.notEqual(s.groupParent, s.pgid, "the waiting parent is in the group — it would never write the code");
  } else {
    assert.equal(s.parent, s.a.pid, "without --log the wrapper replaces itself (exec) — an intermediate process remained");
    assert.ok(!s.row.includes("cbase-wrapper") && s.row.includes("duration.sh"), `ps shows: ${s.row}`);
  }
}

// A copy with places removed; each must hit, otherwise the counter-test would check the unchanged file.
function sabotage(b, name, ...places) {
  let text = fs.readFileSync(WRAPPER, "utf8");
  for (const from of places) {
    const fresh = text.replace(from, "");
    assert.notEqual(fresh, text, `the place "${String(from).slice(0, 60)}" has moved — the sabotage does not bite`);
    text = fresh;
  }
  const p = path.join(b.d, name);
  fs.writeFileSync(p, text, { mode: 0o755 });
  return p;
}

// ── without --log ────────────────────────────────────────────────────────────────────────────

test("perl is there (gate: macOS; image: perl-base) and the wrapper is executable", () => {
  assert.equal(spawnSync("perl", ["-c", WRAPPER], { encoding: "utf8" }).status, 0);
  assert.ok((fs.statSync(WRAPPER).mode & 0o111) === 0o111, "the wrapper is not executable (git carries the x bit)");
  assert.match(fs.readFileSync(WRAPPER, "utf8").split("\n")[0], /^#!\/usr\/bin\/perl\b/);
});

test("without --log: the command leads its own group, P names it; kill -TERM -<pgid> ends command and grandchild, the caller lives on", async () => {
  const b = build();
  try {
    const s = await startLongRunner(b, ["--pgid-file", b.pgid]);
    checkGroup(s, { withLog: false });
    process.kill(-s.pgid, "SIGTERM");
    assert.equal(await waitUntil(() => read(b.rc), [s.a], "caller's report"), "rc=143", "the caller saw no TERM end of its command");
    await waitUntil(() => !alive(s.grandchild) && !alive(s.duration), [], "end of command and grandchild");
    await waitUntil(() => ended(s.a), [], "end of the caller");
    assert.equal(s.a.exitCode, 0, "the caller was hit");
  } finally { cleanUp(b); }
});

test("counter-test: a kill on the command's pid alone leaves the grandchild alive", async () => {
  const b = build();
  try {
    const s = await startLongRunner(b, ["--pgid-file", b.pgid]);
    process.kill(s.duration, "SIGTERM");
    assert.equal(await waitUntil(() => read(b.rc), [s.a], "caller's report"), "rc=143");
    assert.equal(alive(s.grandchild), true, "the grandchild is gone — then no group would be needed, and the test above would prove nothing");
  } finally { cleanUp(b); }
});

test("sabotage: a copy without setsid writes the caller's group — the group check is red", async () => {
  const b = build();
  try {
    const copy = sabotage(b, "without-setsid-1", "  become_leader();\n", /^\s*error\("the process's own group is not \$\$.*\n/m);
    const s = await startLongRunner(b, ["--pgid-file", b.pgid], copy);
    assert.equal(s.pgid, s.a.pid, "without setsid the command inherits the caller's group");
    assert.throws(() => checkGroup(s, { withLog: false }), assert.AssertionError);
  } finally { cleanUp(b); }
});

test("argv[0] stays the command (the deploy's oneshot detection hangs on the name `claude`)", () => {
  const b = build();
  try {
    fs.symlinkSync(process.execPath, path.join(b.bin, "claude"));
    const out = path.join(b.d, "argv0");
    const r = spawnSync(WRAPPER, ["--pgid-file", b.pgid, "--", "claude", "-e", "require('fs').writeFileSync(process.env.WRAPPER_OUT, process.argv0)"], {
      env: { PATH: `${b.bin}:/usr/bin:/bin`, WRAPPER_OUT: out }, encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(out), "claude");
    assert.match(read(b.pgid), /^\d+$/);
  } finally { cleanUp(b); }
});

// ── with --log/--exit ────────────────────────────────────────────────────────────────────────

test("with --log/--exit: output appends to L, stdin is /dev/null, E carries the code, the wrapper ends with it", () => {
  const b = build();
  try {
    fs.writeFileSync(b.log, "before\n");
    const r = spawnSync(WRAPPER, ["--pgid-file", b.pgid, "--log", b.log, "--exit", b.exit, "--", "/bin/sh", "-c",
      'echo "kind=$$"; echo aus; echo err >&2; if read x; then echo "stdin=$x"; else echo stdin-empty; fi; exit 7'], {
      input: "not-for-the-service\n", encoding: "utf8",
    });
    assert.equal(r.status, 7, r.stderr);
    assert.equal(read(b.exit), "7");
    const log = fs.readFileSync(b.log, "utf8");
    assert.match(log, /^before\nkind=\d+\naus\nerr\nstdin-empty\n$/, log);
    assert.equal(read(b.pgid), log.match(/kind=(\d+)/)[1], "P does not name the child that leads the command");
    assert.equal(r.stdout, "", "the service's output did not go (only) to the log");
  } finally { cleanUp(b); }
});

test("with --log/--exit: a child leads the group; kill -TERM -<pgid> ends command and grandchild, the parent writes 143 to E", async () => {
  const b = build();
  try {
    const s = await startLongRunner(b, ["--pgid-file", b.pgid, "--log", b.log, "--exit", b.exit]);
    checkGroup(s, { withLog: true });
    assert.equal(read(b.exit), "", "E before the end");
    process.kill(-s.pgid, "SIGTERM");
    assert.equal(await waitUntil(() => read(b.exit), [s.a], "exit file"), "143");
    assert.equal(await waitUntil(() => read(b.rc), [s.a], "caller's report"), "rc=143", "the wrapper does not end with the command's code");
    await waitUntil(() => !alive(s.grandchild) && !alive(s.duration), [], "end of command and grandchild");
    assert.match(fs.readFileSync(b.log, "utf8"), /duration-running/);
  } finally { cleanUp(b); }
});

test("sabotage: a copy without setsid in the child — the group check is red", async () => {
  const b = build();
  try {
    const copy = sabotage(b, "without-setsid-2", /^\s*defined\(POSIX::setsid\(\)\) or kind_error.*\n/m, /^\s*kind_error\("the process's own group is not \$\$"\).*\n/m);
    const s = await startLongRunner(b, ["--pgid-file", b.pgid, "--log", b.log, "--exit", b.exit], copy);
    assert.throws(() => checkGroup(s, { withLog: true }), assert.AssertionError);
  } finally { cleanUp(b); }
});

// ── No run without P, error codes ─────────────────────────────────────────────────────────────

test("without a writable pgid file the command never runs (125) — with and without --log", () => {
  const b = build();
  try {
    const p = path.join(b.d, "missing", "run.pgid");
    const r1 = spawnSync(WRAPPER, ["--pgid-file", p, "--", "/usr/bin/touch", b.marker], { encoding: "utf8" });
    assert.equal(r1.status, 125, r1.stderr);
    assert.match(r1.stderr, /pgid file not written/);
    const r2 = spawnSync(WRAPPER, ["--pgid-file", p, "--log", b.log, "--exit", b.exit, "--", "/usr/bin/touch", b.marker], { encoding: "utf8" });
    assert.equal(r2.status, 125, r2.stderr);
    assert.equal(read(b.exit), "125");
    assert.equal(fs.existsSync(b.marker), false, "the command ran without a pgid file");
  } finally { cleanUp(b); }
});

test("a log that cannot be opened: 125 in E, the command does not run", () => {
  const b = build();
  try {
    const r = spawnSync(WRAPPER, ["--pgid-file", b.pgid, "--log", path.join(b.d, "missing", "l"), "--exit", b.exit, "--", "/usr/bin/touch", b.marker], { encoding: "utf8" });
    assert.equal(r.status, 125);
    assert.equal(read(b.exit), "125");
    assert.equal(fs.existsSync(b.marker), false);
  } finally { cleanUp(b); }
});

test("usage errors end with 125 without starting the command", () => {
  const b = build();
  try {
    const command = ["/usr/bin/touch", b.marker];
    for (const [args, pattern] of [
      [["--", ...command], /--pgid-file missing/],
      [["--pgid-file", b.pgid, ...command], /unknown argument/],
      [["--pgid-file", b.pgid, "--"], /no command/],
      [["--pgid-file", b.pgid, "--log", b.log, "--", ...command], /only valid together/],
      [["--pgid-file", b.pgid, "--exit", b.exit, "--", ...command], /only valid together/],
      [["--pgid-file", "", "--", ...command], /without a value/],
      [["--pgid-file"], /without a value/],
      [["--who", "--", ...command], /unknown argument/],
    ]) {
      const r = spawnSync(WRAPPER, args, { encoding: "utf8" });
      assert.equal(r.status, 125, `${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, pattern, args.join(" "));
    }
    assert.equal(fs.existsSync(b.marker), false);
    assert.equal(fs.existsSync(b.pgid), false);
  } finally { cleanUp(b); }
});

test("a missing command ends with 127 (with --log: 127 in E and the message in the log)", () => {
  const b = build();
  try {
    const r1 = spawnSync(WRAPPER, ["--pgid-file", b.pgid, "--", "cbase-exists-not"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(r1.status, 127, r1.stderr);
    const r2 = spawnSync(WRAPPER, ["--pgid-file", b.pgid, "--log", b.log, "--exit", b.exit, "--", "cbase-exists-not"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(r2.status, 127);
    assert.equal(read(b.exit), "127");
    assert.match(fs.readFileSync(b.log, "utf8"), /exec cbase-exists-not/);
  } finally { cleanUp(b); }
});
