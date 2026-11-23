// The dev-tree lock of the root script `deploy` and its node half (lib/rollout-checkout.mjs).
//
// PROMISES:
//   (1) In the dev tree the rollout commands (server, web, client, rollback, all, init) are locked — also when someone creates a
//       deploy.local.json there (the marker .cbase-rollout-checkout is the second key, and it is untracked and bound to the path).
//   (2) A rollout checkout without deploy.local.json is refused; a marker that names ANOTHER checkout (a copied folder or a copied
//       file) is refused; with both keys the shell lock passes (the node entry is reached).
//   (3) check and status stay free everywhere; mobile, baseline and unknown words stay locked even in a rollout checkout.
//   (4) The node half gives the same verdict on the same trees, and deploy.mjs asks it for every rollout run BEFORE anything else.
//   (5) The shell file and the node list name the same rollout words, and the marker is in .gitignore (never committed).
// COUNTER-PROOFS are in the cases themselves: dev tree + deploy.local.json => locked; checkout without deploy.local.json => refused;
// foreign marker => refused; and a SABOTAGED copy of the script (the marker test removed) lets the dev tree through, which (1) catches.
//
// The script under test is a copy of the real file in a temp tree with a stub entry (tools/deploy/deploy.mjs prints REACHED).
// Run:  node --test --test-reporter=tap tools/deploy/rollout-lock.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ROLLOUT_MARKER, ROLLOUT_WORDS, assertRolloutCheckout, isRolloutRun, rolloutCheckoutVerdict } from "./lib/rollout-checkout.mjs";
import { parseArgs } from "./deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SCRIPT = fs.readFileSync(path.join(REPO, "deploy"), "utf8");
const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

// A tree with the script (`text` replaces the real one for sabotage), a stub entry and the keys named in `keys`.
function tree({ local = false, marker = null, text = SCRIPT } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lock-")));
  made.push(dir);
  fs.mkdirSync(path.join(dir, "tools/deploy"), { recursive: true });
  fs.writeFileSync(path.join(dir, "deploy"), text, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "tools/deploy/deploy.mjs"), 'console.log("REACHED", process.argv.slice(2).join(" "));\n');
  if (local) fs.writeFileSync(path.join(dir, "deploy.local.json"), "{}\n");
  if (marker !== null) fs.writeFileSync(path.join(dir, ROLLOUT_MARKER), marker === true ? `${dir}\n` : marker);
  return dir;
}
const run = (dir, ...args) => spawnSync("/bin/sh", [path.join(dir, "deploy"), ...args], { encoding: "utf8" });
const locked = (r) => r.status === 2 && /locked/.test(r.stderr) && !r.stdout.includes("REACHED");
const reached = (r) => r.status === 0 && r.stdout.includes("REACHED");

test("(1) dev tree: every rollout word is locked — also with a stray deploy.local.json", () => {
  for (const dir of [tree(), tree({ local: true })]) {
    for (const w of ROLLOUT_WORDS) assert.ok(locked(run(dir, w)), `${w} in ${fs.existsSync(path.join(dir, "deploy.local.json")) ? "dev tree + deploy.local.json" : "dev tree"}`);
    assert.ok(locked(run(dir, "rollback", "server")));
    assert.ok(locked(run(dir, "web", "--dry-run")));
  }
  // The message names the way out.
  assert.match(run(tree({ local: true }), "server").stderr, /deploy\.local\.json plus the marker \.cbase-rollout-checkout/);
});

test("(2) rollout checkout: both keys pass; one key alone or a foreign marker is refused", () => {
  const ok = tree({ local: true, marker: true });
  for (const w of ROLLOUT_WORDS) assert.ok(reached(run(ok, w)), w);
  assert.ok(reached(run(ok, "rollback", "server", "--to", "20261113-1")));
  assert.ok(reached(run(ok, "all", "--dry-run")));
  // No deploy.local.json.
  assert.ok(locked(run(tree({ marker: true }), "server")), "marker without deploy.local.json");
  // Marker of another checkout (the file copied along with the folder, or written by hand with another path), empty marker.
  assert.ok(locked(run(tree({ local: true, marker: "/somewhere/else\n" }), "server")), "foreign path");
  assert.ok(locked(run(tree({ local: true, marker: "" }), "server")), "empty marker");
  const copy = tree({ local: true, marker: true });
  const moved = `${copy}-moved`;
  fs.renameSync(copy, moved); made.push(moved);
  assert.ok(locked(run(moved, "server")), "a moved or copied checkout carries a marker that names the old place");
});

test("(3) check and status are free everywhere; mobile, baseline and unknown words stay locked", () => {
  for (const dir of [tree(), tree({ local: true, marker: true })]) {
    assert.ok(reached(run(dir, "check")));
    assert.ok(reached(run(dir, "status")));
    assert.ok(reached(run(dir, "check", "--quick")));
  }
  const ok = tree({ local: true, marker: true });
  for (const w of ["mobile", "baseline", "frobnicate"]) assert.ok(locked(run(ok, w)), w);
  // A refusal that names a way out must name one that works: `mobile` does not run through the wrapper, but it does run
  // through deploy.mjs. Without this the message could promise any path at all and stay green.
  const out = run(ok, "mobile").stderr;
  const named = out.match(/node (tools\/deploy\/deploy\.mjs) mobile/);
  assert.ok(named, `the refusal of "mobile" does not name "node tools/deploy/deploy.mjs mobile": ${out}`);
  const direct = spawnSync(process.execPath, [path.join(ok, named[1]), "mobile"], { encoding: "utf8" });
  assert.ok(direct.status === 0 && direct.stdout.includes("REACHED mobile"), `the path the message names does not work: ${direct.stderr || direct.stdout}`);
});

test("(1) counter-proof: a copy of the script WITHOUT the marker test lets the dev tree through — the cases above would catch it", () => {
  const sabotaged = SCRIPT.replace(/ \\\n\s+&& \[ "\$\(cat "\$here\/\.cbase-rollout-checkout"\)" = "\$here" \]/, "").replace('[ -f "$here/.cbase-rollout-checkout" ]', "true");
  assert.notEqual(sabotaged, SCRIPT, "the sabotage found nothing to remove");
  const dev = tree({ local: true, text: sabotaged });
  assert.ok(reached(run(dev, "server")), "without the marker test the stray deploy.local.json unlocks the dev tree");
  assert.ok(locked(run(tree({ local: true }), "server")), "the real script keeps it locked");
});

test("(4) the node half gives the same verdicts on the same trees and deploy.mjs asks it first", () => {
  assert.equal(rolloutCheckoutVerdict(tree()).ok, false);
  assert.equal(rolloutCheckoutVerdict(tree({ local: true })).ok, false);
  assert.match(rolloutCheckoutVerdict(tree({ local: true })).reason, /looks like the dev tree/);
  assert.match(rolloutCheckoutVerdict(tree({ marker: true })).reason, /deploy\.local\.json is missing/);
  assert.match(rolloutCheckoutVerdict(tree({ local: true, marker: "/x" })).reason, /names another checkout/);
  assert.equal(rolloutCheckoutVerdict(tree({ local: true, marker: true })).ok, true);
  assert.throws(() => assertRolloutCheckout(tree({ local: true })), /Rollout refused.*never from the dev tree/);
  assertRolloutCheckout(tree({ local: true, marker: true }));
  // Which parsed runs count as rollout.
  const rollout = (argv) => isRolloutRun(parseArgs(argv));
  for (const argv of [["server"], ["web"], ["client"], ["all"], ["rollback", "server"], ["init"], ["web", "mobile"]]) assert.equal(rollout(argv), true, argv.join(" "));
  for (const argv of [["status"], ["check"], ["mobile", "--device"], ["baseline"]]) assert.equal(rollout(argv), false, argv.join(" "));
  // The call stands before every command that reaches the host, and the dev tree itself is locked right now.
  const src = fs.readFileSync(path.join(HERE, "deploy.mjs"), "utf8");
  const guard = src.indexOf("if (isRolloutRun(o)) {\n    assertRolloutCheckout(REPO);\n    await assertOwnInstallation();\n  }");
  assert.ok(guard > 0, "deploy.mjs does not call the rollout checkout guard");
  for (const later of ['if (o.command === "init") {', 'if (o.command === "rollback") {', "if (o.mobileTests) {", "const branch = await assertMainBranch"]) {
    assert.ok(src.indexOf(later) > guard, `${later} stands before the guard`);
  }
  if (!fs.existsSync(path.join(REPO, ROLLOUT_MARKER))) assert.equal(rolloutCheckoutVerdict(REPO).ok, false, "this tree is a dev tree: no marker");
});

test("(5) shell and node name the same rollout words; the marker never gets committed", () => {
  const line = SCRIPT.split("\n").find((l) => /^\s+server\|/.test(l));
  assert.deepEqual(line.trim().replace(/\)$/, "").split("|").sort(), [...ROLLOUT_WORDS].sort());
  assert.match(fs.readFileSync(path.join(REPO, ".gitignore"), "utf8"), /^\/\.cbase-rollout-checkout$/m);
  assert.match(fs.readFileSync(path.join(REPO, ".gitignore"), "utf8"), /^\/deploy\.local\.json$/m);
});
