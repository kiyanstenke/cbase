// The processes in B that work inside the project folder (projectbox/relocation/processes.js) - over a fake /proc
// (fake-proc.mjs: `stat`, `comm`, `ns/mnt` and `cwd` as links, like the real one). macOS has no /proc; on Linux the
// same guard runs against the same fake.
//
// What holds here:
//   (1) EXACTLY the process is reported that runs in the same mount namespace as B, is not B and no ancestor of B, and
//       whose working directory lies in the project folder after realpath - also through a link into it. NOT: another
//       namespace with the SAME path (inner containers, project containers), `<project>-2` (separator), B itself, an ancestor.
//   (2) Per process ONLY pid, start time (`proc:<field 22>`), program name from `comm`, group, session - never command
//       line or environment. The counter-proof is built in: the values stand in `cmdline`/`environ` of the fake /proc.
//   (3) Unreadable per process (vanished: without `stat`, `comm`, `cwd`, `ns/mnt`) is skipped, never thrown.
//   (4) Unknown is not empty: a /proc that does not exist, one without `self` and a project folder whose location cannot
//       be determined => `null`, never [].
//   (5) `exempt` takes the members of the named process groups out (the native runs the relocation ends itself), nobody else.
//   (6) Two looks (remainingProcesses): whoever ends between them or whose pid was reassigned (other start time) does not
//       count; whoever stays does. No hit in the first look, no second one.
//   (7) Also whoever works in one of the `additional` places (the worktrees step 13 moves); a place without a
//       determinable location => null.
//   (8) A descendant (ppid chain) of an exempt group in its own group carries `descendant`.
//   (9) Program, `maps` and open descriptors in the project count like the working directory.
// No clock: the distance between the looks is the seam `wait`.
//
// Counter-tests: without `additional` the check knows only the project folder - (7) red; no `descendant` - (8) red;
// only the working directory counting (the old fake /proc also created no `exe`/`maps`/`fd`) - (9) red; `descendant`
// always false in the product - (8) red; the working-directory test only through `cwd` - (9) red.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { remainingProcesses, processesInProject, statFields } from "../electron/server/projectbox/relocation/processes.js";
import { FOREIGN_SPACE, fakeProc } from "./fake-proc.mjs";

const B = 4000;
const SECRET = "SECRET_ARGV_4711";

function situation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-relocation-processes-"));
  const ws = path.join(root, "ws");
  const project = path.join(ws, "p");
  for (const d of [path.join(project, "app"), path.join(ws, "p-2"), path.join(root, "elsewhere")]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(project, path.join(root, "reference")); // a path through a link into the project folder
  const proc = fakeProc(path.join(root, "proc"), { itself: B, ancestors: [3000], selfCwd: project });
  return { root, ws, project, proc, cleanUp: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("(1)+(2) exactly the process in the same namespace with its working dir in the project is reported - never B, no ancestor, no other namespace, not <project>-2; only pid, start, program", () => {
  const l = situation();
  try {
    l.proc.process({ pid: 5001, cwd: path.join(l.project, "app"), comm: "node", pgid: 5001, sid: 4900, start: 777, cmdline: `node\0server.js\0--token=${SECRET}\0`, environ: `SECRET=${SECRET}\0` });
    l.proc.process({ pid: 5002, cwd: l.project, space: FOREIGN_SPACE, comm: "postgres" }); // inner container: same path
    l.proc.process({ pid: 5003, cwd: path.join(l.ws, "p-2"), comm: "vite" }); // separator
    l.proc.process({ pid: 5004, cwd: path.join(l.root, "reference", "app"), comm: "next-server" }); // through a link: in the project
    l.proc.process({ pid: 5005, cwd: path.join(l.root, "elsewhere"), comm: "bash" });
    l.proc.process({ pid: 5006, cwd: l.project, comm: "zsh" }); // the root itself counts
    const result = processesInProject({ projectPath: l.project, root: l.proc.root, itself: B });
    assert.deepEqual(result, [
      { pid: 5001, start: "proc:777", program: "node", pgid: 5001, sid: 4900 },
      { pid: 5004, start: "proc:1000", program: "next-server", pgid: 5004, sid: 5004 },
      { pid: 5006, start: "proc:1000", program: "zsh", pgid: 5006, sid: 5006 },
    ]);
    // B (4000) and its ancestor (3000) have their working dir in the project - and are not in the result.
    assert.equal(fs.readlinkSync(path.join(l.proc.root, String(B), "cwd")), l.project);
    assert.equal(fs.readlinkSync(path.join(l.proc.root, "3000", "cwd")), l.project);
    // (2) counter-proof: the values stand in the fake /proc - the output still does not carry them.
    assert.ok(fs.readFileSync(path.join(l.proc.root, "5001", "cmdline"), "utf8").includes(SECRET));
    assert.equal(JSON.stringify(result).includes(SECRET), false, "command line or environment in the output");
    // With another `itself`, B would be a foreign process in the project (the exclusion works, it is not accidental).
    assert.ok(processesInProject({ projectPath: l.project, root: l.proc.root, itself: 1 }).some((p) => p.pid === B));
  } finally { l.cleanUp(); }
});

test("(3) Unreadable per process is skipped, never thrown", () => {
  const l = situation();
  try {
    l.proc.process({ pid: 6001, cwd: l.project, comm: "stays" });
    for (const [pid, file] of [[6002, "stat"], [6003, "comm"], [6004, "cwd"], [6005, path.join("ns", "mnt")]]) {
      l.proc.process({ pid, cwd: l.project, comm: "way" });
      fs.rmSync(path.join(l.proc.root, String(pid), file), { force: true });
    }
    fs.mkdirSync(path.join(l.proc.root, "6006")); // vanished except for the folder
    fs.writeFileSync(path.join(l.proc.root, "6007"), ""); // not a folder
    fs.mkdirSync(path.join(l.proc.root, "net"), { recursive: true }); // not a process
    l.proc.process({ pid: 6008, cwd: l.project, comm: "broken" });
    fs.writeFileSync(path.join(l.proc.root, "6008", "stat"), "6008 (broken S\n"); // without a closing parenthesis
    assert.deepEqual(processesInProject({ projectPath: l.project, root: l.proc.root, itself: B }).map((p) => p.pid), [6001]);
  } finally { l.cleanUp(); }
});

test("(4) Unknown is not empty: no /proc, none including `self`, a project folder without a determinable location => null", () => {
  const l = situation();
  try {
    assert.equal(processesInProject({ projectPath: l.project, root: path.join(l.root, "exists-not"), itself: B }), null);
    fs.rmSync(path.join(l.proc.root, "self"));
    assert.equal(processesInProject({ projectPath: l.project, root: l.proc.root, itself: B }), null, "without own namespace");
    fakeProc(l.proc.root, { itself: B, ancestors: [3000] });
    assert.deepEqual(processesInProject({ projectPath: l.project, root: l.proc.root, itself: B }), [], "counter-proof: with `self` known and empty");
    // A link between anchor and project folder (real root): the location does not count - unknown.
    assert.equal(processesInProject({ projectPath: path.join(l.root, "reference", "app"), anchor: [l.root], root: l.proc.root, itself: B }), null);
    assert.equal(fs.lstatSync(path.join(l.root, "reference")).isSymbolicLink(), true);
  } finally { l.cleanUp(); }
});

test("(5) exempt takes out only the members of the named process groups", () => {
  const l = situation();
  try {
    l.proc.process({ pid: 7000, cwd: l.project, comm: "sh", pgid: 7000 }); // leader of a native run
    l.proc.process({ pid: 7001, cwd: path.join(l.project, "app"), comm: "node", pgid: 7000 }); // its child
    l.proc.process({ pid: 7289, cwd: path.join(l.project, "app"), comm: "node", pgid: 7289 }); // own group
    const including = (exempt) => processesInProject({ projectPath: l.project, root: l.proc.root, itself: B, exempt }).map((p) => p.pid);
    assert.deepEqual(including([7000]), [7289]);
    assert.deepEqual(including([]), [7000, 7001, 7289], "counter-proof: without exemption all three");
    assert.deepEqual(including([7001]), [7000, 7001, 7289], "a pid that is no group takes nobody out");
  } finally { l.cleanUp(); }
});

test("(6) two looks: whoever ends in between or whose pid was reassigned does not count; whoever stays does - no hit, no waiting", async () => {
  const l = situation();
  try {
    const opts = { projectPath: l.project, root: l.proc.root, itself: B };
    let waited = 0;
    assert.deepEqual(await remainingProcesses(opts, { wait: async () => { waited += 1; } }), []);
    assert.equal(waited, 0, "waited without a hit");
    l.proc.process({ pid: 8001, cwd: l.project, comm: "git" }); // a `git status` of the UI
    l.proc.process({ pid: 8002, cwd: l.project, comm: "node", start: 50 });
    l.proc.process({ pid: 8003, cwd: l.project, comm: "vite" });
    const result = await remainingProcesses(opts, {
      quietMs: 1234,
      wait: async (ms) => {
        assert.equal(ms, 1234);
        waited += 1;
        l.proc.gone(8001); // ends
        l.proc.process({ pid: 8002, cwd: l.project, comm: "node", start: 51 }); // pid reassigned
      },
    });
    assert.equal(waited, 1);
    assert.deepEqual(result.map((p) => p.pid), [8003]);
    // Unknown in the second look stays unknown.
    assert.equal(await remainingProcesses(opts, { wait: async () => fs.rmSync(path.join(l.proc.root, "self")) }), null);
  } finally { l.cleanUp(); }
});

test("statFields: counted behind the LAST parenthesis - a name containing \") \" shifts nothing", () => {
  assert.deepEqual(statFields("42 (a) b) S 7 42 40 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 9999 0 0\n"), { ppid: 7, pgid: 42, sid: 40, start: "proc:9999" });
  assert.equal(statFields("42 (x S 7"), null);
  assert.equal(statFields(""), null);
});

// ── Additional places, descendants, program/maps/descriptors ─────────────────────────────────────────────────────────

test("(7) whoever works in a worktree that step 13 moves (`additional`) is reported; a place without a determinable location => null", () => {
  const l = situation();
  try {
    const wt1 = path.join(l.root, "scratch", "worktrees", "wt1");
    fs.mkdirSync(wt1, { recursive: true });
    l.proc.process({ pid: 5101, cwd: wt1, comm: "vite" });
    const including = (additional) => processesInProject({ projectPath: l.project, additional, root: l.proc.root, itself: B });
    assert.deepEqual(including([wt1]).map((p) => p.pid), [5101]);
    assert.deepEqual(including([]), [], "counter-proof: without the worktree nobody there works in the project");
    // A place whose location cannot be determined (a link loop): unknown, never "nobody".
    fs.symlinkSync(path.join(l.root, "loop-b"), path.join(l.root, "loop-a"));
    fs.symlinkSync(path.join(l.root, "loop-a"), path.join(l.root, "loop-b"));
    assert.equal(including([wt1, path.join(l.root, "loop-a", "x")]), null);
  } finally { l.cleanUp(); }
});

test("(8) a descendant of an exempt group in its OWN group carries descendant - also over two generations; without exemption nobody", () => {
  const l = situation();
  try {
    const elsewhere = path.join(l.root, "elsewhere");
    l.proc.process({ pid: 501, cwd: elsewhere, comm: "sh", pgid: 501 }); // leader of the native run
    l.proc.process({ pid: 600, cwd: elsewhere, comm: "npm", ppid: 501, pgid: 501 });
    l.proc.process({ pid: 700, cwd: l.project, comm: "node", ppid: 600, pgid: 700 }); // own group (setsid, detached)
    l.proc.process({ pid: 800, cwd: l.project, comm: "esbuild", ppid: 700, pgid: 700 });
    l.proc.process({ pid: 900, cwd: l.project, comm: "vite", ppid: 1, pgid: 900 }); // no descendant
    const including = (exempt) => processesInProject({ projectPath: l.project, exempt, root: l.proc.root, itself: B });
    assert.deepEqual(including([501]).map((p) => [p.pid, p.descendant === true]), [[700, true], [800, true], [900, false]]);
    assert.ok(!Object.hasOwn(including([501]).find((p) => p.pid === 900), "descendant"), "a process without the marker does not carry the field");
    assert.deepEqual(including([]).map((p) => [p.pid, p.descendant === true]), [[700, false], [800, false], [900, false]], "without exemption there are no descendants");
  } finally { l.cleanUp(); }
});

test("(9) program (`exe`), `maps` and open files (`fd/*`) in the project count like the working dir - absolute paths only, never cmdline/environ", () => {
  const l = situation();
  try {
    const outside = path.join(l.root, "elsewhere");
    l.proc.process({ pid: 5201, cwd: "/", comm: "pg", fd: { 0: "/dev/null", 3: path.join(l.project, "data.db"), 4: "socket:[4711]" } });
    l.proc.process({ pid: 5202, cwd: "/", comm: "server", exe: path.join(l.project, "bin", "server") });
    l.proc.process({ pid: 5203, cwd: "/", comm: "py", maps: ["[heap]", "/usr/lib/libc.so.6", `${path.join(l.project, "lib", "x.so")} (deleted)`] });
    l.proc.process({ pid: 5204, cwd: "/", comm: "foreign", exe: "/usr/bin/node", maps: ["[stack]", "/usr/lib/libc.so.6"], fd: { 3: path.join(outside, "x.db"), 4: "pipe:[1]" }, cmdline: `node\0${l.project}/x.js\0`, environ: `HOME=${l.project}\0` });
    const result = processesInProject({ projectPath: l.project, root: l.proc.root, itself: B });
    assert.deepEqual(result.map((p) => p.pid), [5201, 5202, 5203], "fd, exe and maps in the project - not the foreign process (only cmdline/environ name the project)");
  } finally { l.cleanUp(); }
});
