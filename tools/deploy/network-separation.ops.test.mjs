// The status row "network separation" — lib/network-separation.mjs over the output of `iptables -S`, the marker and /proc/1/stat of
// a user container.
//
// Promises, each with its counter-path: the target situation is "ok"; a missing chain (B older than the feature) "warn"; every
// deviation — double jump, missing `-i cbp-+` (also the jump over the prefix before 18.11.2026), `br-`, another rule order, marker missing or from another start — "bad". Plus the
// binding of the THREE versions of the start-time rule (entry.sh `pid1_start`, projectbox/network-marker.js,
// lib/network-separation.mjs): the same lines, the same result.
//
// Private half (the public one binds entry.sh to the backend). Run:  node --test --test-reporter=tap tools/deploy/network-separation.ops.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BRIDGE_MATCH, networkSeparationCommand, networkSeparationRow, startTimeFromStat } from "./lib/network-separation.mjs";
import { BRIDGE_PREFIX } from "../../server/backend/electron/server/projectbox/creation.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, "../../server/backend/entry.sh");
const STAT = (start, name = "docker-init") =>
  `1 (${name}) S 0 1 1 0 -1 4194560 1060 0 0 0 1 2 0 0 20 0 1 0 ${start} 1150976 1 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0`;

// This is how `iptables -S` (nft variant, Debian bookworm) prints the chain — with the `-m tcp` that iptables adds to --dport.
const CHAIN = [
  "-N CBASE-PROJ",
  "-A CBASE-PROJ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
  "-A CBASE-PROJ -p tcp -m tcp --dport 7718 -j ACCEPT",
  "-A CBASE-PROJ -p tcp -j REJECT --reject-with tcp-reset",
];
const INPUT = ["-P INPUT ACCEPT", "-A INPUT -i cbp-+ -j CBASE-PROJ"];
const output = ({ chain = CHAIN, input = INPUT, marker = "4242", stat = STAT(4242) } = {}) =>
  ["--- CHAIN", ...chain, "--- INPUT", ...input, "--- MARKER", marker, "--- STAT", stat, ""].join("\n");

test("target situation => ok", () => {
  const [label, text, stage] = networkSeparationRow(output());
  assert.equal(label, "Network separation (CBASE-PROJ)");
  assert.equal(stage, "ok", text);
  assert.match(text, /marker valid/);
});

test("B older than the feature (no chain) => warn; nothing readable => warn", () => {
  const z = networkSeparationRow(output({ chain: ["iptables: No chain/target/match by that name."], input: ["-P INPUT ACCEPT"], marker: "cat: /run/cbase/network-separation.ok: No such file or directory" }));
  assert.equal(z[2], "warn", z[1]);
  assert.match(z[1], /missing/);
  assert.equal(networkSeparationRow("")[2], "warn");
  assert.equal(networkSeparationRow("Error response from daemon: container not running")[2], "warn");
});

test("every deviation => bad", () => {
  const cases = {
    "double jump": output({ input: [...INPUT, "-A INPUT -i cbp-+ -j CBASE-PROJ"] }),
    "jump missing": output({ input: ["-P INPUT ACCEPT"] }),
    "jump without cbp": output({ input: ["-A INPUT -j CBASE-PROJ"] }),
    // An older B (image before 18.11.2026): its jump guards the old bridges, the new ones stand open. Spelled in pieces so the
    // old-name latch of the maintainer's private suite does not count a deliberate counter-proof.
    "jump over the old prefix": output({ input: [`-A INPUT -i ${"hx" + "p-"}+ -j CBASE-PROJ`] }),
    "jump over a foreign prefix": output({ input: ["-A INPUT -i xcbp-+ -j CBASE-PROJ"] }),
    "br-": output({ input: ["-A INPUT -i br-+ -j CBASE-PROJ"] }),
    "order": output({ chain: [CHAIN[0], CHAIN[3], CHAIN[1], CHAIN[2]] }),
    "rule missing": output({ chain: CHAIN.slice(0, 3) }),
    "marker missing": output({ marker: "cat: /run/cbase/network-separation.ok: No such file or directory" }),
    "marker foreign": output({ marker: "4100" }),
    "stat broken": output({ stat: "broken" }),
  };
  for (const [name, a] of Object.entries(cases)) {
    const z = networkSeparationRow(a);
    assert.equal(z[2], "bad", `${name}: ${z[1]}`);
  }
  assert.match(networkSeparationRow(cases["marker foreign"])[1], /another start \(4100 ≠ 4242\)/);
});

test("the jump names the ONE prefix of the backend (creation.js BRIDGE_PREFIX) — and the status text says it", () => {
  assert.equal(BRIDGE_PREFIX, "cbp-");
  assert.equal(BRIDGE_MATCH, "-i cbp-+");
  assert.match(networkSeparationRow(output())[1], /jump 1× via cbp-\+/);
  assert.match(networkSeparationRow(output({ input: ["-A INPUT -j CBASE-PROJ"] }))[1], /jump without -i cbp-\+/);
  // entry.sh sets exactly this jump (the public guard tools/check/entry-sh.test.mjs runs it; here only the text).
  assert.ok(fs.readFileSync(ENTRY, "utf8").includes(`iptables -I INPUT ${BRIDGE_MATCH} -j CBASE-PROJ`), "entry.sh sets another jump than the deploy check expects");
});

test("the command reads as root, without a single quote in the script, and never fails", () => {
  const b = networkSeparationCommand("cbase-u-abc");
  assert.match(b, /^docker exec -u 0 cbase-u-abc sh -c '/);
  assert.equal(b.slice(b.indexOf("'") + 1, b.lastIndexOf("'")).includes("'"), false);
  assert.match(b, /\|\| true$/);
  for (const t of ["--- CHAIN", "iptables -S CBASE-PROJ", "--- INPUT", "iptables -S INPUT", "--- MARKER", "/run/cbase/network-separation.ok", "--- STAT", "/proc/1/stat"]) assert.ok(b.includes(t), t);
});

test("the deploy version of the start-time rule equals entry.sh", () => {
  const text = fs.readFileSync(ENTRY, "utf8");
  const m = /^pid1_start\(\) \{\n[\s\S]*?\n\}\n/m.exec(text);
  assert.ok(m, "pid1_start missing in entry.sh");
  for (const stat of [STAT(4242), STAT(99, "a) b (c"), STAT(1, "x"), "1 (x) S 0 1"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-network-"));
    try {
      fs.mkdirSync(path.join(dir, "proc/1"), { recursive: true });
      fs.writeFileSync(path.join(dir, "proc/1/stat"), `${stat}\n`);
      const r = spawnSync("/bin/sh", ["-c", `W="$1"\n${m[0]}pid1_start`, "sh", dir], { encoding: "utf8" });
      const shell = r.status === 0 ? r.stdout.trim() : null;
      assert.equal(startTimeFromStat(stat), shell, `deploy != entry.sh for ${stat}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
