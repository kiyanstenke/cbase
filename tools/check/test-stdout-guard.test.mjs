// The stdout guard of the gate suites (lib/test-stdout-guard.mjs) — against a REAL `node --test` run.
//
// PROMISES:
//   (1) COUNTER-PROOF: without the guard, a test file whose stdout carries a runner message and then a log line with a third byte
//       >= 0x80 ("\n▸ …", as tools/check/lib/log.mjs prints it) in ONE read of the runner fails with "Unable to deserialize cloned
//       data" — the failure of tools/deploy/init.test.mjs in two full gates on 2026-11-20. If this turns red because the run PASSES,
//       the Node in use has fixed its parser: the guard may go (and this test with it).
//   (2) The same file with the guard passes, every test counts, and the log line still appears in the TAP output.
//   (3) Every gate suite loads the guard: the NODE_TEST call of check.mjs carries `--import` of exactly this file.
//
// How (1) is made deterministic: the fixture stops its runner (SIGSTOP to its parent, the `node --test` this test spawned), writes
// a framed message and the log line as two writes, waits until both are in the pipe (write callbacks) and lets the runner go on
// (SIGCONT) — the runner then reads both in one chunk, as it does under load. No duration is waited for.
//
// Run:  node --test --test-reporter=tap tools/check/test-stdout-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isProtocolFrame } from "./lib/test-stdout-guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const GUARD = path.join(here, "lib", "test-stdout-guard.mjs");
const LINE = "▸ First installation: look at the host [+0:00]";

// The frame exactly as Node's v8-serializer reporter writes it: header, 4-byte size, header, value.
const FIXTURE = `import { test } from "node:test";
import v8 from "node:v8";
const write = (stream, chunk) => new Promise((resolve) => stream.write(chunk, resolve));
function frame(item) {
  const s = new v8.DefaultSerializer();
  s.writeHeader(); s.writeRawBytes(Buffer.alloc(4)); s.writeHeader(); s.writeValue(item);
  const b = s.releaseBuffer();
  b.writeUInt32BE(b.length - 6, 2);
  return b;
}
test("before", () => {});
test("message and log line in one read", async () => {
  process.kill(process.ppid, "SIGSTOP");
  try {
    await write(process.stdout, frame({ type: "test:diagnostic", data: { nesting: 0, message: "framed by hand", file: process.argv[1] } }));
    await write(process.stdout, ${JSON.stringify(`\n${LINE}\n`)});
  } finally {
    process.kill(process.ppid, "SIGCONT");
  }
});
test("after", () => {});
`;

// One runner, its own process group, killed hard in `finally` (a stopped runner would otherwise stay behind).
function run(file, { guard }) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const args = ["--test", "--test-reporter=tap", ...(guard ? [`--import=${GUARD}`] : []), file];
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", () => {});
  const done = new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout })));
  done.kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
  return done;
}

function withFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-stdout-guard-"));
  const file = path.join(dir, "coalesce-probe.mjs");
  fs.writeFileSync(file, FIXTURE);
  return fn(file).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const count = (out, key) => Number(new RegExp(`^# ${key} (\\d+)$`, "m").exec(out)?.[1] ?? NaN);

test("(1) counter-proof: without the guard the runner fails on a message and a log line in one read", () => withFixture(async (file) => {
  const r = run(file, { guard: false });
  try {
    const { code, stdout } = await r;
    assert.notEqual(code, 0, stdout);
    assert.match(stdout, /Unable to deserialize cloned data/, `the Node parser bug did not strike — fixed in ${process.version}? Then the guard may go.\n${stdout}`);
  } finally { r.kill(); }
}));

test("(2) with the guard the same file passes, every test counts, and the log line is still in the output", () => withFixture(async (file) => {
  const r = run(file, { guard: true });
  try {
    const { code, stdout } = await r;
    assert.equal(code, 0, stdout);
    assert.doesNotMatch(stdout, /deserialize/, stdout);
    assert.equal(count(stdout, "pass"), 3, stdout);
    assert.equal(count(stdout, "fail"), 0, stdout);
    assert.ok(stdout.includes(`# ${LINE}`), `the log line went missing:\n${stdout}`);
    assert.ok(stdout.includes("# framed by hand"), `the framed message did not reach the runner:\n${stdout}`);
  } finally { r.kill(); }
}));

test("(3) every gate suite loads the guard: NODE_TEST in check.mjs imports exactly this file, which exists", () => {
  const check = fs.readFileSync(path.join(repo, "tools", "check", "targets", "check.mjs"), "utf8");
  const value = /const NODE_TEST = "([^"]+)";/.exec(check)?.[1];
  assert.ok(value, "no `const NODE_TEST = \"…\";` in check.mjs — fix the anchor, do NOT delete the test");
  const imp = /--import=(\S+)/.exec(value)?.[1];
  assert.ok(imp, `NODE_TEST carries no --import: ${value}`);
  // The suites run with cwd = the repository root (check.mjs `start`), so the specifier is resolved from there.
  assert.equal(path.resolve(repo, imp), GUARD);
  assert.ok(fs.existsSync(GUARD));
  // The frame test of the guard itself.
  assert.equal(isProtocolFrame(Buffer.from([0xff, 0x0f, 0, 0, 0, 1])), true);
  assert.equal(isProtocolFrame(Buffer.from("\n▸ x\n")), false);
  assert.equal(isProtocolFrame("\xff\x0f"), false, "a string is never a frame");
});
