// What a reconnected event stream backfills (src/lib/stream.ts) — the "missing beginning" bug.
// The one promise: afterwards the text is there EXACTLY ONCE.
//
// Counter-test map: `missingBeginning` set to `return server` (the naive "just send the text along")
// turns three checks red, among them "Text that is already there is not doubled". Set to `return ""`
// (nothing backfilled at all) turns "Joining mid-turn yields the whole text" red.
//
// Run:  node --test web/test/stream.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-stream-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "stream.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { missingBeginning } = await import(pathToFileURL(path.join(out, "stream.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

const SERVER = "I will look at the file first and report back afterwards.";

test("Joining mid-turn yields the whole text", () => {
  assert.equal(missingBeginning("", SERVER), SERVER);
});

test("Holding only the tail yields exactly the missing head", () => {
  const have = "report back afterwards.";
  const header = missingBeginning(have, SERVER);
  assert.equal(header + have, SERVER, "head + tail must reproduce the server state");
  assert.ok(header.length > 0);
});

test("Text that is already there is not doubled", () => {
  assert.equal(missingBeginning(SERVER, SERVER), "");
});

test("A client AHEAD of the snapshot gets nothing backfilled", () => {
  assert.equal(missingBeginning(SERVER + " One more sentence.", SERVER), "");
});

test("If nothing fits together, nothing is backfilled rather than something wrong", () => {
  assert.equal(missingBeginning("completely different text", SERVER), "");
});

test("Without a server state nothing happens — empty is not an instruction", () => {
  assert.equal(missingBeginning("", ""), "");
  assert.equal(missingBeginning("something", ""), "");
});

test("Across every cut point the text ends up exactly once", () => {
  for (let i = 0; i <= SERVER.length; i++) {
    const have = SERVER.slice(i);
    assert.equal(missingBeginning(have, SERVER) + have, SERVER, `cut at ${i}`);
  }
});
