// The reference guard in the gate (tools/check/references.mjs carries the promise).
//
// COUNTER-TEST (built in, runs every time): a temp tree with a private path, a missing file in a comment, a missing test name and a
// missing measurement script must report each kind; the same references to files that exist pass; a placeholder path and a missing
// path inside a plain string (test data) pass; an allowlisted line passes exactly its line.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scan, loadAllow, ALLOW_FILE } from "./references.mjs";

test("no public file points at a private path or at a file a public clone does not have", (t) => {
  const r = scan();
  t.diagnostic(`[references] ${r.findings.length} findings, ${r.allowed} allowlisted`);
  assert.deepEqual(r.findings.map((f) => `${f.file}:${f.line} ${f.kind} ${f.ref}`), [], "fix the reference or allowlist it with a reason (list: node tools/check/references.mjs --list)");
});

test("the allowlist is well-formed; every entry has a reason", () => {
  JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8"));
  loadAllow();
});

test("counter-test: each kind is reported, existing references, placeholders and test data pass, an allow entry passes one line", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-refs-"));
  try {
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
    put("server/a.js", [
      "// see secret/notes.md for the history",              // 1 private
      "// Guard: server/missing.test.js and server/b.js",    // 2 missing-file (missing.test.js counted once) — b.js exists
      "// test name gone.test.mjs",                          // 3 missing-test
      "// measurement script k1-probe.mjs",                  // 4 missing-script
      "// Guard: server/b.js and here.test.mjs",             // 5 fine
      "// pattern server/*.js and server/<x>.js",            // 6 placeholders
      'const fake = "web/not-here.ts";',                     // 7 test data in a string: not checked
      "// allowed secret/x",                                 // 8 allowlisted
    ].join("\n"));
    put("server/b.js", "\n");
    put("server/here.test.mjs", "\n");
    const files = ["server/a.js", "server/b.js", "server/here.test.mjs"];
    const allow = { files: [], lines: [{ fileRe: /^server\/a\.js$/, re: /allowed secret/ }] };
    const got = scan({ root, files, privatePaths: ["secret/"], allow }).findings.map((f) => `${f.line}:${f.kind}:${f.ref}`);
    assert.deepEqual(got, ["1:private:secret/", "2:missing-file:server/missing.test.js", "3:missing-test:gone.test.mjs", "4:missing-script:k1-probe.mjs"]);
    const none = { files: [], lines: [] };
    assert.equal(scan({ root, files, privatePaths: ["secret/"], allow: none }).findings.length, 5, "without the allow entry line 8 counts");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
