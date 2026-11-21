// Private half of the entry script guard: the login retreat the deploy tool builds (lib/login-retreat.mjs) is undone by the start of B —
// the copy (cp -p, same mtime) loses against the login directory. Harness: lib/entry-sh-fixture.mjs (read the head of entry-sh.test.mjs).
//
// Run:  node --test --test-reporter=tap tools/deploy/entry-sh.ops.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { loginRetreat } from "./lib/login-retreat.mjs";
import {
  build, run, way, WRONG, file, aside,
} from "../check/lib/entry-sh-fixture.mjs";

test("rollback and forward again: the copy of the retreat (cp -p, same mtime) loses against the login directory", async () => {
  const insp = { Name: "/c", Config: { Env: ["CLAUDE_SECURESTORAGE_CONFIG_DIR=/home/agent/.claude-login"] }, Mounts: [{ Type: "volume", Name: "c-home", Destination: "/home/agent" }] };
  const { command: b } = loginRetreat(["PATH=/bin"]).copy(insp, "img");
  const script = b.slice(b.indexOf("'") + 1, b.lastIndexOf("'"));
  const w = build((w) => { fs.mkdirSync(w.login, { mode: 0o700 }); file(w.fresh, WRONG("fresh"), { mtime: 1_700_000_000 }); });
  try {
    const r0 = spawnSync("/bin/sh", ["-c", script], { env: { PATH: "/usr/bin:/bin", HOME: w.home, CLAUDE_SECURESTORAGE_CONFIG_DIR: w.login }, encoding: "utf8" });
    assert.equal(r0.status, 0, r0.stdout + r0.stderr);
    assert.equal(fs.readFileSync(w.old, "utf8"), WRONG("fresh"));
    const r = await run(w);
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(w.fresh, "utf8"), WRONG("fresh"));
    assert.equal(fs.existsSync(w.old), false);
    assert.deepEqual(aside(w).map((n) => n.replace(/\d{8}T\d{6}Z/, "<ts>")), [".credentials.json.aside-<ts>-claude"]);
  } finally { way(w); }
});
