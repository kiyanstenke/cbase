// The FOREIGN marker "B ends" in runs/server-end.js serverEnds(). The gateway stops the project containers of an unhealthy B
// (ensureRunning) or in destroy() before the stop of B via `docker exec -u agent B sh -c "… docker stop -t 30 $ids"` — past the
// backend's docker(), without the marker "cbase stops itself". The observer (projectbox/resumption.js) would see a crash in it and
// restart them at once in the still living B. So the gateway first writes, via `exec -u root`, the file /run/cbase/b-ends
// (epoch ms), and serverEnds() counts it like its own marker — if it belongs to root (what that protects: see below).
//
// What is here (no timer, no time limit in the test: the file's age is set via utimes, "now" is the test's clock; nothing is ever
// waited for):
//   (1) a fresh, root-owned marker => serverEnds() true; without a marker false, with a marker just under / over the limit
//       (B_ENDS_AGE_MS) true / false;
//   (2) NOT trustworthy => false: not root-owned, writable for group/others, a link to a good file, a directory that does not
//       belong to root or is writable, a file where the directory should be — and no throw;
//   (3) the wire to the gateway: the script B_ENDS_SCRIPT (server/gateway/containers.js) writes, with the path moved into a root,
//       really a marker that serverEnds() accepts; and entry.sh names the same path. THAT entry.sh removes the marker at every start
//       (otherwise it would stand after `docker start` for up to ten minutes and keep serverEnds() wrongly true) is checked by
//       tools/check/entry-sh.test.mjs against the RUNNING script ("RP9-4 / beweise-3").
// The path is prefixed with the test seam CBASE_NETWORK_ROOT (as in projectbox/network-marker.js). If the test does not run as root
// (uid 0), it cannot create a root-owned file: it then sets the owner serverEnds() expects to its own uid with the seam
// bEndsOwnerForTest (withRoot, back to 0 in the finally) — so serverEnds() ITSELF is also run on the gate (macOS, uid 501). The
// case "not root-owned" sets the expected owner to 0 (the product's default): the own file is then not root-owned, and as root it is
// additionally handed to a foreign uid via `chown`.
// WHAT "root-owned" PROTECTS: only against a process WITHOUT docker access. In B every process the backend starts as agent carries
// the group docker (Dockerfile `usermod -aG docker agent`, entry.sh `setpriv --init-groups`) and can write a root-owned 0644 file
// b-ends via the inner dockerd — the marker then applies for up to ten minutes (renewable). That is no new power (with the docker
// group it stops the project containers anyway), but no boundary either; the head of runs/server-end.js says why it cannot be drawn
// here.
//
// COUNTER-TESTS (one sabotage each on the product code, red without a hang):
//   server-end.js S1  serverEnds() without the foreign marker (`return ends;`)  => (1) x2, (3) wire red — only as root; on the
//                     gate (uid 501) the seam bEndsOwnerForTest makes it red there too
//   server-end.js S2  owner check (uid) removed                                  => (2) x2 red
//   server-end.js S3  age limit removed (`return true`)                          => (1) age red
//   server-end.js S4  mode check (group/others writable) removed                 => (2) mode/link/directory red
//   server-end.js S5  directory check removed                                    => (2) red
//   server-end.js S6  lstat => stat (a link counts)                              => (2) red
//   server-end.js S7  catch rethrows (instead of false)                          => (1), (2) red (no throw)
//   server-end.js S8  path without CBASE_NETWORK_ROOT                            => (1) x2, (2), (3) red
//   entry.sh          S9  marker not removed at start                            => (3) entry.sh red; stop-place guard (5) red
//   containers.js     S10 B_ENDS_SCRIPT writes seconds instead of epoch ms       => (3) wire red
//   containers.js     S11 B_ENDS_SCRIPT `chmod 666` instead of 644               => (3) wire red
// The gateway sabotages (G1–G7) and the head one (K1) are in server/gateway/containers.test.js and projectbox-stop-places.test.js:
//   containers.js  G1  `docker stop -t 60` in destroy removed                    => gateway "RP9-4 (1)", "S1-5 … destroy" red
//   containers.js  G2  the stop in destroy AFTER the script (the product's order is the reverse) => same plus "rm -f right behind the stop" red
//   containers.js  G3  the marker (exec -u root) in stopProjectContainer removed => gateway "RP9-4 (2)", "RP9-4 (1)", S1-5 x2 red; guard (5) red
//   containers.js  G4  the marker as `-u agent` instead of `-u root`             => the same gateway tests red; guard (5) red
//   containers.js  G5  the stop in destroy without `.catch` (an error aborts)    => gateway "RP9-4 (1)" (failing stop), "S1-5 the exec fails", destroy red
//   containers.js  G6  a second string with "docker stop" in the gateway         => guard (5) red ("2 line(s) with docker stop instead of 1")
//   containers.js  G7  marker and script swapped (marker AFTER the script)       => gateway "RP9-4 (2)", "RP9-4 (1)", S1-5 x2 red; guard (5) red
//   projectbox/resumption.js K1 the gateway's head line removed                  => guard (3) red
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { B_ENDS_AGE_MS, B_ENDS_MARKER, bEndsOwnerForTest, bEndsMarkerApplies, serverEndMarkerForTest, serverEnds } from "../electron/server/runs/server-end.js";
import * as serverEnd from "../electron/server/runs/server-end.js";
import { B_ENDS_SCRIPT } from "../../../server/gateway/containers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..", "..");
const ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const MY_UID = typeof process.getuid === "function" ? process.getuid() : 0;
const FOREIGN_UID = 4711;
const MINUTE = 60_000;

console.log(`[server-end-marker] uid ${MY_UID}: ${ROOT ? "as root — serverEnds() runs with a root-owned marker" : "NOT as root — serverEnds() runs with the own uid as the expected owner (seam bEndsOwnerForTest)"}`);

/**
 * A root with /run/cbase (0755) and, if wanted, the marker (0644); `owner` is the owner serverEnds() takes for "root"
 * (default: the own uid — as root thus 0). Cleans up in the finally, the seam back to 0.
 */
async function withRoot(fn, { marker = true, ageMs = 0, owner = MY_UID } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "server-end-marker-"));
  const dir = path.join(root, "run", "cbase");
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o755);
  const file = path.join(dir, "b-ends");
  if (marker) {
    fs.writeFileSync(file, `${Date.now()}\n`);
    fs.chmodSync(file, 0o644);
    if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(file, t, t); }
  }
  const saved = process.env.CBASE_NETWORK_ROOT;
  process.env.CBASE_NETWORK_ROOT = root;
  serverEndMarkerForTest(false);
  bEndsOwnerForTest(owner);
  try {
    return await fn({ root, dir, file });
  } finally {
    if (saved === undefined) delete process.env.CBASE_NETWORK_ROOT; else process.env.CBASE_NETWORK_ROOT = saved;
    serverEndMarkerForTest(false);
    bEndsOwnerForTest(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Does the marker apply? Always via serverEnds() itself — the product's path.
const applies = () => serverEnds();

test("(1) a fresh, root-owned marker makes serverEnds() true; without a marker it is false", async () => {
  await withRoot(() => {
    assert.equal(serverEnds(), true, "fresh marker, but serverEnds() false");
    assert.equal(bEndsMarkerApplies({ owner: MY_UID }), true);
  });
  await withRoot(() => {
    assert.equal(serverEnds(), false, "without a marker serverEnds() must be false");
    assert.equal(bEndsMarkerApplies({ owner: MY_UID }), false);
  }, { marker: false });
  // The own marker stays true, with or without the foreign one.
  await withRoot(() => {
    serverEndMarkerForTest(true);
    assert.equal(serverEnds(), true, "the own marker still counts");
  }, { marker: false });
});

test("(1) the age: just under B_ENDS_AGE_MS applies, above it does not", async () => {
  assert.equal(B_ENDS_AGE_MS, 10 * MINUTE);
  await withRoot(() => assert.equal(applies(), true, "9 minutes old still applies"), { ageMs: 9 * MINUTE });
  await withRoot(() => assert.equal(applies(), false, "11 minutes old no longer applies"), { ageMs: 11 * MINUTE });
  await withRoot(() => assert.equal(applies(), false, "an hour old does not apply"), { ageMs: 60 * MINUTE });
  // The clock is a parameter (no waiting): the same fresh file, "now" eleven minutes later.
  await withRoot(({ file }) => {
    const m = fs.statSync(file).mtimeMs;
    assert.equal(bEndsMarkerApplies({ owner: MY_UID, now: m + B_ENDS_AGE_MS - 1 }), true);
    assert.equal(bEndsMarkerApplies({ owner: MY_UID, now: m + B_ENDS_AGE_MS }), false);
  });
});

test("(2) a marker that does not belong to root does not apply (this excludes only processes WITHOUT docker access, see header)", async () => {
  // Root (0, the product's default) is expected: without root the own file is per se not root-owned; with root it is handed to a
  // foreign uid.
  await withRoot(({ file, dir }) => {
    if (ROOT) fs.chownSync(file, FOREIGN_UID, FOREIGN_UID);
    assert.equal(serverEnds(), false, "the file does not belong to root, yet serverEnds() is true");
    assert.equal(bEndsMarkerApplies(), false);
    assert.ok(fs.statSync(dir).isDirectory());
  }, { owner: 0 });
});

test("(2) writable for group or others, a link, a foreign or writable directory, a file instead of the directory — each false, never a throw", async () => {
  const eig = { owner: MY_UID };
  await withRoot(({ file }) => {
    for (const mode of [0o664, 0o666, 0o646, 0o622]) {
      fs.chmodSync(file, mode);
      assert.equal(bEndsMarkerApplies(eig), false, `mode ${mode.toString(8)} (writable) wrongly applies`);
    }
    fs.chmodSync(file, 0o600);
    assert.equal(bEndsMarkerApplies(eig), true, "0600 is not writable for others and applies");
  });
  await withRoot(({ file, dir }) => {
    const good = path.join(dir, "good-file");
    fs.renameSync(file, good);
    fs.symlinkSync(good, file);
    assert.equal(bEndsMarkerApplies(eig), false, "a link to a good file wrongly applies (lstat, not stat)");
  });
  await withRoot(({ dir }) => {
    fs.chmodSync(dir, 0o777);
    assert.equal(bEndsMarkerApplies(eig), false, "a writable directory: a process without root could replace the file");
    fs.chmodSync(dir, 0o775);
    assert.equal(bEndsMarkerApplies(eig), false);
  });
  if (ROOT) {
    await withRoot(({ dir }) => {
      fs.chownSync(dir, FOREIGN_UID, FOREIGN_UID);
      assert.equal(serverEnds(), false, "a directory that does not belong to root wrongly applies");
    });
  }
  await withRoot(({ dir, root }) => {
    fs.rmSync(path.join(root, "run"), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, "run"));
    fs.writeFileSync(dir, "x"); // a file where /run/cbase should be
    assert.doesNotThrow(() => bEndsMarkerApplies(eig));
    assert.equal(serverEnds(), false);
  }, { marker: false });
  // A root that does not exist: false, no throw.
  const saved = process.env.CBASE_NETWORK_ROOT;
  process.env.CBASE_NETWORK_ROOT = path.join(os.tmpdir(), "exists-not-server-end-marker");
  try {
    assert.doesNotThrow(() => serverEnds());
    assert.equal(serverEnds(), false);
  } finally {
    if (saved === undefined) delete process.env.CBASE_NETWORK_ROOT; else process.env.CBASE_NETWORK_ROOT = saved;
  }
});

test("(3) the wire: the gateway's B_ENDS_SCRIPT writes a marker that serverEnds() accepts", async () => {
  assert.ok(B_ENDS_SCRIPT.includes(B_ENDS_MARKER), `the gateway's script does not name the path the backend reads (${B_ENDS_MARKER})`);
  await withRoot(({ root, dir, file }) => {
    fs.rmSync(dir, { recursive: true, force: true }); // the script creates the directory itself
    // The absolute path moves into the root; everything else in the script stays as the gateway sends it.
    const script = B_ENDS_SCRIPT.split("/run/cbase").join(path.join(root, "run", "cbase"));
    assert.notEqual(script, B_ENDS_SCRIPT);
    execFileSync("sh", ["-c", script], { stdio: "pipe" });
    assert.ok(fs.existsSync(file), "the script wrote no marker");
    assert.ok(!fs.existsSync(`${file}.neu`), "the temporary file was left behind (not renamed atomically)");
    assert.match(fs.readFileSync(file, "utf8"), /^\d{13}\n$/, "the content is not epoch ms");
    assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    assert.equal(applies(), true, "the marker written by the script does not apply");
  }, { marker: false });
});

test("(3) entry.sh names the same path as the backend (the removal at start is run by tools/check/entry-sh.test.mjs)", () => {
  const sh = fs.readFileSync(path.join(REPO, "server", "backend", "entry.sh"), "utf8");
  const rows = sh.split("\n").filter((z) => !/^\s*#/.test(z));
  assert.ok(rows.includes(`B_ENDS_MARKER="$W${B_ENDS_MARKER}"`), `B_ENDS_MARKER in entry.sh does not name ${B_ENDS_MARKER}`);
  // The removal guard runs against the real script — here only that it exists.
  const latch = fs.readFileSync(path.join(REPO, "tools", "check", "entry-sh.test.mjs"), "utf8");
  assert.match(latch, /a "B ends" marker from the previous start/, "the guard that runs entry.sh with a marker from before the start is missing");
});

// The verdict on the marker without a file system. As uid 501 the test cannot create a file that belongs to SOMEONE ELSE — the case
// "file belongs to E, directory belongs to E+1" could only be run as root. `bEndsVerdict(stFile, stDir, { owner, now })` is the pure
// verdict, bEndsMarkerApplies calls it after the two lstat. Counter-test: the uid comparison on the directory removed (only the mode
// left) => (4) red — also as uid 501.
test("(4) bEndsVerdict pure: file uid E/0600 with directory uid E+1/0755 does not apply, matching uid applies; mode, kind and age as on the file", () => {
  assert.equal(typeof serverEnd.bEndsVerdict, "function", "bEndsVerdict is not exported");
  const { bEndsVerdict } = serverEnd;
  const E = 4711;
  const now = 10_000_000;
  const st = ({ uid = E, mode = 0o100600, file = true, mtimeMs = now - 1000 } = {}) => ({ uid, mode, mtimeMs, isFile: () => file, isDirectory: () => !file });
  const dir = (o = {}) => st({ mode: 0o40755, file: false, ...o });
  assert.equal(bEndsVerdict(st(), dir({ uid: E + 1 }), { owner: E, now }), false, "a directory of another owner wrongly applies");
  assert.equal(bEndsVerdict(st(), dir(), { owner: E, now }), true);
  assert.equal(bEndsVerdict(st({ uid: E + 1 }), dir(), { owner: E, now }), false, "a file of another owner");
  assert.equal(bEndsVerdict(st({ mode: 0o100620 }), dir(), { owner: E, now }), false, "writable for the group");
  assert.equal(bEndsVerdict(st(), dir({ mode: 0o40757 }), { owner: E, now }), false, "a directory writable for all");
  assert.equal(bEndsVerdict(st({ file: false }), dir(), { owner: E, now }), false, "not a regular file");
  assert.equal(bEndsVerdict(st(), st(), { owner: E, now }), false, "the directory is not one");
  assert.equal(bEndsVerdict(st({ mtimeMs: now - B_ENDS_AGE_MS }), dir(), { owner: E, now }), false, "too old");
  assert.equal(bEndsVerdict(null, dir(), { owner: E, now }), false, "without a file no throw");
});
