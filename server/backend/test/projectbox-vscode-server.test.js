// Guards for the cleanup of old VS Code server versions (projectbox/vscode-server.js). The rule itself (the mount
// `cli-vscode-server`, the source, creating it without a link, the hash of the copy) is held by projectbox-creation.test.js.
//
// Held:
//   (S) THE SCRIPT with a real `sh` against a temp folder (it is fixed shell; the fake docker runs it locally the same way): only
//       real folders `<40 base-16>` / `<40 base-16>_<digits>` are touched — a foreign name, capitals, 39/41 characters, a file, a
//       link with a version name (whose target lies outside) and a name with a line break (`<40 base-16>⏎foo`, with a foreign
//       folder `foo`) stay; of the finished ones the TWO NEWEST by mtime stay (the names are chosen so that name order in either
//       direction would keep a different pair); a half-finished one only after 60 min; nothing a process runs from (command line or
//       target of exe, with `/` behind the name). Built-in counter-test: the same situation with an EMPTY /proc deletes the running
//       ones too. Nothing without a mount point (`no-mount`: no mountinfo entry, only a neighbour, the file missing, the path
//       unencoded) — with a space and backslash in the path the kernel's encoding applies; nothing with a foreign inode
//       (`other-folder`). `.vscode-server` or `bin` as a link, missing, empty: nothing, exit 0. A failing `rm` (a fake `rm` in
//       the PATH, independent of root): exit 1, a line on stderr, the rest go anyway.
//   (B) causeInB: counts only real folders through the descriptor in the runtime folder — a link at `.vscode-server` or `bin`
//       (outward OR inside), a missing folder and a place outside a runtime folder are "no cause" (with a reason), never a throw; at
//       the cap "cause" holds with `cap: true`; `ino` is the source's.
//   (A) cleanUpVscodeServer through the fake docker on a server in the test process: without a cause NO docker call; with a cause
//       exactly `docker exec -u agent cbase-p-<id> sh -c <script> … <home>/.vscode-server 2 60 <proc> <ino>`, the old version is gone,
//       the running one stays; `no-mount` is a note in the log; the cap in B is in the log; a second call while one runs:
//       `running-already`; the cap of the exec (via advanceCap, no clock) and a missing container are `error` with a warning
//       including the project id — never a throw; copy and no operation: nothing.
//   (R) THE CONSUMER in server.js: after the main is restored the cleanup starts (runningCleanUp after the tick of atReady), with
//       the home of the creation (creationOptionsFor) — and without test seams (real /proc) it cleans NOTHING in the test: no mount
//       point (the protection of the developer's real `~/.vscode-server`).
//   THE PROTECTED VERSION (the newest from Microsoft, projectbox/vscode-upfront.js): the script never deletes it and does not count
//       it among the two newest. The real situation: it is the NEWEST (build time), the Mac still works with the version before —
//       without protection the two newest would keep the pre-placed one and one more, and the Mac's version before would fall one
//       step earlier; with protection only the fourth falls. Plus the artificial situation in which it is the OLDEST (without
//       protection it would fall itself). Built-in counter-test without a sixth argument and with an empty one; an invalid
//       protection is exit 2 without any change. causeInB does not count it as a cause; cleanUpVscodeServer passes the value from
//       app_settings (invalid => empty; with `CBASE_VSCODE_UPFRONT_MS=0` also empty — a switched-off upfront fetch protects
//       nothing). The arguments in (A) and (R) therefore carry a sixth (empty: nothing in app_settings, and withOps switches the
//       upfront fetch off).
//   TWO PROTECTED VERSIONS: the newest AND the used one (the Mac's, USED_KEY). The sixth argument is a comma list: both stay, neither
//       counts among the two newest (the real situation: the Mac's is the OLDEST) — counter-tests built in with only the newest
//       (the Mac's falls) and without protection; the order does not matter, a duplicate is allowed; an empty member, capitals, a space,
//       39 characters, another separator => exit 2 without change. protectedVersions: the newest before the used one, no duplicates,
//       invalid ones drop out, switched off []; causeInB counts neither as a cause and throws on a single value (the older form —
//       silently without protection would be worse); cleanUpVscodeServer sends "newest,used".
//   `protectedAlongside`: the upfront fetch cleans up after placing and protects the just-placed versions ON TOP (vscode-upfront.js
//       upfrontProject; the path itself: projectbox-vscode-upfront "(D)"). The one protected on top stays, also as the oldest and
//       unsaved; the saved ones first, no duplicates ("N,X"); an invalid member, a comma in a member and a single value => `error`
//       with a warning, NO docker, nothing falls; counter-test built in (without `protectedAlongside` it falls).
//
// COUNTER-TESTS: see the map at the end.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DIRS, setDirs } from "../electron/server/app-state.js";
import * as store from "../electron/server/store.js";
import { VSCODE_SERVER, containerName } from "../electron/server/projectbox/creation.js";
import { advanceCap } from "../electron/server/projectbox/docker.js";
import { createInstance } from "../electron/server/projectbox/instance.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { setCreationOptions } from "../electron/server/projectbox/recreate.js";
import { restoreInstance } from "../electron/server/projectbox/restore.js";
import {
  CAUSE_CAP, CLEAN_UP_SCRIPT, KEEP, USED_KEY, HALF_DONE_MIN, NEWEST_KEY, causeInB, readOutput,
  protectedVersions, savedVersion, runningCleanUp, cleanUpVscodeServer, vscodeServerLocations,
} from "../electron/server/projectbox/vscode-server.js";
import { locationFor } from "../electron/server/runs/runtime-location.js";
import { withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { ID, withOps, scenario } from "./projectbox-scenario.mjs";

const HEX = (z, n = 40) => z.repeat(n);
const HOUR = 3600;

// A version folder with a file in it; mtime `ageS` seconds back (AFTER writing — writing resets it).
function version(p, ageS) {
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "node"), `${path.basename(p)}\n`);
  const t = Date.now() / 1000 - ageS;
  fs.utimesSync(p, t, t);
  return p;
}

// A /proc to read: per process `cmdline` (NUL-separated like the real one) and/or `exe` (link); plus entries that are not a pid,
// and `self/mountinfo` with the mount points `mounts` (field 5, encoded like the kernel: `\040` space, `\011`, `\012`, `\134`;
// `raw: true` writes them unencoded — as a reader that does not compare encoded would see them).
const encoded = (p) => p.replace(/\\/g, "\\134").replace(/ /g, "\\040").replace(/\t/g, "\\011").replace(/\n/g, "\\012");
function proc(root, list, { mounts = [], raw = false, withoutMountinfo = false } = {}) {
  fs.mkdirSync(root, { recursive: true });
  for (const p of list) {
    const d = path.join(root, String(p.pid));
    fs.mkdirSync(d);
    if (p.cmdline) fs.writeFileSync(path.join(d, "cmdline"), p.cmdline.map((a) => `${a}\0`).join(""));
    if (p.exe) fs.symlinkSync(p.exe, path.join(d, "exe"));
  }
  for (const x of ["self", "net"]) fs.mkdirSync(path.join(root, x), { recursive: true });
  if (!withoutMountinfo) {
    const rows = ["22 1 0:21 / / rw,relatime master:1 - overlay overlay rw",
      ...mounts.map((m, i) => `${100 + i} 22 8:1 /var/lib/source-${i} ${raw ? m : encoded(m)} rw,relatime - ext4 /dev/sda1 rw`)];
    fs.writeFileSync(path.join(root, "self", "mountinfo"), `${rows.join("\n")}\n`);
  }
  return root;
}

// The inode B would see at the source (lstat, exact as BigInt) — "0" if the folder does not exist.
const inoOf = (p) => { try { return String(fs.lstatSync(p, { bigint: true }).ino); } catch { return "0"; } };

// The script as in the container: `sh -c <script> <$0> <vs> <keep> <minutes> <proc> <ino> [<protection>]`; `pathFront` puts
// programs in front of the PATH; `protection` is the sixth argument — without it the argument is missing (the script takes it as empty).
function script(vs, procRoot, { pathFront, ino = inoOf(vs), protection } = {}) {
  const env = { ...process.env, ...(pathFront ? { PATH: `${pathFront}:${process.env.PATH}` } : {}) };
  const r = spawnSync("sh", ["-c", CLEAN_UP_SCRIPT, "cbase-vscode-clean-up", vs, String(KEEP), String(HALF_DONE_MIN), procRoot, ino, ...(protection === undefined ? [] : [protection])], { encoding: "utf8", env });
  return { code: r.status, out: r.stdout, err: r.stderr, ...readOutput(r.stdout) };
}

const content = (d) => fs.readdirSync(d).sort();
const sorted = (a) => [...a].sort();

function withTemp(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-vscode-")));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// The situation of (S): `vs` (the folder as the script sees it in the container) with every kind of entry.
function situation(root, { home = path.join(root, "home") } = {}) {
  const vs = path.join(home, VSCODE_SERVER);
  const bin = path.join(vs, "bin");
  const outside = path.join(root, "outside");
  version(path.join(outside, "target"), 10 * HOUR);
  fs.writeFileSync(path.join(outside, "target", "MARKER"), "stays\n");
  // Finished ones: the name order (1 3 5 7 8 9) is NOT the mtime order (9 5 1 7 3 8) — ascending would keep 1/3, descending 9/8.
  const v = {
    recent: HEX("9"), second: HEX("5"), runningCmd: HEX("1"), runningExe: HEX("7"), alt1: HEX("3"), alt2: HEX("8"),
    halfOld: `${HEX("2")}_1700000000`, halfFresh: `${HEX("4")}_1700000001`, halfRunning: `${HEX("6")}_12`,
  };
  const ages = { recent: 10, second: HOUR, runningCmd: 2 * HOUR, runningExe: 3 * HOUR, alt1: 4 * HOUR, alt2: 5 * HOUR, halfOld: 2 * HOUR, halfFresh: 10 * 60, halfRunning: 3 * HOUR };
  for (const [k, name] of Object.entries(v)) version(path.join(bin, name), ages[k]);
  // What is never touched, all ancient — including names that would count as a version line by line (grep), and a foreign
  // folder `foo` that splitting `<40 base-16>⏎foo` hit in the old script:
  const foreign = ["foreign", "foo", HEX("A"), HEX("b", 41), HEX("c", 39), `${HEX("d")}_x`, `${HEX("d")}_`, `${HEX("d")}_1_2`,
    `${HEX("3")}\nfoo`, `${HEX("4")}_1\n2`, `foo\n${HEX("8")}`];
  for (const n of foreign) version(path.join(bin, n), 10 * HOUR);
  fs.writeFileSync(path.join(bin, HEX("e")), "a file with version names\n");
  fs.utimesSync(path.join(bin, HEX("e")), Date.now() / 1000 - 10 * HOUR, Date.now() / 1000 - 10 * HOUR);
  fs.symlinkSync(path.join(outside, "target"), path.join(bin, HEX("f")));
  fs.symlinkSync(path.join(outside, "target"), path.join(bin, `${HEX("a")}_1`));
  const unchanged = [...foreign, HEX("e"), HEX("f"), `${HEX("a")}_1`];
  return { vs, bin, outside, v, unchanged };
}

// The processes of (S): one with the version in the command line, one only via exe, one from a half-finished one; plus noise: a
// path WITHOUT `/` behind the name (does not run from it), the folder `bin/` itself, an entry without cmdline.
function processesOf(root, vs, v) {
  return proc(path.join(root, "proc"), [
    { pid: 100, cmdline: [`${vs}/bin/${v.runningCmd}/node`, `${vs}/bin/${v.runningCmd}/out/server-main.js`, "--start-server"] },
    { pid: 101, cmdline: ["sleep", "1000"], exe: `/home/agent/.vscode-server/bin/${v.runningExe}/node` },
    { pid: 102, cmdline: [`/home/agent/.vscode-server/bin/${v.halfRunning}/node`, "x"] },
    { pid: 103, cmdline: ["ls", `/home/agent/.vscode-server/bin/${v.alt1}`] },
    { pid: 104, cmdline: ["bash", "-c", "ls /home/agent/.vscode-server/bin/"] },
    { pid: 105 },
  ], { mounts: [vs] });
}

test("(S) script: only real version folders (not a name with a line break either), the two newest finished ones stay, half-finished ones only after 60 min, never a running one — counter-test with an empty /proc", () => {
  withTemp((root) => {
    const { vs, bin, outside, v, unchanged } = situation(root);
    const r = script(vs, processesOf(root, vs, v));
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, "");
    assert.deepEqual(sorted(r.removed), sorted([v.alt1, v.alt2, v.halfOld]), r.out);
    assert.deepEqual(sorted(r.running), sorted([v.runningCmd, v.runningExe, v.halfRunning]), r.out);
    assert.deepEqual(content(bin), sorted([v.recent, v.second, v.runningCmd, v.runningExe, v.halfFresh, v.halfRunning, ...unchanged]), "a foreign folder or a young version was deleted");
    for (const n of [v.recent, v.second, v.runningCmd, "foo"]) assert.equal(fs.readFileSync(path.join(bin, n, "node"), "utf8"), `${n}\n`, `${n}: content touched`);
    assert.equal(fs.readFileSync(path.join(outside, "target", "MARKER"), "utf8"), "stays\n", "the target of a link with version names was touched");
    assert.ok(fs.lstatSync(path.join(bin, HEX("f"))).isSymbolicLink());
    // A second run: nothing left to do (the running ones still run).
    const r2 = script(vs, path.join(root, "proc"));
    assert.deepEqual([r2.code, r2.removed], [0, []], r2.out);
  });
  // Built-in counter-test: the same situation, no process — the running ones go too; the two newest stay anyway.
  withTemp((root) => {
    const { vs, bin, v, unchanged } = situation(root);
    const r = script(vs, proc(path.join(root, "proc"), [], { mounts: [vs] }));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(sorted(r.removed), sorted([v.alt1, v.alt2, v.halfOld, v.runningCmd, v.runningExe, v.halfRunning]), r.out);
    assert.deepEqual(r.running, []);
    assert.deepEqual(content(bin), sorted([v.recent, v.second, v.halfFresh, ...unchanged]));
  });
});

test("(S) script: only a MOUNT POINT (mountinfo field 5, exact, encoded) and only the same inode — otherwise `no-mount` / `other-folder`, nothing touched", () => {
  withTemp((root) => {
    const { vs, bin, v } = situation(root);
    const prior = content(bin);
    const cases = [
      ["no entry", proc(path.join(root, "p1"), [])],
      ["only neighbours (bin below, a longer name, the home above)", proc(path.join(root, "p2"), [], { mounts: [path.join(vs, "bin"), `${vs}x`, path.dirname(vs)] })],
      ["no mountinfo", proc(path.join(root, "p3"), [], { withoutMountinfo: true })],
      ["/proc missing entirely (the Mac)", path.join(root, "exists-not")],
    ];
    for (const [name, p] of cases) {
      const r = script(vs, p);
      assert.deepEqual({ code: r.code, out: r.out, err: r.err }, { code: 0, out: "no-mount\n", err: "" }, name);
    }
    const other = script(vs, proc(path.join(root, "p4"), [], { mounts: [vs] }), { ino: "1" });
    assert.deepEqual({ code: other.code, out: other.out }, { code: 0, out: "other-folder\n" }, "a foreign inode");
    assert.deepEqual(content(bin), prior, "something was touched without a mount point or with a foreign inode");
    // Counter-test: the same folder WITH a mount point and the right inode cleans up.
    const r = script(vs, proc(path.join(root, "p5"), [], { mounts: [vs] }));
    assert.ok(r.removed.includes(v.alt1), r.out);
  });
  // Space and backslash in the path: the kernel writes `\040` and `\134` — the comparison is encoded, unencoded counts for nothing.
  withTemp((root) => {
    const home = path.join(root, "with blank\\slash", "home");
    const { vs, bin, v } = situation(root, { home });
    const unencoded = script(vs, proc(path.join(root, "p6"), [], { mounts: [vs], raw: true }));
    assert.equal(unencoded.out, "no-mount\n", "an unencoded path with a space would count as a mount point");
    const r = script(vs, proc(path.join(root, "p7"), [], { mounts: [vs] }));
    assert.equal(r.code, 0, r.err);
    assert.ok(r.removed.includes(v.alt1) && !r.removed.includes(v.recent), r.out);
    assert.ok(content(bin).includes(v.recent));
  });
});

test("(S) script: `.vscode-server` or `bin` as a link, missing or empty — nothing, exit 0", () => {
  withTemp((root) => {
    // A target with four old versions, reached through a link: neither as `.vscode-server` nor as `bin` is it touched.
    const real = path.join(root, "real");
    const old = [HEX("1"), HEX("2"), HEX("3"), HEX("4")];
    old.forEach((n, i) => version(path.join(real, "bin", n), (i + 2) * HOUR));
    const home1 = path.join(root, "h1");
    fs.mkdirSync(home1);
    fs.symlinkSync(real, path.join(home1, VSCODE_SERVER));
    const home2 = path.join(root, "h2", VSCODE_SERVER);
    fs.mkdirSync(home2, { recursive: true });
    fs.symlinkSync(path.join(real, "bin"), path.join(home2, "bin"));
    const home3 = path.join(root, "h3", VSCODE_SERVER);
    fs.mkdirSync(home3, { recursive: true });
    const home4 = path.join(root, "h4", VSCODE_SERVER, "bin");
    fs.mkdirSync(home4, { recursive: true });
    const cases = [["link .vscode-server", path.join(home1, VSCODE_SERVER)], ["link bin", home2], ["without bin", home3], ["empty bin", path.dirname(home4)], ["missing", path.join(root, "h5", VSCODE_SERVER)]];
    // Each of these places IS a mount point — it is the checks after that hold it.
    const p = proc(path.join(root, "proc"), [], { mounts: [...cases.map(([, vs]) => vs), real] });
    for (const [name, vs] of cases) {
      const r = script(vs, p);
      assert.deepEqual({ code: r.code, out: r.out, err: r.err }, { code: 0, out: "", err: "" }, name);
    }
    assert.deepEqual(content(path.join(real, "bin")), sorted(old), "something was deleted through a link");
    // Counter-test: the same folder directly — two go.
    const r = script(real, p);
    assert.deepEqual(sorted(r.removed), [HEX("3"), HEX("4")], r.out);
  });
});

test("(S) script: a failing `rm` — exit 1, a line on stderr, the rest go anyway", () => {
  withTemp((root) => {
    const vs = path.join(root, "home", VSCODE_SERVER);
    const bin = path.join(vs, "bin");
    const names = [HEX("1"), HEX("2"), HEX("3"), HEX("4"), HEX("5")];
    names.forEach((n, i) => version(path.join(bin, n), (i + 1) * HOUR)); // newest: 1, 2
    // A fake `rm` in front of the PATH (root-independent, unlike a folder without write permission): fails on HEX("4").
    const front = path.join(root, "front");
    fs.mkdirSync(front);
    fs.writeFileSync(path.join(front, "rm"), `#!/bin/sh\ncase "$*" in *${HEX("4")}*) echo "rm: Permission denied" >&2; exit 1;; esac\nexec /bin/rm "$@"\n`);
    fs.chmodSync(path.join(front, "rm"), 0o755);
    const r = script(vs, proc(path.join(root, "proc"), [], { mounts: [vs] }), { pathFront: front });
    assert.equal(r.code, 1, r.out);
    assert.match(r.err, new RegExp(`rm failed: ${HEX("4")}`));
    assert.deepEqual(sorted(r.removed), [HEX("3"), HEX("5")], r.out);
    assert.deepEqual(content(bin), [HEX("1"), HEX("2"), HEX("4")]);
  });
});

test("readOutput: only `removed <name>`, `running <name>` and `no-mount`/`other-folder`", () => {
  assert.deepEqual(readOutput(`removed ${HEX("1")}\nrunning ${HEX("2")}\nrm failed: x\n  removed ${HEX("3")}  \nremoved\nforeign y\n`), { removed: [HEX("1"), HEX("3")], running: [HEX("2")], nothingTouched: null });
  assert.deepEqual(readOutput("no-mount\n"), { removed: [], running: [], nothingTouched: "no-mount" });
  assert.deepEqual(readOutput("other-folder\n"), { removed: [], running: [], nothingTouched: "other-folder" });
  assert.deepEqual(readOutput(undefined), { removed: [], running: [], nothingTouched: null });
});

test("(B) causeInB: only real folders through the descriptor in the runtime folder; a link at .vscode-server/bin (inside too), missing, outside — no cause; at the cap a cause", () => {
  const prev = DIRS;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-vscode-b-")));
  const data = path.join(root, "data");
  fs.mkdirSync(data);
  setDirs({ data, scratch: path.join(data, "scratch"), attachments: path.join(data, "attachments"), outputs: path.join(data, "outputs") });
  try {
    const location = locationFor({ projectId: "p1", converted: true });
    fs.mkdirSync(location.home, { recursive: true });
    const { source, target } = vscodeServerLocations("p1", { home: "/home/agent" });
    assert.deepEqual({ source, target }, { source: path.join(location.home, VSCODE_SERVER), target: "/home/agent/.vscode-server" });
    const bin = path.join(source, "bin");
    const withoutTime = ({ cause, finished, halfDoneOld }) => ({ cause, finished, halfDoneOld });

    let b = causeInB(source);
    assert.equal(b.cause, false);
    assert.ok(b.reason, "missing without a reason");

    // Two finished, one fresh half-finished, plus links and a file with version names: no cause.
    const outside = path.join(root, "outside");
    for (const n of [HEX("1"), HEX("2"), HEX("3")]) version(path.join(outside, n), 5 * HOUR);
    version(path.join(bin, HEX("a")), HOUR);
    version(path.join(bin, HEX("b")), 2 * HOUR);
    version(path.join(bin, `${HEX("c")}_7`), 10 * 60);
    fs.symlinkSync(path.join(outside, HEX("1")), path.join(bin, HEX("d")));
    fs.symlinkSync(path.join(bin, HEX("a")), path.join(bin, HEX("e"))); // a link inside does not count either
    fs.symlinkSync(path.join(outside, HEX("2")), path.join(bin, `${HEX("f")}_1`));
    fs.writeFileSync(path.join(bin, HEX("0")), "file\n");
    version(path.join(bin, `${HEX("5")}\nfoo`), 5 * HOUR); // a name with a line break is not a version
    b = causeInB(source);
    assert.deepEqual(b, { cause: false, finished: 2, halfDoneOld: 0, ino: inoOf(source) });
    // The half-finished one, seen two hours later: a cause.
    assert.deepEqual(withoutTime(causeInB(source, { now: Date.now() + 2 * HOUR * 1000 })), { cause: true, finished: 2, halfDoneOld: 1 });
    // A third finished one: a cause.
    version(path.join(bin, "9".repeat(40)), 3 * HOUR);
    assert.deepEqual(withoutTime(causeInB(source)), { cause: true, finished: 3, halfDoneOld: 0 });

    // The cap: more entries than the cap => cause, `cap: true`, with a reason — B reads no further. Exactly at the cap not; the
    // default CAUSE_CAP with nothing but foreign names (without a cap: no cause) likewise.
    const count = fs.readdirSync(bin).length;
    const atCap = causeInB(source, { cap: count - 1 });
    assert.deepEqual({ cause: atCap.cause, cap: atCap.cap }, { cause: true, cap: true });
    assert.match(atCap.reason, new RegExp(`cap of ${count - 1} entries`));
    assert.equal(causeInB(source, { cap: count }).cap, undefined);
    const many = path.join(location.root, "many");
    const vbin = path.join(many, "bin");
    fs.mkdirSync(vbin, { recursive: true });
    for (let i = 0; i <= CAUSE_CAP; i += 1) fs.writeFileSync(path.join(vbin, `x${i}`), "");
    const v = causeInB(many);
    assert.deepEqual({ cause: v.cause, cap: v.cap, finished: v.finished }, { cause: true, cap: true, finished: 0 });
    fs.rmSync(path.join(vbin, "x0"));
    assert.deepEqual(withoutTime(causeInB(many)), { cause: false, finished: 0, halfDoneOld: 0 }, "exactly CAUSE_CAP entries are no cap");

    // Links INSIDE the runtime folder: `bin` / `.vscode-server` point to a folder with four versions.
    const elsewhere = path.join(location.root, "elsewhere");
    for (const n of [HEX("1"), HEX("2"), HEX("3"), HEX("4")]) version(path.join(elsewhere, "bin", n), HOUR);
    assert.equal(causeInB(elsewhere).cause, true, "counter-test: the folder itself has a cause");
    fs.rmSync(bin, { recursive: true });
    fs.symlinkSync(path.join(elsewhere, "bin"), bin);
    b = causeInB(source);
    assert.deepEqual({ cause: b.cause, reason: b.reason }, { cause: false, reason: `symbolic link: ${bin}` });
    fs.rmSync(source, { recursive: true });
    fs.symlinkSync(elsewhere, source);
    b = causeInB(source);
    assert.deepEqual({ cause: b.cause, reason: b.reason }, { cause: false, reason: `symbolic link: ${source}` });
    // … and outward (five versions there): likewise.
    fs.rmSync(source);
    fs.mkdirSync(path.join(outside, "vs", "bin", HEX("1")), { recursive: true });
    for (const n of [HEX("2"), HEX("3"), HEX("4")]) version(path.join(outside, "vs", "bin", n), HOUR);
    fs.symlinkSync(path.join(outside, "vs"), source);
    b = causeInB(source);
    assert.equal(b.cause, false);
    assert.ok(b.reason, JSON.stringify(b));
    fs.rmSync(source);
    fs.mkdirSync(source);
    fs.symlinkSync(path.join(outside, "vs", "bin"), bin);
    b = causeInB(source);
    assert.equal(b.cause, false);
    assert.ok(b.reason, JSON.stringify(b));
    // Counter-test: the same content as a real folder — a cause.
    fs.rmSync(source, { recursive: true });
    fs.cpSync(path.join(outside, "vs"), source, { recursive: true });
    assert.equal(causeInB(source).cause, true);

    // Outside a runtime folder.
    assert.deepEqual(causeInB(path.join(outside, "vs")), { cause: false, finished: 0, halfDoneOld: 0, reason: "no runtime folder" });
  } finally {
    setDirs(prev);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanUpVscodeServer: copy and no operation — nothing, no throw", async () => {
  assert.deepEqual(await cleanUpVscodeServer("p1", { instance: "copy-k1" }), { status: "copy" });
  const saved = { c: process.env.CBASE_CONTAINER, d: process.env.CBASE_DIND };
  delete process.env.CBASE_CONTAINER;
  delete process.env.CBASE_DIND;
  try { assert.deepEqual(await cleanUpVscodeServer("p1"), { status: "no-ops" }); } finally {
    if (saved.c !== undefined) process.env.CBASE_CONTAINER = saved.c;
    if (saved.d !== undefined) process.env.CBASE_DIND = saved.d;
  }
});

const execCalls = (fd) => fd.calls({ daemon: "host" }).map((a) => a.args).filter((a) => a[0] === "exec" && a.includes(CLEAN_UP_SCRIPT));
const workEnd = () => { for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) setInstanceState(z.projectId, z.instance, "error", { error: "test end" }); };

// Captures console.warn and console.log for the duration of `fn`.
async function withLog(fn) {
  const prev = { warn: console.warn, log: console.log };
  const warnings = [];
  const rows = [];
  console.warn = (...a) => { warnings.push(a.map(String).join(" ")); };
  console.log = (...a) => { rows.push(a.map(String).join(" ")); };
  try { return await fn(warnings, rows); } finally { console.warn = prev.warn; console.log = prev.log; }
}

test("(A) through the fake docker: without a cause no docker; with a cause `exec -u agent` in the project container — old gone, running stays; no-mount and cap in the log; running-already; cap of the exec and a missing container are warnings", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs, execGate: "vs" });
    try {
      fd.openGate("vs");
      const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
      assert.equal(row.state, "ready", row.error);
      const source = path.join(s.location.home, VSCODE_SERVER);
      const bin = path.join(source, "bin");
      assert.ok(fs.lstatSync(source).isDirectory(), "the creation did not create the source");
      // The test seam `home`: the target is then the source itself (the fake docker runs locally, without the mounts); the seam's
      // /proc names it as a mount point — as in the container.
      const opts = { home: s.location.home, proc: proc(path.join(s.root, "vs-proc"), [], { mounts: [source] }) };

      // Two versions: nothing to do — no docker.
      version(path.join(bin, HEX("1")), 10);
      version(path.join(bin, HEX("2")), HOUR);
      const prior = fd.calls().length;
      const nothing = await withOps(fd, () => cleanUpVscodeServer(s.projectId, opts));
      assert.deepEqual(nothing, { status: "nothing", cause: false, finished: 2, halfDoneOld: 0, ino: inoOf(source) });
      assert.equal(fd.calls().length, prior, "a docker call without a cause");

      // Two old ones more, a process runs from the older one: it stays, the other goes.
      version(path.join(bin, HEX("3")), 3 * HOUR);
      version(path.join(bin, HEX("4")), 4 * HOUR);
      const withProcess = { ...opts, proc: proc(path.join(s.root, "vs-proc-2"), [{ pid: 7, cmdline: [`/home/agent/.vscode-server/bin/${HEX("4")}/node`] }], { mounts: [source] }) };
      const ok = await withOps(fd, () => cleanUpVscodeServer(s.projectId, withProcess));
      assert.deepEqual(ok, { status: "ok", removed: [HEX("3")], running: [HEX("4")] });
      assert.deepEqual(content(bin), [HEX("1"), HEX("2"), HEX("4")]);
      assert.deepEqual(execCalls(fd), [["exec", "-u", "agent", containerName(s.projectId), "sh", "-c", CLEAN_UP_SCRIPT, "cbase-vscode-clean-up", source, "2", "60", withProcess.proc, inoOf(source), ""]]);

      // Without a mount point in the container: nothing, a note in the log.
      await withLog(async (warnings) => {
        const r = await withOps(fd, () => cleanUpVscodeServer(s.projectId, { ...opts, proc: proc(path.join(s.root, "vs-proc-3"), []) }));
        assert.deepEqual(r, { status: "no-mount" });
        assert.ok(warnings.some((w) => w.includes(`VS Code server ${s.projectId}: note — ${source} is not a mount point in the project container`)), JSON.stringify(warnings));
      });
      assert.deepEqual(content(bin), [HEX("1"), HEX("2"), HEX("4")]);

      // The cap in B: more entries than CAUSE_CAP => cause, named as a cap in the log; the script decides.
      for (let i = 0; i <= CAUSE_CAP; i += 1) fs.writeFileSync(path.join(bin, `x${i}`), "");
      await withLog(async (_w, rows) => {
        const r = await withOps(fd, () => cleanUpVscodeServer(s.projectId, withProcess)); // three versions, the oldest runs
        assert.deepEqual(r, { status: "ok", removed: [], running: [HEX("4")] });
        assert.ok(rows.some((z) => z.includes(`VS Code server ${s.projectId}: cap of ${CAUSE_CAP} entries`)), JSON.stringify(rows.slice(-3)));
      });
      for (let i = 0; i <= CAUSE_CAP; i += 1) fs.rmSync(path.join(bin, `x${i}`));

      // A hanging `docker exec` (the gate): a second call gets `running-already`; the cap turns it into a warning.
      version(path.join(bin, HEX("5")), 5 * HOUR);
      fs.rmSync(path.join(fd.dir, "gates", "vs.waiting"), { force: true });
      fd.closeGate("vs");
      await withLog(async (warnings) => {
        const hangs = withOps(fd, () => cleanUpVscodeServer(s.projectId, { ...opts, capMs: 3_600_000 }));
        await fd.gateReached("vs");
        assert.ok(runningCleanUp(s.projectId), "no running cleanup visible");
        assert.deepEqual(await withOps(fd, () => cleanUpVscodeServer(s.projectId, opts)), { status: "running-already" });
        assert.ok(advanceCap() >= 1, "no cap ran");
        const r = await hangs;
        assert.equal(r.status, "error");
        assert.match(r.reason, /cap of 3600000 ms/);
        assert.ok(warnings.some((w) => w.includes(`VS Code server ${s.projectId}: cleaning up old versions failed`) && w.includes("(cap 3600000 ms, estimated)")), JSON.stringify(warnings));
      });
      assert.equal(runningCleanUp(s.projectId), null, "the cleanup stayed marked as running");
      assert.deepEqual(content(bin), [HEX("1"), HEX("2"), HEX("4"), HEX("5")]);
      fd.openGate("vs");
      assert.deepEqual(await withOps(fd, () => cleanUpVscodeServer(s.projectId, opts)), { status: "ok", removed: [HEX("4"), HEX("5")], running: [] }, "not runnable again after the cap");

      // A project without a container (never created), three old versions: warning, no throw, everything stays.
      const s2 = scenario(ctx);
      const bin2 = path.join(s2.location.home, VSCODE_SERVER, "bin");
      for (const [n, a] of [[HEX("5"), HOUR], [HEX("6"), 2 * HOUR], [HEX("7"), 3 * HOUR]]) version(path.join(bin2, n), a);
      await withLog(async (warnings) => {
        const r = await withOps(fd, () => cleanUpVscodeServer(s2.projectId, { ...opts, home: s2.location.home }));
        assert.equal(r.status, "error");
        assert.match(r.reason, /No such container/);
        assert.ok(warnings.some((w) => w.includes(`VS Code server ${s2.projectId}: cleaning up old versions failed`)), JSON.stringify(warnings));
      });
      assert.deepEqual(content(bin2), [HEX("5"), HEX("6"), HEX("7")]);
    } finally {
      fd.openGate("vs");
      workEnd();
      fd.cleanUp();
    }
  });
});

test("(R) the consumer in server.js: after the main is restored the cleanup starts, with the creation's home — and without test seams it cleans nothing (no mount point)", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs });
    // The home of this project's creation: the same source as recreate/setup — here the scenario's.
    setCreationOptions((pid) => (pid === s.projectId ? s.opts : {}));
    try {
      const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
      assert.equal(row.state, "ready", row.error);
      setInstanceState(s.projectId, "main", "ready", { convertedAt: Date.now() }); // only the relocation converts it
      const bin = path.join(s.location.home, VSCODE_SERVER, "bin");
      for (const [n, a] of [[HEX("1"), 10], [HEX("2"), HOUR], [HEX("3"), 2 * HOUR]]) version(path.join(bin, n), a);
      await withOps(fd, async () => {
        await withLog(async (warnings) => {
          const w = await restoreInstance(s.projectId, "main", { root: s.root });
          assert.equal(w.state, "ready", w.error);
          await new Promise((r) => setImmediate(r)); // the tick in which atReady calls its consumers
          const run = runningCleanUp(s.projectId);
          assert.ok(run, "the consumer at atReady did not start");
          // Without the seam the script reads the real /proc: there is none on the Mac, under Linux the scenario's
          // `<home>/.vscode-server` is no mount point — so no test ever cleans a real `~/.vscode-server`.
          assert.deepEqual(await run, { status: "no-mount" });
          assert.ok(warnings.some((x) => x.includes("not a mount point")), JSON.stringify(warnings));
        });
      });
      assert.deepEqual(content(bin), [HEX("1"), HEX("2"), HEX("3")], "cleaned up without a mount point");
      const [call, ...more] = execCalls(fd);
      assert.equal(more.length, 0);
      assert.equal(call[3], containerName(s.projectId));
      assert.equal(call[8], path.join(s.home, VSCODE_SERVER), "the target does not come from the creation's home (creationOptionsFor)");
      assert.deepEqual(call.slice(9), ["2", "60", "/proc", inoOf(path.join(s.location.home, VSCODE_SERVER)), ""]);
    } finally {
      setCreationOptions(null);
      workEnd();
      fd.cleanUp();
    }
  });
});

// ── The protected version ─────────────────────────────────────────────────────────────────────────────────────────────────
// The upfront fetch (projectbox/vscode-upfront.js) places the NEWEST version from Microsoft before the Mac has it — by build time
// it is then also the newest and, without protection, would push the version the Mac works with out of the two newest.
// Protected: never deleted, does not count toward KEEP; in the look in B (causeInB) it does not count as a cause;
// cleanUpVscodeServer passes the value from app_settings as the sixth argument.
test("protected version, script, real situation: the protected one is the NEWEST — with protection only the fourth falls, without protection the third falls too", () => {
  const situation = (root) => {
    const vs = path.join(root, "home", VSCODE_SERVER);
    const bin = path.join(vs, "bin");
    // Z placed upfront (build time newer than everything), Y the Mac's version, X and W older.
    const v = { z: HEX("7"), y: HEX("6"), x: HEX("5"), w: HEX("4") };
    const ages = { z: 10, y: HOUR, x: 2 * HOUR, w: 3 * HOUR };
    for (const [k, n] of Object.entries(v)) version(path.join(bin, n), ages[k]);
    return { vs, bin, v, p: proc(path.join(root, "proc"), [], { mounts: [vs] }) };
  };
  withTemp((root) => {
    const { vs, bin, v, p } = situation(root);
    const r = script(vs, p, { protection: v.z });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.removed, [v.w], r.out);
    assert.deepEqual(content(bin), sorted([v.z, v.y, v.x]));
  });
  for (const protection of [undefined, ""]) {
    withTemp((root) => {
      const { vs, bin, v, p } = situation(root);
      const r = script(vs, p, { protection });
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(sorted(r.removed), sorted([v.x, v.w]), `protection=${protection}: ${r.out}`);
      assert.deepEqual(content(bin), sorted([v.z, v.y]));
    });
  }
});

test("protected version, script, artificial situation: the protected one stays as the OLDEST too and does not count among the two newest — counter-test without protection deletes it; an invalid protection touches nothing", () => {
  const situationN57 = (root) => {
    const vs = path.join(root, "home", VSCODE_SERVER);
    const bin = path.join(vs, "bin");
    // Artificial: the protected one is the OLDEST (a withdrawn version that Microsoft still names), plus three of the Mac's.
    const v = { protection: HEX("9"), recent: HEX("1"), second: HEX("2"), old: HEX("3") };
    const ages = { protection: 9 * HOUR, recent: 10, second: HOUR, old: 2 * HOUR };
    for (const [k, n] of Object.entries(v)) version(path.join(bin, n), ages[k]);
    return { vs, bin, v, p: proc(path.join(root, "proc"), [], { mounts: [vs] }) };
  };
  withTemp((root) => {
    const { vs, bin, v, p } = situationN57(root);
    const r = script(vs, p, { protection: v.protection });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.removed, [v.old], r.out);
    assert.deepEqual(content(bin), sorted([v.protection, v.recent, v.second]));
    // A second run: nothing (the protected one and two).
    assert.deepEqual(script(vs, p, { protection: v.protection }).removed, []);
  });
  // Counter-test (five arguments) and empty protection: the protected one falls as the oldest.
  for (const protection of [undefined, ""]) {
    withTemp((root) => {
      const { vs, bin, v, p } = situationN57(root);
      const r = script(vs, p, { protection });
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(sorted(r.removed), sorted([v.old, v.protection]), `protection=${protection}: ${r.out}`);
      assert.deepEqual(content(bin), sorted([v.recent, v.second]));
    });
  }
  // An invalid protection (not 40 base-16 characters): exit 2, nothing touched.
  for (const protection of [HEX("9", 39), HEX("A"), "../x"]) {
    withTemp((root) => {
      const { vs, bin, p } = situationN57(root);
      const prior = content(bin);
      const r = script(vs, p, { protection });
      assert.equal(r.code, 2, `${protection}: ${r.out}`);
      assert.match(r.err, /protected version invalid/);
      assert.deepEqual(content(bin), prior);
    });
  }
});

test("protected version, causeInB and cleanUpVscodeServer: the protected one does not count as a cause; the value from app_settings goes out as the sixth argument (invalid = empty)", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs });
    try {
      const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
      assert.equal(row.state, "ready", row.error);
      const source = path.join(s.location.home, VSCODE_SERVER);
      const bin = path.join(source, "bin");
      for (const [n, a] of [[HEX("9"), 9 * HOUR], [HEX("1"), 10], [HEX("2"), HOUR]]) version(path.join(bin, n), a);
      // Three finished, one of them protected: no cause — without protection (counter-test) it would be one.
      const look = causeInB(source, { shielded: [HEX("9")] });
      assert.deepEqual([look.cause, look.finished], [false, 3]);
      assert.equal(causeInB(source).cause, true);
      const opts = { home: s.location.home, proc: proc(path.join(s.root, "n57-proc"), [], { mounts: [source] }) };
      assert.deepEqual(protectedVersions(), []);
      store.setSetting(NEWEST_KEY, HEX("9"));
      assert.deepEqual(protectedVersions(), [HEX("9")]);
      // withOps switches the upfront fetch off (the scenarios' default) — here it is ON, otherwise the value protects nothing.
      const ON = { CBASE_VSCODE_UPFRONT_MS: "21600000" };
      const prior = fd.calls().length;
      assert.equal((await withOps(fd, () => cleanUpVscodeServer(s.projectId, opts), ON)).status, "nothing");
      assert.equal(fd.calls().length, prior, "a docker call without a cause with a protected version");
      version(path.join(bin, HEX("3")), 2 * HOUR);
      assert.deepEqual(await withOps(fd, () => cleanUpVscodeServer(s.projectId, opts), ON), { status: "ok", removed: [HEX("3")], running: [] });
      assert.deepEqual(content(bin), [HEX("1"), HEX("2"), HEX("9")]);
      assert.equal(execCalls(fd).at(-1).at(-1), HEX("9"), "the protected version did not go out as the sixth argument");
      // Switched off (CBASE_VSCODE_UPFRONT_MS=0): the saved value protects nothing any more — otherwise a version nobody refreshes
      // any more would stay forever. withOps' default is exactly this case.
      assert.deepEqual(await withOps(fd, () => protectedVersions()), []);
      assert.deepEqual(await withOps(fd, () => protectedVersions(), { CBASE_VSCODE_UPFRONT_MS: "" }), [HEX("9")], "empty means default (on), not off");
      for (const n of [HEX("5"), HEX("6")]) version(path.join(bin, n), 4 * HOUR);
      const output = await withOps(fd, () => cleanUpVscodeServer(s.projectId, opts));
      assert.deepEqual([output.status, sorted(output.removed)], ["ok", sorted([HEX("5"), HEX("6"), HEX("9")])], JSON.stringify(output));
      assert.equal(execCalls(fd).at(-1).at(-1), "", "switched off, the protection went out anyway");
      assert.deepEqual(content(bin), [HEX("1"), HEX("2")]);
      version(path.join(bin, HEX("9")), 9 * HOUR); // back for the rest of the test
      // An invalid value in app_settings protects nothing — and goes out empty (the script would otherwise abort with exit 2).
      store.setSetting(NEWEST_KEY, "no-commit");
      assert.deepEqual(protectedVersions(), []);
      version(path.join(bin, HEX("4")), 3 * HOUR);
      const r = await withOps(fd, () => cleanUpVscodeServer(s.projectId, opts), ON);
      assert.deepEqual([r.status, sorted(r.removed), r.running], ["ok", [HEX("4"), HEX("9")], []]);
      assert.equal(execCalls(fd).at(-1).at(-1), "");
    } finally {
      workEnd();
      fd.cleanUp();
    }
  });
});

// ── TWO protected versions ────────────────────────────────────────────────────────────────────────────────────────────────
// The upfront fetch also places the USED version (the Mac's) into every project; it is protected next to the newest. The script
// takes the list as ONE argument with a comma; no protected one falls, none counts among the two newest.
test("two protected, script: two protected (newest and used) — both stay, neither counts among the two newest; counter-test with only the newest and without protection", () => {
  // The real situation: Z (newest, placed upfront, newest by build time), Y and W two more, X the Mac's (the OLDEST).
  const situation = (root) => {
    const vs = path.join(root, "home", VSCODE_SERVER);
    const bin = path.join(vs, "bin");
    const v = { z: HEX("7"), y: HEX("6"), w: HEX("5"), v: HEX("4"), x: HEX("3") };
    const ages = { z: 10, y: HOUR, w: 2 * HOUR, v: 3 * HOUR, x: 4 * HOUR };
    for (const [k, n] of Object.entries(v)) version(path.join(bin, n), ages[k]);
    return { vs, bin, v, p: proc(path.join(root, "proc"), [], { mounts: [vs] }) };
  };
  const cases = [
    // [protection, what falls] — with the list Z and X (protected) and Y, W (the two newest remaining) stay.
    [(v) => `${v.z},${v.x}`, (v) => [v.v]],
    [(v) => `${v.x},${v.z}`, (v) => [v.v]], // the order of the list does not matter
    [(v) => `${v.z},${v.z}`, (v) => [v.v, v.x]], // a duplicate is allowed (B sends none) and protects one
    [(v) => v.z, (v) => [v.v, v.x]], // counter-test: only the newest — the Mac's falls
    [() => "", (v) => [v.w, v.v, v.x]], // counter-test without protection: the two newest
  ];
  for (const [protectionOf, removedOf] of cases) {
    withTemp((root) => {
      const { vs, bin, v, p } = situation(root);
      const protection = protectionOf(v);
      const r = script(vs, p, { protection });
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(sorted(r.removed), sorted(removedOf(v)), `protection=${protection}: ${r.out}`);
      assert.deepEqual(content(bin), sorted(Object.values(v).filter((n) => !removedOf(v).includes(n))));
    });
  }
});

test("two protected, script: an invalid list (empty member, capitals, space, 39 characters) — exit 2, nothing touched", () => {
  for (const protection of [`${HEX("9")},`, `,${HEX("9")}`, `${HEX("9")},,${HEX("8")}`, ",", `${HEX("9")},${HEX("A")}`, `${HEX("9")}, ${HEX("8")}`, `${HEX("9")},${HEX("8", 39)}`, `${HEX("9")};${HEX("8")}`]) {
    withTemp((root) => {
      const vs = path.join(root, "home", VSCODE_SERVER);
      const bin = path.join(vs, "bin");
      for (const [n, a] of [[HEX("1"), 10], [HEX("2"), HOUR], [HEX("3"), 2 * HOUR], [HEX("4"), 3 * HOUR]]) version(path.join(bin, n), a);
      const prior = content(bin);
      const r = script(vs, proc(path.join(root, "proc"), [], { mounts: [vs] }), { protection });
      assert.equal(r.code, 2, `${JSON.stringify(protection)}: ${r.out}`);
      assert.match(r.err, /protected version invalid/);
      assert.deepEqual(content(bin), prior, `${JSON.stringify(protection)}: touched`);
    });
  }
});

test("two protected, protectedVersions, causeInB and cleanUpVscodeServer: newest and used as a list (no duplicates, invalid ones drop out); a single value throws; the script gets \"newest,used\"", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs });
    const ON = { CBASE_VSCODE_UPFRONT_MS: "21600000" };
    try {
      const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
      assert.equal(row.state, "ready", row.error);
      const source = path.join(s.location.home, VSCODE_SERVER);
      const bin = path.join(source, "bin");
      // protectedVersions: the newest before the used one, no duplicates, only 40 base-16 characters, switched off empty.
      assert.deepEqual(protectedVersions(), []);
      store.setSetting(USED_KEY, HEX("3"));
      assert.deepEqual(protectedVersions(), [HEX("3")], "the used one alone protects");
      store.setSetting(NEWEST_KEY, HEX("9"));
      assert.deepEqual(protectedVersions(), [HEX("9"), HEX("3")]);
      store.setSetting(USED_KEY, HEX("9"));
      assert.deepEqual(protectedVersions(), [HEX("9")], "a duplicate");
      store.setSetting(USED_KEY, "no-commit");
      assert.deepEqual([protectedVersions(), savedVersion(USED_KEY)], [[HEX("9")], null]);
      store.setSetting(USED_KEY, HEX("3"));
      assert.deepEqual(await withOps(fd, () => protectedVersions()), [], "switched off, the used one still protects");
      assert.deepEqual(savedVersion(USED_KEY), HEX("3"), "savedVersion reads without the switch");

      // causeInB: four finished, two protected — no cause; with only one — a cause. A single value (the older form) throws.
      for (const [n, a] of [[HEX("9"), 10], [HEX("1"), HOUR], [HEX("2"), 2 * HOUR], [HEX("3"), 9 * HOUR]]) version(path.join(bin, n), a);
      assert.deepEqual([causeInB(source, { shielded: [HEX("9"), HEX("3")] }).cause, causeInB(source, { shielded: [HEX("9")] }).cause], [false, true]);
      assert.throws(() => causeInB(source, { shielded: HEX("9") }), /not a list/);

      // cleanUpVscodeServer: the sixth argument is "newest,used"; the used one (the oldest) stays, the fifth falls.
      const opts = { home: s.location.home, proc: proc(path.join(s.root, "n58-proc"), [], { mounts: [source] }) };
      const prior = fd.calls().length;
      assert.equal((await withOps(fd, () => cleanUpVscodeServer(s.projectId, opts), ON)).status, "nothing");
      assert.equal(fd.calls().length, prior, "a docker call without a cause with two protected");
      version(path.join(bin, HEX("4")), 3 * HOUR);
      assert.deepEqual(await withOps(fd, () => cleanUpVscodeServer(s.projectId, opts), ON), { status: "ok", removed: [HEX("4")], running: [] });
      assert.deepEqual(content(bin), [HEX("1"), HEX("2"), HEX("3"), HEX("9")]);
      assert.equal(execCalls(fd).at(-1).at(-1), `${HEX("9")},${HEX("3")}`, "the list did not go out as the sixth argument");
    } finally {
      workEnd();
      fd.cleanUp();
    }
  });
});

// ── protectedAlongside ────────────────────────────────────────────────────────────────────────────────────────────────────
// The upfront fetch cleans up after placing (vscode-upfront.js upfrontProject) and protects the just-placed versions ON TOP —
// also one that is not (yet) in app_settings. An invalid member or a single value leaves everything standing.
test("cleanUpVscodeServer with protectedAlongside — the one protected on top stays (as the oldest too, unsaved too), the saved ones first, no duplicates; invalid or single value => error, nothing falls; counter-test without", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs });
    const ON = { CBASE_VSCODE_UPFRONT_MS: "21600000" };
    try {
      const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
      assert.equal(row.state, "ready", row.error);
      const source = path.join(s.location.home, VSCODE_SERVER);
      const bin = path.join(source, "bin");
      const opts = { home: s.location.home, proc: proc(path.join(s.root, "alongside-proc"), [], { mounts: [source] }) };
      const run = (o = {}) => withOps(fd, () => cleanUpVscodeServer(s.projectId, { ...opts, ...o }), ON);
      // X: just placed, the OLDEST by build time, NOT saved; plus two newer ones.
      const X = HEX("9");
      for (const [n, a] of [[X, 9 * HOUR], [HEX("1"), 10], [HEX("2"), HOUR]]) version(path.join(bin, n), a);
      assert.deepEqual(protectedVersions(), []);
      // With X on top: no cause (two remaining) — no docker.
      const prior = fd.calls().length;
      assert.equal((await run({ protectedAlongside: [X] })).status, "nothing");
      assert.equal(fd.calls().length, prior, "a docker call without a cause with protectedAlongside");
      // A third remaining one: X stays, the oldest remaining falls; the sixth argument carries X.
      version(path.join(bin, HEX("3")), 2 * HOUR);
      assert.deepEqual(await run({ protectedAlongside: [X] }), { status: "ok", removed: [HEX("3")], running: [] });
      assert.deepEqual(content(bin), sorted([X, HEX("1"), HEX("2")]));
      assert.equal(execCalls(fd).at(-1).at(-1), X);
      // The saved ones first, no duplicates: newest N saved, on top [X, N] => "N,X".
      const N = HEX("8");
      version(path.join(bin, N), 10);
      store.setSetting(NEWEST_KEY, N);
      version(path.join(bin, HEX("5")), 4 * HOUR);
      assert.deepEqual(await run({ protectedAlongside: [X, N] }), { status: "ok", removed: [HEX("5")], running: [] });
      assert.equal(execCalls(fd).at(-1).at(-1), `${N},${X}`);
      assert.deepEqual(content(bin), sorted([X, N, HEX("1"), HEX("2")]));
      // Invalid (no commit, capitals, a comma in a member) or a single value instead of the list: `error` with a warning, NO
      // docker, nothing falls.
      version(path.join(bin, HEX("6")), 5 * HOUR);
      const n = fd.calls().length;
      for (const wrong of [["no-commit"], [HEX("A")], [X, `${X},${HEX("7")}`], X]) {
        await withLog(async (warnings) => {
          const r = await run({ protectedAlongside: wrong });
          assert.equal(r.status, "error", JSON.stringify(wrong));
          assert.ok(warnings.some((w) => w.includes(`VS Code server ${s.projectId}: cleaning up old versions failed`)), JSON.stringify(warnings));
        });
      }
      assert.equal(fd.calls().length, n, "an invalid protection called docker");
      assert.deepEqual(content(bin), sorted([X, N, HEX("1"), HEX("2"), HEX("6")]));
      // Counter-test: WITHOUT protectedAlongside X falls (the oldest remaining) — the saved N stays.
      assert.deepEqual(await run(), { status: "ok", removed: [HEX("6"), X], running: [] });
      assert.deepEqual(content(bin), sorted([N, HEX("1"), HEX("2")]));
    } finally {
      workEnd();
      fd.cleanUp();
    }
  });
});

// COUNTER-TESTS (each shown red, then reverted):
//   server.js: the consumer at atReady removed                                  => (R) red ("the consumer at atReady did not start")
//   script: `ls -dt` -> `ls -d` (name order instead of mtime order)             => (S) situation and (S) mount point red
//   script: `[ ! -L "$e" ]` on the entries removed                              => (S) situation red (the link with a version name counted)
//   script: `[ ! -L "$vs" ]` removed                                            => (S) links red (deleted through `.vscode-server` as a link)
//   script: `readlink "$d/exe"` removed from the process list                   => (S) situation red (the version running only via exe went)
//   script: `-mmin +"$minutes"` removed                                         => (S) situation red (the fresh half-finished one went)
//   causeInB: dirent type not checked and `stat` instead of `lstat`             => (B) red (links with version names counted)
//   cleanUpVscodeServer: without the look in B always `docker exec`             => (A) red ("a docker call without a cause")
//   script: names split per line again via `grep -Eqx`                          => (S) situation red: `removed foo` (foreign folder next to
//      `<40 base-16>⏎foo`) and the half-finished name with a line break went
//   script: the mount-point check removed                                       => (S) mount point, (A) ("no-mount") and (R) red — (R) would
//      have cleaned the main locally through the fake docker
//   script: the inode check removed                                             => (S) mount point red (`other-folder` missing)
//   script: space not encoded as `\040`                                         => (S) mount point red (path with space and backslash)
//   causeInB: the link stop at `.vscode-server`/`bin` removed                   => (B) red (the link inside counted as a cause)
//   causeInB: without a cap                                                     => (B) and (A) red (no `cap`, no log line)
//   cleanUpVscodeServer: home from os.homedir() instead of creationOptionsFor   => (R) red (target not the home of the creation)
//   script: the line `if shielded "$n"; then continue; fi` removed           => the protected-version tests red
//   causeInB: the protected one counts as a cause                               => "causeInB and cleanUpVscodeServer: the protected one …" red
//   cleanUpVscodeServer: the protection does not go out as the sixth argument   => the same test red
//   script: an invalid list member not rejected                                 => "an invalid list" and "artificial situation" red
//   script: only the first member protected                                     => "two protected" and "protectedVersions …" red
//   protectedVersions without the used one / with a duplicate / protection set taking a single value => "protectedVersions, causeInB …" red
//   protectedWith: `alongside` ignored / an invalid member not rejected         => "protectedAlongside" red
//   Built in: the process list ((S), empty /proc), the link as target ((S) links, directly), the raw spelling in mountinfo
//   ((S) mount point), "two protected" with only the newest and without protection.
//   NOT counter-tested (not measurable here): reading the process list ONCE — the trap (a `grep` per candidate would see its own
//   command line) exists only with a real /proc, which macOS lacks; and `LC_ALL=C` (the classes `[!0-9a-f]` in `case` depend on
//   the locale's collation).
