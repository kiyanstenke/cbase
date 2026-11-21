// Pull-to-refresh on iOS: SwiftUI cancels the task of `.refreshable` as soon as its work changes an observed property and the
// view redraws -- measured on the Git sheet (`loading = true` => cancellation after ~10-40 ms, `CancellationError` shown as the
// message; the counter-measurement without a state change was never cancelled; the full measurement is in the header of
// mobile/CbaseMobile/Kit/CbRefresh.swift). The one way out: `cbRefreshable` runs the work in its own unstructured task and
// waits for it. This guard holds that
//   1. no bare `refreshable` is left in app code (except in the wrapper itself) -- comments and strings do not count;
//   2. the wrapper really decouples (`Task { ... }.value`) instead of just passing the work through.
// On the device GitUITests/testPullDownInGitSheetShowsTheAbortNotAsError holds it (red on the old state).
//
// COUNTER-TESTS, built in (run every time): a version of Code/GitPane.swift with `.refreshable {` instead of `.cbRefreshable {`
// is red; the same line only in a comment or a string stays green; a wrapper that passes `refreshable { await work() }`
// through is red.
//
// Reads source only -- also runs on Linux.
// Run:  node --test web/test/refresh-ios.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "mobile", "CbaseMobile");
const WRAPPER = "Kit/CbRefresh.swift";

function swiftFiles(dir, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...swiftFiles(dir, r));
    else if (e.name.endsWith(".swift")) out.push(r);
  }
  return out.sort();
}

// Code only: comments (`//`, nested `/* */`) and strings (`"..."`, `"""..."""`, with `\(...)` interpolations) become
// spaces; line breaks stay so the line numbers are right.
export function onlyCode(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  const empty = (s) => s.replace(/[^\n]/g, " ");
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      const end = text.indexOf("\n", i);
      const until = end < 0 ? n : end;
      out += empty(text.slice(i, until));
      i = until;
    } else if (c === "/" && d === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") { depth++; j += 2; }
        else if (text[j] === "*" && text[j + 1] === "/") { depth--; j += 2; }
        else j++;
      }
      out += empty(text.slice(i, j));
      i = j;
    } else if (c === '"') {
      const three = text.startsWith('"""', i);
      const to = three ? '"""' : '"';
      let j = i + to.length;
      while (j < n) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text.startsWith(to, j)) { j += to.length; break; }
        if (!three && text[j] === "\n") break;
        j++;
      }
      out += empty(text.slice(i, j));
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Every place with `refreshable` in code (file:line), except in the wrapper.
export function barePlaces(files) {
  const hits = [];
  for (const [rel, text] of files) {
    if (rel === WRAPPER) continue;
    const rows = onlyCode(text).split("\n");
    rows.forEach((z, k) => { if (/\brefreshable\b/.test(z)) hits.push(`${rel}:${k + 1}`); });
  }
  return hits;
}

// The wrapper decouples: the body of `cbRefreshable` contains `refreshable { await Task { ... }.value }`.
export function wrapperDecoupled(text) {
  const code = onlyCode(text);
  const start = code.indexOf("func cbRefreshable");
  if (start < 0) return false;
  const body = code.slice(start);
  return /refreshable\s*\{\s*await\s+Task\s*\{[^}]*\}\s*\.value\s*\}/.test(body);
}

const files = new Map(swiftFiles(appDir).map((rel) => [rel, fs.readFileSync(path.join(appDir, rel), "utf8")]));

test("no bare .refreshable in app code (every pull-down goes through cbRefreshable)", () => {
  assert.ok(files.size > 100, `too few Swift files found (${files.size}) -- is the app folder still under ${appDir}?`);
  assert.ok(files.has(WRAPPER), `${WRAPPER} is missing`);
  const hits = barePlaces(files);
  assert.deepEqual(hits, [], `bare refreshable -- SwiftUI cancels its task at the first state change; use .cbRefreshable:\n  ${hits.join("\n  ")}`);
  const user = [...files].filter(([rel, t]) => rel !== WRAPPER && /\.cbRefreshable\s*\{/.test(onlyCode(t))).length;
  assert.ok(user >= 1, "no place uses cbRefreshable -- the guard checks nothing");
  console.log(`# pull-down: ${user} files through cbRefreshable, 0 bare refreshable`);
});

test("the wrapper decouples the work from the pull-down task", () => {
  assert.ok(wrapperDecoupled(files.get(WRAPPER)), `${WRAPPER}: cbRefreshable must be \`refreshable { await Task { ... }.value }\``);
});

test("counter-tests: bare refreshable red, in comment/string green, pass-through wrapper red", () => {
  const git = "Code/GitPane.swift";
  const old = files.get(git);
  assert.ok(old && /\.cbRefreshable \{/.test(old), `${git} no longer uses cbRefreshable -- the counter-test needs a new template`);
  const sabotaged = new Map(files);
  sabotaged.set(git, old.replace(".cbRefreshable {", ".refreshable {"));
  assert.equal(barePlaces(sabotaged).length, 1, "a bare .refreshable in GitPane.swift was not found");

  const onlyComment = new Map(files);
  onlyComment.set(git, old + '\n// .refreshable { await load() }\n/* .refreshable { /* nested */ } */\nlet s = ".refreshable { }"\nlet m = """\n.refreshable {\n"""\n');
  assert.deepEqual(barePlaces(onlyComment), [], "a comment or string was counted as code");

  const wrapper = files.get(WRAPPER);
  const passedThrough = wrapper.replace(/refreshable\s*\{\s*await\s+Task\s*\{[^}]*\}\s*\.value\s*\}/, "refreshable { await work() }");
  assert.notEqual(passedThrough, wrapper, "the wrapper counter-test did not bite");
  assert.equal(wrapperDecoupled(passedThrough), false, "a pass-through wrapper counts as decoupled");
});
