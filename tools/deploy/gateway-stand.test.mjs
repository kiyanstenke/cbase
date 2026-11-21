// Gateway code on the host in the status (lib/gateway-stand.mjs).
//
// Promises:
//   (1) gatewayDeviations reads the itemization of the rsync DRY RUN the way this machine's rsync writes it (the deploy calls
//       the local rsync: openrsync on macOS prints `>f…`, GNU rsync `<f…`), measured against a real dry run on a throwaway
//       folder. Pure timestamps and directories are no deviation; a changed and a missing file are.
//   (2) gatewayRow: equal => ok "== working tree"; deviation => warn with the files and `--gateway`; a failed dry run =>
//       warn "not measured" (unknown is not equal).
//   (3) Wiring: targets/status.mjs shows the row from the SAME dry run as deployGateway (source server/gateway, target
//       `<root>/gateway/`, without `data`).
//
// COUNTER-TEST: without the line `gateway,` in the table of targets/status.mjs => (3) red; gatewayDeviations with `<f` only
// (GNU) => (1) red on this machine's openrsync.
//
// Run:  node --test --test-reporter=tap tools/deploy/gateway-stand.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GATEWAY_ROW, gatewayDeviations, gatewayRow } from "./lib/gateway-stand.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SOURCE = path.join(REPO, "server", "gateway");

// Same switches as lib/sh.mjs rsyncUp in dry-run mode, local instead of over ssh.
function dryrun(target) {
  const r = spawnSync("rsync", ["-r", "--checksum", "--times", "--exclude", "node_modules", "--exclude", ".DS_Store", "--exclude", "data", "-n", "-i", `${SOURCE}/`, `${target}/`], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

test("(1) gatewayDeviations on a real rsync dry run: times and directories are equal, a changed and a missing file deviate", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-gateway-stand-"));
  try {
    const target = path.join(tmp, "gateway");
    fs.cpSync(SOURCE, target, { recursive: true }); // same content, different timestamps
    fs.mkdirSync(path.join(target, "data"), { recursive: true });
    fs.writeFileSync(path.join(target, "data", "users.json"), "{}\n"); // gateway runtime data: never a deviation
    const equal = dryrun(target);
    assert.equal(equal.code, 0, equal.stderr);
    t.diagnostic(`rsync equal: ${JSON.stringify(equal.stdout.split("\n").slice(0, 3))}`);
    assert.deepEqual(gatewayDeviations(equal.stdout), [], equal.stdout);
    assert.deepEqual(gatewayRow(equal), [GATEWAY_ROW, "== working tree (the running gateway carries it)", "ok"]);

    fs.appendFileSync(path.join(target, "containers.js"), "// old\n");
    fs.rmSync(path.join(target, "users.js"));
    const ab = dryrun(target);
    assert.equal(ab.code, 0, ab.stderr);
    t.diagnostic(`rsync deviating: ${JSON.stringify(ab.stdout)}`);
    assert.deepEqual(gatewayDeviations(ab.stdout).sort(), ["containers.js", "users.js"], ab.stdout);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("(2) gatewayRow: GNU and openrsync form, list cap, a failed dry run is \"not measured\"", () => {
  const gnu = "sending incremental file list\n.d..t...... ./\n<fcst...... containers.js\n<f+++++++++ new.js\n.f..t...... index.js\n";
  assert.deepEqual(gatewayDeviations(gnu), ["containers.js", "new.js"]);
  const [name, text, stage] = gatewayRow({ code: 0, stdout: gnu, stderr: "" });
  assert.equal(name, GATEWAY_ROW);
  assert.equal(stage, "warn");
  assert.match(text, /^DEVIATES: containers\.js, new\.js — takes effect only after `\.\/deploy server --gateway`/);
  const many = Array.from({ length: 6 }, (_, i) => `>f+++++++ d${i}.js`).join("\n");
  assert.match(gatewayRow({ code: 0, stdout: many })[1], /^DEVIATES: d0\.js, d1\.js, d2\.js, d3\.js and 2 more — /);
  assert.deepEqual(gatewayRow({ code: 255, stdout: "", stderr: "ssh: connect to host x: Connection timed out\n" }),
    [GATEWAY_ROW, "not measured (rsync dry run: ssh: connect to host x: Connection timed out)", "warn"]);
  assert.equal(gatewayRow(null)[2], "warn");
});

test("(3) wiring: targets/status.mjs shows the row from the dry run of server/gateway to <root>/gateway/ without data", () => {
  const status = fs.readFileSync(path.join(HERE, "targets", "status.mjs"), "utf8");
  assert.match(status, /const gateway = gatewayRow\(await rsyncUp\(`\$\{path\.join\(REPO, "server\/gateway"\)\}\/`, `\$\{config\.remote\.root\}\/gateway\/`, \{ dryRunOnly: true, extraExcludes: \["data"\] \}\)\);/,
    "the status does not measure the gateway like deployGateway");
  const table = status.slice(status.indexOf('["web-out == web/out"'));
  assert.match(table.slice(0, 400), /\n\s+gateway,\n/, "the row is not in the server table");
  // same dry run as deployGateway (targets/server.mjs)
  const server = fs.readFileSync(path.join(HERE, "targets", "server.mjs"), "utf8");
  assert.match(server, /rsyncUp\(`\$\{path\.join\(REPO, "server\/gateway"\)\}\/`, `\$\{root\}\/gateway\/`, \{\s*dryRunOnly: true,\s*extraExcludes: \["data"\],?\s*\}\)/);
});
