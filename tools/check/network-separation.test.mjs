// The start-time rule of the network separation, public half: entry.sh `pid1_start` and projectbox/network-marker.js give the same
// answer. The third version (lib/network-separation.mjs) and the status row are bound in network-separation.ops.test.mjs.
//
// Run:  node --test --test-reporter=tap tools/check/network-separation.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startTimeFromStat as backendStartTime } from "../../server/backend/electron/server/projectbox/network-marker.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, "../../server/backend/entry.sh");
const STAT = (start, name = "docker-init") =>
  `1 (${name}) S 0 1 1 0 -1 4194560 1060 0 0 0 1 2 0 0 20 0 1 0 ${start} 1150976 1 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0`;

test("two versions of the start-time rule give the same answer (entry.sh, backend)", () => {
  const text = fs.readFileSync(ENTRY, "utf8");
  const m = /^pid1_start\(\) \{\n[\s\S]*?\n\}\n/m.exec(text);
  assert.ok(m, "pid1_start missing in entry.sh");
  const cases = [STAT(4242), STAT(99, "a) b (c"), STAT(1, "x"), "1 (x) S 0 1"];
  for (const stat of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-network-"));
    try {
      fs.mkdirSync(path.join(dir, "proc/1"), { recursive: true });
      fs.writeFileSync(path.join(dir, "proc/1/stat"), `${stat}\n`);
      const r = spawnSync("/bin/sh", ["-c", `W="$1"\n${m[0]}pid1_start`, "sh", dir], { encoding: "utf8" });
      const shell = r.status === 0 ? r.stdout.trim() : null;
      assert.equal(backendStartTime(stat), shell, `backend != entry.sh for ${stat}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
