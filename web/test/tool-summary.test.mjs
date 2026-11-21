// The summary line above a tool group (src/lib/tool-summary.ts): WHAT it counts and WHEN the
// failure counter appears in parentheses. No browser: the wording is the contract with the
// DOM probe in a real browser and with the iOS app, which builds the same sentences.
//
// Counter-test: without `error` in the result (undefined instead of 1), and with two commands
// of which one failed reading just "Ran 2 commands", both checks below would turn red.
//
// Run:  node --test web/test/tool-summary.test.mjs
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

// Like slash.test.mjs: compile the real source with the local tsc and import it.
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-tool-summary-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "tool-summary.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { toolSummary, buildDiff } = await import(pathToFileURL(path.join(out, "tool-summary.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

// Same placeholder substitution as `fmt` in src/lib/i18n.ts: English is the key.
const t = (k, p) => (p ? k.replace(/\{(\w+)\}/g, (m, x) => (x in p ? String(p[x]) : m)) : k);
const bash = (command, resultIsError = false) => ({ name: "Bash", count: 1, input: { command }, resultIsError, done: true });

test("Two commands, one failed: the counter appears in parentheses", () => {
  const s = toolSummary([bash("echo a"), bash("exit 1", true)], t);
  assert.equal(s.error, 1);
  assert.ok(s.text.includes("(1 failed)"), s.text);
  assert.equal(s.text, "Ran 2 commands (1 failed)");
});

// Counter-test: with the counter inside the key "Ran {n} commands ({k} failed)" and no
// `base`/`counter`/`postscript`, the view could not color the counter without cutting the sentence.
test("The sentence splits into base, counter and postscript, and the counter sits in the middle, as on iOS", () => {
  const s = toolSummary([
    bash("echo a"), bash("exit 1", true),
    { name: "Write", input: { file_path: "/x", content: "one" }, done: true },
  ], t);
  assert.equal(s.base, "Ran 3 commands");
  assert.equal(s.counter, "(1 failed)");
  assert.equal(s.postscript, ", created one file");
  assert.equal(s.text, "Ran 3 commands (1 failed), created one file");
  assert.equal(s.text, `${s.base} ${s.counter}${s.postscript}`);
  // Without failures and without files the parts are empty and the sentence is the base.
  const o = toolSummary([bash("a"), bash("b")], t);
  assert.equal(o.counter, "");
  assert.equal(o.postscript, "");
  assert.equal(o.text, o.base);
});

test("A single failed command gets no counter: the row carries the word for the failure", () => {
  const s = toolSummary([bash("exit 1", true)], t);
  assert.equal(s.error, 1);
  assert.equal(s.text, "Ran 1 command");
  assert.equal(s.counter, "");
});

test("Three commands without failure stay word-for-word equal to iOS", () => {
  const s = toolSummary([bash("a"), bash("b"), bash("c")], t);
  assert.equal(s.error, 0);
  assert.equal(s.text, "Ran 3 commands");
  assert.equal(s.files, false);
});

test("Files and the line balance come from the diff of the write tools", () => {
  const s = toolSummary([
    bash("ls"),
    { name: "Write", input: { file_path: "/x", content: "one\ntwo" }, done: true },
    { name: "Edit", input: { file_path: "/y", old_string: "old", new_string: "fresh" }, done: true },
  ], t);
  assert.equal(s.text, "Ran 3 commands, created one file, edited one file");
  assert.equal(s.files, true);
  assert.equal(s.added, 3);
  assert.equal(s.removed, 1);
});

test("buildDiff knows only the write tools", () => {
  assert.equal(buildDiff("Bash", { command: "ls" }), null);
  assert.deepEqual(buildDiff("Edit", { old_string: "a", new_string: "b" }), [{ sign: "-", text: "a" }, { sign: "+", text: "b" }]);
});
