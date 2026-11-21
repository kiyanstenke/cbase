// The container entry of the user container, server/backend/entry.sh. server/backend/ lies in no glob of the gate, so the
// guard lives here.
//
// The real script runs under /bin/bash (gate: 3.2 on macOS) AND /bin/dash, with a PATH of fake `id`, `iptables` (stateful: chains
// and rules in a file), `dockerd`, `docker`, `chgrp`, `chown`, `chmod` (logged, then real), `rm` (logged, then real), `setpriv`,
// `node`. The root seam CBASE_ENTRY_ROOT prefixes /etc/hosts, /run, /var/run, /var/log and /proc/1/stat; HOME is a temp home, the
// credentials file a fake one. Waiting is on the `close` of the child — the background stop inherits stderr, so `close` comes only
// when it is done too. No deadline.
//
// Network separation: order leftovers incl. marker → iptables → dockerd → chgrp/chmod → setpriv; chain, jump exactly once, rule
// order, `-i cbp-+` (the ONE prefix of projectbox/creation.js BRIDGE_PREFIX), no `br-`; the marker carries the start time from the fake of /proc/1/stat. Counter-proofs: the state before
// the separation (BEFORE_S1_3) sets neither chain nor permission — red; `iptables` with exit 1 => setpriv reached, no marker,
// and after "info answers" `docker stop -t 30` with the label filter `cbase.project`; a marker from the previous start plus
// `iptables` with exit 1 => gone (counter-proof: the same version without the `rm` of the marker leaves it standing); `chgrp`
// with exit 1 => setpriv reached; without CBASE_DIND=1 neither iptables nor dockerd nor chgrp.
// If the separation stands but the marker cannot be written (/proc/1/stat missing), the same holds as without separation —
// message, no marker, and after "info answers" `docker stop -t 30` with the label filter. Counter-proof against the state before
// that fix (BEFORE_PB_6): message yes, stop no — red.
// Login relocation of `.credentials.json` for every initial state — only old, only new, both (each direction and a tie), none,
// symlink (as old file, as login directory, as ~/.claude), foreign owner (chown in the log), hard link —, a second start without
// effect, without DIND likewise, without the variable not at all.
// If the login stays at the old place (early abort, ~/.claude as a symlink), setpriv reaches the variable EMPTY — the CLI then
// reads ~/.claude; the fake setpriv writes the value it sees to <base>/setpriv-var. Counter-proof against the state before
// that fix (BEFORE_PB_1): there setpriv reaches the variable set — red.
// Before the stop without separation the PAUSED project containers are thawed via the label (`status=paused`) — `docker unpause
// <paused>` stands before `docker stop -t 30 <all>`; without paused ones no unpause. The fake docker reports paused ones only
// with FAKE_PAUSED. Counter-proof against the state before that (BEFORE_ST2_3): no unpause — red.
// The "B ends" marker (/run/cbase/b-ends, incl. .fresh) that the gateway sets before its exec stop is gone after EVERY start — with
// and without network separation; otherwise it would keep serverEnds() wrong-true for up to ten minutes. The text guards
// (server-end-marker.test.js, projectbox-stop-places.test.js) only checked the TEXT (an `rm -f … "$B_ENDS_MARKER"` line) — a dead
// line (`if false; then rm -f …; fi`) stayed green. Here the real script runs. Built-in counter-proof: the same version
// without the two paths in the rm leaves the marker standing — the check is red.
// COUNTER-PROOFS by sabotage of entry.sh via a script:
//   both B_ENDS paths taken out of the rm, then `if false; then rm -f "$B_ENDS_MARKER" "$B_ENDS_MARKER.fresh"; fi` => the "B ends"
//   test of both shells red (2 of 42); the old text guards (server-end-marker, projectbox-stop-places) stay GREEN meanwhile
//   only "$B_ENDS_MARKER.fresh" out of the rm => the "B ends" test of both shells red (and the built-in counter-proof, its spot is gone)
//
//
// SPLIT. This is the PUBLIC half; the one case that runs the retreat of lib/login-retreat.mjs through the same harness stands in
// entry-sh.ops.test.mjs. The harness is lib/entry-sh-fixture.mjs.
//
// Run:  node --test --test-reporter=tap tools/check/entry-sh.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ENTRY, entryBeforePb1, entryBeforePb6, entryBeforeSt23, SHELLS, START, build, run, exists, way, index, snapshot, WRONG, file, varAtSetpriv, aside, oldRevision, checkSeparation, checkMarkerMissing, checkThaw, JUMP,
} from "./lib/entry-sh-fixture.mjs";

test("both shells are there (the image runs bash 5.2, the gate bash 3.2, dash for the wrapper)", () => {
  for (const s of SHELLS) assert.ok(fs.existsSync(s), `${s} missing — the guard would not check portability otherwise`);
});

for (const shell of SHELLS) {
  test(`${shell}: separation, marker, /etc/hosts in this order, leftovers gone, setpriv last`, async () => {
    const w = build((w) => {
      for (const f of ["var/run/docker.pid", "run/docker/containerd/containerd.pid", "var/run/docker.sock"]) fs.writeFileSync(path.join(w.root, f), "alt");
      fs.mkdirSync(path.dirname(w.marker), { recursive: true });
      fs.writeFileSync(w.marker, "1111\n");
    });
    try {
      const r = await run(w, { shell });
      assert.equal(r.code, 0, r.err);
      checkSeparation(r, w);
      for (const f of ["var/run/docker.pid", "run/docker/containerd/containerd.pid", "var/run/docker.sock"]) assert.equal(fs.existsSync(path.join(w.root, f)), false, f);
      assert.equal(r.err.includes("failed"), false, r.err);
    } finally { way(w); }
  });

  test(`${shell}: iptables with exit 1 => setpriv reached, no marker, and after "info answers" the stop of all project containers`, async () => {
    const w = build((w) => { fs.mkdirSync(path.dirname(w.marker), { recursive: true }); fs.writeFileSync(w.marker, `${START}\n`); });
    try {
      const r = await run(w, { shell, env: { FAKE_EXIT_IPTABLES: "1" } });
      assert.equal(r.code, 0, r.err);
      const p = r.log;
      assert.ok(index(p, "setpriv ") >= 0, "setpriv not reached");
      assert.ok(index(p, "dockerd") >= 0, "without separation dockerd must start anyway");
      assert.equal(fs.existsSync(w.marker), false, "a marker from the previous start stayed although the separation failed");
      const iInfo = index(p, "docker info");
      const iPs = index(p, "docker ps -q --filter label=cbase.project");
      const iStop = index(p, "docker stop -t 30 c-one c-two");
      assert.ok(iInfo >= 0 && iInfo < iPs && iPs < iStop, `stop after "info answers" missing:\n${p.join("\n")}`);
      assert.match(r.err, /network separation .* failed/);
    } finally { way(w); }
  });

  test(`${shell}: without separation first thaw the paused project containers, then stop all; without paused ones no unpause`, async () => {
    const w = build();
    const w2 = build();
    try {
      const r = await run(w, { shell, env: { FAKE_EXIT_IPTABLES: "1", FAKE_PAUSED: "c-two" } });
      assert.equal(r.code, 0, r.err);
      checkThaw(r);
      const without = await run(w2, { shell, env: { FAKE_EXIT_IPTABLES: "1" } });
      assert.ok(!without.log.some((z) => z.startsWith("docker unpause")), `an unpause without paused ones:\n${without.log.join("\n")}`);
      assert.ok(index(without.log, "docker stop -t 30 c-one c-two") >= 0, "without paused ones the stop is missing");
    } finally { way(w); way(w2); }
  });

  test(`${shell}: separation stands but the marker cannot be written => message, no marker, setpriv reached, and after "info answers" the stop of all project containers`, async () => {
    // /proc/1/stat missing: pid1_start fails, so the marker write fails — AFTER a successful separation.
    const w = build((w) => fs.rmSync(path.join(w.root, "proc/1/stat")));
    try {
      const r = await run(w, { shell });
      assert.equal(r.code, 0, r.err);
      checkMarkerMissing(r, w);
    } finally { way(w); }
  });

  test(`${shell}: chgrp with exit 1 => message, setpriv reached`, async () => {
    const w = build();
    try {
      const r = await run(w, { shell, env: { FAKE_EXIT_CHGRP: "1" } });
      assert.equal(r.code, 0, r.err);
      assert.ok(index(r.log, "setpriv ") >= 0);
      assert.match(r.err, /\/etc\/hosts not writable/);
      assert.equal(fs.readFileSync(w.marker, "utf8").trim(), START, "an error at /etc/hosts does not take the separation away");
    } finally { way(w); }
  });

  test(`${shell}: without CBASE_DIND=1 neither iptables nor dockerd nor chgrp`, async () => {
    const w = build();
    try {
      const r = await run(w, { shell, env: { CBASE_DIND: "0" } });
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(r.log.filter((z) => /^(iptables|dockerd|chgrp|docker) /.test(`${z} `)), []);
      assert.equal(fs.existsSync(w.marker), false);
      assert.ok(index(r.log, "setpriv ") >= 0);
    } finally { way(w); }
  });
}

test("a second run in the same network state does not set the jump twice (-C before -I)", async () => {
  const w = build();
  try {
    await run(w);
    fs.rmSync(w.marker);
    const r = await run(w);
    assert.deepEqual(r.rules.filter((z) => z.startsWith("-A INPUT")), [JUMP]);
    assert.equal(r.rules.filter((z) => z.startsWith("-A CBASE-PROJ")).length, 3, "the chain is flushed, not doubled");
  } finally { way(w); }
});

test("counter-proof: the state before the separation has neither chain nor permission nor marker — the check is red", async () => {
  const old = oldRevision();
  const w = build();
  const script = path.join(w.base, "entry-old.sh");
  fs.writeFileSync(script, old);
  try {
    const r = await run(w, { script });
    assert.equal(r.code, 0, r.err);
    assert.throws(() => checkSeparation(r, w, old), assert.AssertionError, "the check does not notice the missing separation");
  } finally { way(w); }
});

// The bridge prefix (hard cut): entry.sh matches the bridges the backend creates (`cbp-<n>`). Counter-proof: today's
// script with the jump over the prefix before (spelled in pieces — the old-name latch counts no deliberate counter-proof) sets a
// chain that guards no project network of this release — the check is red.
test("the jump matches the bridge prefix of the backend; counter-proof: the old prefix — the check is red", async () => {
  assert.equal(JUMP, "-A INPUT -i cbp-+ -j CBASE-PROJ");
  const text = fs.readFileSync(ENTRY, "utf8");
  const old = text.replaceAll("-i cbp-+", `-i ${"hx" + "p-"}+`);
  assert.equal(text.split("-i cbp-+").length - 1, 2, "entry.sh: the jump stands in -C and -I — the sabotage does not bite");
  const w = build();
  const script = path.join(w.base, "entry-old-prefix.sh");
  fs.writeFileSync(script, old);
  try {
    const r = await run(w, { script });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.rules.some((z) => z.startsWith("-A INPUT -i ") && !z.includes("cbp-")), "the sabotaged script did not set its jump — then this checks something else");
    assert.throws(() => checkSeparation(r, w, old), assert.AssertionError, "the check does not notice the old prefix");
  } finally { way(w); }
});

test("counter-proof: the same version without the rm of the marker leaves a marker from the previous start standing", async () => {
  const text = fs.readFileSync(ENTRY, "utf8");
  const without = text.replace(' "$NETWORK_MARKER" "$NETWORK_MARKER.fresh"', "");
  assert.notEqual(without, text, "the rm row has moved — the sabotage does not bite");
  const w = build((w) => { fs.mkdirSync(path.dirname(w.marker), { recursive: true }); fs.writeFileSync(w.marker, `${START}\n`); });
  const script = path.join(w.base, "entry-without-rm.sh");
  fs.writeFileSync(script, without);
  try {
    await run(w, { script, env: { FAKE_EXIT_IPTABLES: "1" } });
    assert.equal(fs.existsSync(w.marker), true, "without the rm the marker disappears anyway — then the test above checks nothing");
  } finally { way(w); }
});

test("counter-proof: the state before the missing-marker stop (BEFORE_PB_6) reports the missing marker but stops nothing — the check is red", async () => {
  const old = entryBeforePb6();
  assert.match(old, /network_marker_write \|\| echo /, "the rebuilt script is not the state before that fix");
  const w = build((w) => fs.rmSync(path.join(w.root, "proc/1/stat")));
  const script = path.join(w.base, "entry-before-pb6.sh");
  fs.writeFileSync(script, old);
  try {
    const r = await run(w, { script });
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.log.some((z) => z.startsWith("docker stop")), "the old state did stop after all — then the test above checks nothing");
    assert.throws(() => checkMarkerMissing(r, w), assert.AssertionError, "the check does not notice the missing stop");
  } finally { way(w); }
});

test("counter-proof: the state before the thaw (BEFORE_ST2_3) stops a paused project container without thawing it — the check is red", async () => {
  const old = entryBeforeSt23();
  assert.ok(/project_container_stop/.test(old) && !/^\s*docker unpause/m.test(old), "the rebuilt script is not the state before the thaw");
  const w = build();
  const script = path.join(w.base, "entry-before-st2-3.sh");
  fs.writeFileSync(script, old);
  try {
    const r = await run(w, { script, env: { FAKE_EXIT_IPTABLES: "1", FAKE_PAUSED: "c-two" } });
    assert.equal(r.code, 0, r.err);
    assert.ok(index(r.log, "docker stop -t 30 c-one c-two") >= 0, "the old state did not stop — then the test above checks nothing");
    assert.throws(() => checkThaw(r), assert.AssertionError, "the check does not notice the missing thaw");
  } finally { way(w); }
});

// ── the "B ends" marker is gone after every start ────────────────────────────────────────────────────────────────

// A marker from the previous start plus a half-written .fresh (the gateway writes atomically via .fresh + mv), 0644 as there.
function withBEnds(w) {
  fs.mkdirSync(path.dirname(w.bEnds), { recursive: true });
  fs.writeFileSync(w.bEnds, `${Date.now()}\n`, { mode: 0o644 });
  fs.writeFileSync(`${w.bEnds}.fresh`, `${Date.now()}\n`, { mode: 0o644 });
}
// As a function, so the same check turns red on the sabotaged version.
function checkBEndsGone(r, w) {
  const text = `\n${r.log.join("\n")}\n--- stderr\n${r.err}`;
  assert.ok(index(r.log, "setpriv ") >= 0, `setpriv not reached${text}`);
  assert.equal(exists(w.bEnds), false, `the "B ends" marker from the previous start still stands after the start — serverEnds() would stay wrong-true${text}`);
  assert.equal(exists(`${w.bEnds}.fresh`), false, `b-ends.fresh from the previous start still stands after the start${text}`);
}

for (const shell of SHELLS) {
  test(`${shell}: a "B ends" marker from the previous start (with .fresh) is gone after the start, with and without network separation`, async () => {
    const w = build(withBEnds);
    const without = build(withBEnds);
    try {
      const r = await run(w, { shell });
      assert.equal(r.code, 0, r.err);
      checkBEndsGone(r, w);
      assert.ok(r.log.some((z) => z.startsWith("rm -f ") && z.includes(w.bEnds)), `the rm does not name the marker:\n${r.log.join("\n")}`);
      const r2 = await run(without, { shell, env: { FAKE_EXIT_IPTABLES: "1" } });
      assert.equal(r2.code, 0, r2.err);
      checkBEndsGone(r2, without);
    } finally { way(w); way(without); }
  });
}

test("counter-proof: the same version without removing the \"B ends\" marker leaves it standing — the check is red", async () => {
  const text = fs.readFileSync(ENTRY, "utf8");
  const without = text.replace(' "$B_ENDS_MARKER" "$B_ENDS_MARKER.fresh"', "");
  assert.notEqual(without, text, "the rm row has moved — the sabotage does not bite");
  const w = build(withBEnds);
  const script = path.join(w.base, "entry-without-b-ends.sh");
  fs.writeFileSync(script, without);
  try {
    const r = await run(w, { script });
    assert.equal(r.code, 0, r.err);
    assert.equal(exists(w.bEnds), true, "without the rm the marker disappears anyway — then the test above checks nothing");
    assert.throws(() => checkBEndsGone(r, w), assert.AssertionError, "the check does not notice the marker left standing");
  } finally { way(w); }
});

// ── login relocation ─────────────────────────────────────────────────────────────────────────────────────────────

for (const shell of SHELLS) {
  test(`${shell}: only old => moved by mv into the login directory (0700), owner agent, 0600; the old place is empty`, async () => {
    const w = build((w) => file(w.old, WRONG("alt"), { mtime: 1_700_000_000, mode: 0o644 }));
    try {
      const ino = fs.statSync(w.old).ino;
      const r = await run(w, { shell });
      assert.equal(r.code, 0, r.err);
      assert.equal(fs.existsSync(w.old), false);
      assert.equal(fs.readFileSync(w.fresh, "utf8"), WRONG("alt"));
      assert.equal(fs.statSync(w.fresh).ino, ino, "no mv (new inode) — then it was a copy");
      assert.equal(fs.statSync(w.fresh).mtimeMs, 1_700_000_000_000, "mv keeps the mtime (the rule \"the newer one stays\" needs it)");
      assert.equal(fs.statSync(w.login).mode & 0o777, 0o700);
      assert.equal(fs.statSync(w.fresh).mode & 0o777, 0o600);
      assert.ok(r.log.includes(`chown -h agent:agent ${w.login}`), "login directory not handed to agent");
      assert.ok(r.log.includes(`chown -h agent:agent ${w.fresh}`), "foreign owner (root after a run as root) would stay");
      assert.ok(index(r.log, /^chown .*\.credentials\.json$/) < index(r.log, "setpriv "), "chown after setpriv");
    } finally { way(w); }
  });

  test(`${shell}: both, ~/.claude newer => it moves in, the one from the login directory is put aside`, async () => {
    const w = build((w) => {
      file(w.fresh, WRONG("fresh"), { mtime: 1_700_000_000 });
      file(w.old, WRONG("alt"), { mtime: 1_700_000_500 });
    });
    try {
      const r = await run(w, { shell });
      assert.equal(r.code, 0, r.err);
      assert.equal(fs.readFileSync(w.fresh, "utf8"), WRONG("alt"));
      assert.equal(fs.existsSync(w.old), false);
      const b = aside(w);
      assert.equal(b.length, 1, b.join(", "));
      assert.match(b[0], /^\.credentials\.json\.aside-\d{8}T\d{6}Z-login$/);
      assert.equal(fs.readFileSync(path.join(w.login, b[0]), "utf8"), WRONG("fresh"), "the older one is lost");
    } finally { way(w); }
  });

  test(`${shell}: both, login directory newer => it stays, the one from ~/.claude is put aside; a second start without effect`, async () => {
    const w = build((w) => {
      file(w.fresh, WRONG("fresh"), { mtime: 1_700_000_500 });
      file(w.old, WRONG("alt"), { mtime: 1_700_000_000 });
    });
    try {
      await run(w, { shell });
      assert.equal(fs.readFileSync(w.fresh, "utf8"), WRONG("fresh"));
      assert.equal(fs.existsSync(w.old), false);
      const b = aside(w);
      assert.deepEqual(b.map((n) => n.replace(/\d{8}T\d{6}Z/, "<ts>")), [".credentials.json.aside-<ts>-claude"]);
      assert.equal(fs.readFileSync(path.join(w.login, b[0]), "utf8"), WRONG("alt"));
      const prior = snapshot(w.home);
      const r2 = await run(w, { shell });
      assert.equal(r2.code, 0, r2.err);
      assert.deepEqual(snapshot(w.home), prior, "a second start changed something");
      assert.equal(r2.err.includes("Login:"), false, `a second start reports a relocation: ${r2.err}`);
    } finally { way(w); }
  });
}

test("both with the same mtime => the one in the login directory stays", async () => {
  const w = build((w) => {
    file(w.fresh, WRONG("fresh"), { mtime: 1_700_000_000 });
    file(w.old, WRONG("alt"), { mtime: 1_700_000_000 });
  });
  try {
    await run(w);
    assert.equal(fs.readFileSync(w.fresh, "utf8"), WRONG("fresh"));
    assert.equal(aside(w).length, 1);
    assert.match(aside(w)[0], /-claude$/);
  } finally { way(w); }
});

test("only new => nothing changes (except owner/mode, which are already right)", async () => {
  const w = build((w) => { fs.mkdirSync(w.login, { mode: 0o700 }); file(w.fresh, WRONG("fresh"), { mtime: 1_700_000_000 }); });
  try {
    const prior = snapshot(w.home);
    const r = await run(w);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(snapshot(w.home), prior);
  } finally { way(w); }
});

test("no file => only the empty login directory (0700), no file appears", async () => {
  const w = build();
  try {
    const r = await run(w);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(snapshot(w.home), { ".claude-login": { kind: "dir", mode: 0o700 } });
  } finally { way(w); }
});

test("symlink as old file => the LINK moves (never read, never followed), its target stays untouched, no chown on it", async () => {
  const w = build((w) => {
    file(path.join(w.base, "foreign", "secret"), "do not read", { mtime: 1_700_000_000, mode: 0o600 });
    fs.mkdirSync(path.dirname(w.old), { recursive: true });
    fs.symlinkSync(path.join(w.base, "foreign", "secret"), w.old);
  });
  try {
    const r = await run(w);
    assert.equal(r.code, 0, r.err);
    assert.equal(exists(w.old), false, "the old link still stands");
    assert.ok(fs.lstatSync(w.fresh).isSymbolicLink(), "the link was resolved instead of renamed");
    assert.equal(fs.readlinkSync(w.fresh), path.join(w.base, "foreign", "secret"));
    assert.equal(fs.readFileSync(path.join(w.base, "foreign", "secret"), "utf8"), "do not read");
    assert.equal(fs.statSync(path.join(w.base, "foreign", "secret")).mode & 0o777, 0o600, "root touched the link target");
    assert.ok(!r.log.includes(`chown -h agent:agent ${w.fresh}`), "chown on a link");
    assert.ok(!r.log.some((z) => z.includes("foreign/secret")), "root touched the link target");
  } finally { way(w); }
});

test("symlink as login directory => nothing is moved, message, setpriv reached", async () => {
  const w = build((w) => {
    file(w.old, WRONG("alt"));
    fs.mkdirSync(path.join(w.base, "elsewhere"));
    fs.symlinkSync(path.join(w.base, "elsewhere"), w.login);
  });
  try {
    const r = await run(w);
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(w.old, "utf8"), WRONG("alt"), "the login is gone");
    assert.deepEqual(fs.readdirSync(path.join(w.base, "elsewhere")), [], "root wrote through the link");
    assert.match(r.err, /not a directory \(or is a symlink\)/);
    assert.ok(!r.log.some((z) => z.startsWith("chown")), "chown through a link");
    assert.ok(index(r.log, "setpriv ") >= 0);
    assert.equal(varAtSetpriv(w), "", "the login lies in ~/.claude, but the variable points to the login directory");
  } finally { way(w); }
});

test("~/.claude as a symlink => the old place is not touched", async () => {
  const w = build((w) => {
    file(path.join(w.base, "elsewhere", ".credentials.json"), WRONG("foreign"));
    fs.symlinkSync(path.join(w.base, "elsewhere"), path.join(w.home, ".claude"));
  });
  try {
    const r = await run(w);
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(path.join(w.base, "elsewhere", ".credentials.json"), "utf8"), WRONG("foreign"));
    assert.equal(fs.existsSync(w.fresh), false);
    assert.match(r.err, /\.claude is a symlink/);
    assert.equal(varAtSetpriv(w), "", "the login lies behind ~/.claude, but the variable points to the login directory");
  } finally { way(w); }
});

test("hard link => moves, but no chown/chmod (the second name may belong to someone else)", async () => {
  const w = build((w) => {
    file(w.old, WRONG("alt"), { mode: 0o640 });
    fs.linkSync(w.old, path.join(w.base, "second-name"));
  });
  try {
    const r = await run(w);
    assert.equal(fs.readFileSync(w.fresh, "utf8"), WRONG("alt"));
    assert.ok(!r.log.includes(`chown -h agent:agent ${w.fresh}`));
    assert.equal(fs.statSync(path.join(w.base, "second-name")).mode & 0o777, 0o640, "chmod through the second name");
    assert.match(r.err, /several hard links/);
    assert.ok(index(r.log, "setpriv ") >= 0);
  } finally { way(w); }
});

test("without DIND the login moves anyway (the variable comes through the image ENV into EVERY container)", async () => {
  const w = build((w) => file(w.old, WRONG("alt")));
  try {
    const r = await run(w, { env: { CBASE_DIND: "0" } });
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(w.fresh, "utf8"), WRONG("alt"));
    assert.equal(fs.existsSync(w.old), false);
    assert.equal(varAtSetpriv(w), w.login, "after a successful relocation the variable stays");
  } finally { way(w); }
});

test("without the variable (image without relocation) and without root => nothing", async () => {
  for (const env of [{ CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }, { FAKE_UID: "1001" }]) {
    const w = build((w) => file(w.old, WRONG("alt"), { mtime: 1_700_000_000 }));
    try {
      const prior = snapshot(w.home);
      const r = await run(w, { env });
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(snapshot(w.home), prior, JSON.stringify(env));
    } finally { way(w); }
  }
});

// An early abort (here `chmod 700` of the login directory with exit 1) leaves the file at the old place.
async function earlyAbort(script) {
  const w = build((w) => file(w.old, WRONG("alt")));
  try {
    const r = await run(w, { env: { CBASE_DIND: "0", FAKE_EXIT_CHMOD: "1" }, ...(script ? { script: script(w) } : {}) });
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(w.old, "utf8"), WRONG("alt"), "the login is gone");
    assert.equal(fs.existsSync(w.fresh), false);
    return { r, var: varAtSetpriv(w) };
  } finally { way(w); }
}

for (const shell of SHELLS) {
  test(`${shell}: early abort of the relocation => setpriv reaches the variable EMPTY (the CLI reads ~/.claude), with a message`, async () => {
    const w = build((w) => file(w.old, WRONG("alt")));
    try {
      const r = await run(w, { shell, env: { CBASE_DIND: "0", FAKE_EXIT_CHMOD: "1" } });
      assert.equal(r.code, 0, r.err);
      assert.equal(fs.readFileSync(w.old, "utf8"), WRONG("alt"));
      assert.match(r.err, /login relocation incomplete/);
      assert.match(r.err, /CLAUDE_SECURESTORAGE_CONFIG_DIR cleared for this start/);
      assert.equal(varAtSetpriv(w), "");
    } finally { way(w); }
  });
}

test("no file at either place => the variable stays (the CLI creates the login in the login directory on sign-in)", async () => {
  const w = build();
  try {
    const r = await run(w);
    assert.equal(r.code, 0, r.err);
    assert.equal(varAtSetpriv(w), w.login);
  } finally { way(w); }
});

test("counter-proof: the state before the login-variable fix passes the variable on after an early abort — the check is red", async () => {
  const old = entryBeforePb1();
  assert.ok(/login_relocation/.test(old) && !/cleared for this start/.test(old), "the rebuilt script is not the state before that fix");
  const { var: value } = await earlyAbort((w) => {
    const f = path.join(w.base, "entry-before-pb1.sh");
    fs.writeFileSync(f, old);
    return f;
  });
  assert.notEqual(value, null, "the old version did not reach setpriv");
  assert.notEqual(value, "", "the old version already cleared the variable — the counter-proof measures nothing");
  const { var: fresh } = await earlyAbort();
  assert.equal(fresh, "");
});

test("counter-proof: the state before the relocation leaves the file at the old place — the \"only old\" check is red", async () => {
  const old = oldRevision();
  const w = build((w) => file(w.old, WRONG("alt")));
  const script = path.join(w.base, "entry-old.sh");
  fs.writeFileSync(script, old);
  try {
    const r = await run(w, { script });
    assert.equal(r.code, 0, r.err);
    assert.ok(index(r.log, "setpriv ") >= 0, "the old version aborted before setpriv");
    assert.equal(fs.existsSync(w.fresh), false);
    assert.equal(fs.existsSync(w.old), true);
  } finally { way(w); }
});
