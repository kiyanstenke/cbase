// The deadlines of the stop chain belong together. They live in several files, and each used to check only its own literal —
// raising the server-end cap to 60 s kept all suites green, and B would have died by SIGKILL in the middle of the chain,
// project containers included.
//
//   server/gateway/containers.js     B_STOP_DEADLINE (s)          `--stop-timeout` of every B, `stop -t` of the gateway
//                                    (lib/swap.mjs of the deploy tool re-exports it: ONE number, the maintainer's private suite binds that)
//   runs/server-end.js               SERVER_END_CAP_MS            waiting for "serverEnd"
//                                    CLOSE_CAP_MS                 waiting for server.close
//   projectbox/serverEnd.js          SNAPSHOT_CAP_MS              per docker call of the snapshot (two in a row)
//                                    PROJECT_STOP_DEADLINE_S      `docker stop -t` of the project containers
//
// Required: 2 × snapshot + project stop < server-end cap (the stop must be able to BEGIN
// and end within the chain); server end + close + MARGIN <= stop deadline of B. The source text (regex) is read, not the module:
// server-end.js and serverEnd.js hang on the store, containers.js on the gateway.
// Counter-proof: the same check on altered text versions (server end 60 s, gateway 30 s, snapshot 10 s) is red.
//
// Only the LITERALS were bound. What counts in the product is the value of the regulator function — `snapshotCapMs()` and
// `serverEndCapMs()` each have their own fallback, and a fallback to another number (`: 10_000;`) would leave every check
// here green. So each of the two functions must carry exactly ONE `return` that ends with `: <CONSTANT>;`. That the product
// also CALLS the function is held by the behavior tests with the regulator (server/backend/test/projectbox-server-end.test.js:
// "cap: …", "hanging snapshot: …", "hanging inspect: …"). Counter-proofs: both fallbacks to another number => red.
//
// Run:  node --test --test-reporter=tap tools/check/deadlines.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCES = {
  gateway: "server/gateway/containers.js",
  serverEnd: "server/backend/electron/server/runs/server-end.js",
  projectbox: "server/backend/electron/server/projectbox/serverEnd.js",
};
// Time for node exit, signals and the wrapper between the end of the chain and the daemon's SIGKILL.
const MARGIN_MS = 5_000;

function count(text, name, file) {
  const m = new RegExp(`export const ${name} = ([0-9_]+);`).exec(text);
  assert.ok(m, `${file}: \`export const ${name} = <number>;\` missing`);
  return Number(m[1].replace(/_/g, ""));
}

function read(texts) {
  return {
    gatewayS: count(texts.gateway, "B_STOP_DEADLINE", SOURCES.gateway),
    serverEndMs: count(texts.serverEnd, "SERVER_END_CAP_MS", SOURCES.serverEnd),
    closeMs: count(texts.serverEnd, "CLOSE_CAP_MS", SOURCES.serverEnd),
    snapshotMs: count(texts.projectbox, "SNAPSHOT_CAP_MS", SOURCES.projectbox),
    projectStopS: count(texts.projectbox, "PROJECT_STOP_DEADLINE_S", SOURCES.projectbox),
  };
}

function check(f) {
  const chain = 2 * f.snapshotMs + f.projectStopS * 1000;
  assert.ok(chain < f.serverEndMs, `2 × snapshot + project stop = ${chain} ms does not fit in the server-end cap (${f.serverEndMs} ms)`);
  const end = f.serverEndMs + f.closeMs + MARGIN_MS;
  assert.ok(end <= f.gatewayS * 1000, `server end + close + margin = ${end} ms is above the stop deadline of B (${f.gatewayS} s)`);
}

// Without environment the regulator function falls back to EXACTLY the bound constant: one `return` that ends with
// `: <CONSTANT>;`.
const FALLBACKS = [
  ["serverEnd", "serverEndCapMs", "SERVER_END_CAP_MS"],
  ["projectbox", "snapshotCapMs", "SNAPSHOT_CAP_MS"],
];
function checkFallback(t) {
  for (const [file, fn, constant] of FALLBACKS) {
    const m = new RegExp(`\\nexport function ${fn}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}`).exec(t[file]);
    assert.ok(m, `${SOURCES[file]}: \`export function ${fn}()\` missing`);
    const returns = m[1].split("\n").filter((z) => /\breturn\b/.test(z));
    assert.equal(returns.length, 1, `${SOURCES[file]}: ${fn}() carries ${returns.length} return — the fallback is ambiguous`);
    assert.match(returns[0], new RegExp(`: ${constant};\\s*$`), `${SOURCES[file]}: ${fn}() does not fall back to ${constant}: ${returns[0].trim()}`);
  }
}

const texts = () => Object.fromEntries(Object.entries(SOURCES).map(([k, p]) => [k, fs.readFileSync(path.join(REPO, p), "utf8")]));

test("the deadlines of the stop chain fit together", () => {
  const f = read(texts());
  check(f);
  console.log(`# deadlines: B ${f.gatewayS} s ≥ server end ${f.serverEndMs / 1000} s + close ${f.closeMs / 1000} s + margin ${MARGIN_MS / 1000} s; ` +
    `chain 2 × ${f.snapshotMs / 1000} s + ${f.projectStopS} s < ${f.serverEndMs / 1000} s`);
});

for (const [name, file, from, after] of [
  ["server-end cap to 60 s", "serverEnd", "SERVER_END_CAP_MS = 45_000", "SERVER_END_CAP_MS = 60_000"],
  ["gateway deadline to 30 s", "gateway", "B_STOP_DEADLINE = 60", "B_STOP_DEADLINE = 30"],
  ["snapshot cap to 10 s", "projectbox", "SNAPSHOT_CAP_MS = 5_000", "SNAPSHOT_CAP_MS = 10_000"],
]) {
  test(`counter-proof: ${name} => red`, () => {
    const t = texts();
    assert.ok(t[file].includes(from), `${SOURCES[file]}: "${from}" is gone — update the counter-proof`);
    t[file] = t[file].replace(from, after);
    assert.throws(() => check(read(t)), assert.AssertionError);
  });
}

test("the regulator functions fall back to the bound constants without environment", () => {
  checkFallback(texts());
});

for (const [name, file, from, after] of [
  ["fallback of the snapshot cap to 10 s", "projectbox", ": SNAPSHOT_CAP_MS;", ": 10_000;"],
  ["fallback of the server-end cap to 60 s", "serverEnd", ": SERVER_END_CAP_MS;", ": 60_000;"],
]) {
  test(`counter-proof: ${name} => red although the literals match`, () => {
    const t = texts();
    assert.ok(t[file].includes(from), `${SOURCES[file]}: "${from}" is gone — update the counter-proof`);
    t[file] = t[file].replace(from, after);
    check(read(t)); // the literals alone do not notice it
    assert.throws(() => checkFallback(t), assert.AssertionError);
  });
}
