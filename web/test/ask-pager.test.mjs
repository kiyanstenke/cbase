// The pager of the follow-up question card (src/lib/askPager.ts): the page index clamps, open
// questions are counted across ALL pages, the card is complete only when every question carries
// a choice or a text — and a single question gets no pager. No browser: this is the contract
// between index, answer state and send lock, which can go wrong without a type error.
//
// This file is the ONLY guard in the gate: `./check` runs `web/test/*.mjs`, no browser.
// The view itself is checked by hand in a real browser.
//
// Counter-test: an index without clamping (3 of 3 questions => undefined instead of the last
// page), a counter that treats whitespace in free text as an answer, and a pager that shows
// up for a single question each turn the matching test red.
//
// Run:  node --test web/test/ask-pager.test.mjs
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

// The source is compiled to JS with the local tsc and imported — the real module text is
// tested, not a replica (model: slash.test.mjs).
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-ask-pager-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "askPager.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { clampIndex, isAnswered, openQuestions, isComplete, showPager } =
  await import(pathToFileURL(path.join(out, "askPager.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

test("The page index clamps to 0…m-1 — never out of range, never NaN", () => {
  assert.equal(clampIndex(0, 3), 0);
  assert.equal(clampIndex(2, 3), 2);
  assert.equal(clampIndex(3, 3), 2, "past the last page stays on the last");
  assert.equal(clampIndex(-1, 3), 0, "before the first page stays on the first");
  assert.equal(clampIndex(1.7, 3), 1, "a fraction is truncated, not rounded");
  // Inputs nobody expected: no questions, not a number.
  assert.equal(clampIndex(5, 0), 0);
  assert.equal(clampIndex(NaN, 3), 0);
  assert.equal(clampIndex(2, NaN), 0);
});

test("A question is answered by choice OR text — whitespace is no text", () => {
  assert.equal(isAnswered(["A"], ""), true);
  assert.equal(isAnswered([], "own answer"), true);
  assert.equal(isAnswered([], ""), false);
  assert.equal(isAnswered([], "   "), false, "a space in the field unlocks nothing");
  assert.equal(isAnswered(undefined, undefined), false, "no entry means open");
});

test("Open questions are counted across all pages", () => {
  const empty = [[], [], []];
  assert.equal(openQuestions(empty, ["", "", ""]), 3);
  assert.equal(openQuestions([["A"], [], []], ["", "", ""]), 2);
  assert.equal(openQuestions([["A"], [], []], ["", "", "Text"]), 1, "text on the last page counts");
  assert.equal(openQuestions([["A"], ["B", "C"], []], ["", "", "Text"]), 0);
  // More questions than entries: the missing ones are open, not answered.
  assert.equal(openQuestions([["A"]], [""], 3), 2);
});

test("The card is complete only when EVERY question carries something", () => {
  assert.equal(isComplete([["A"], ["B"], ["C"]], ["", "", ""]), true);
  assert.equal(isComplete([["A"], [], []], ["", "x", "y"]), true);
  assert.equal(isComplete([["A"], ["B"], []], ["", "", ""]), false);
  assert.equal(isComplete([["A"], ["B"], []], ["", "", "  "]), false, "whitespace does not make it complete");
  assert.equal(isComplete([], []), false, "without questions there is nothing to send");
  assert.equal(isComplete([["A"]], [""], 2), false, "the second question has no entry — open");
});

test("The pager shows only live and only for more than one question", () => {
  const one = [{ question: "?" }];
  const three = [{ question: "a" }, { question: "b" }, { question: "c" }];
  assert.equal(showPager(one, true), false, "a single question stays as it was");
  assert.equal(showPager(three, true), true);
  assert.equal(showPager(three, false), false, "answered or skipped: all questions stacked");
  assert.equal(showPager([], true), false);
});
