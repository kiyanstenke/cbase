// The second secret scanner (tools/check/secrets.mjs, gitleaks) — its counter-proof.
//
// COUNTER-PROOF (built in, runs every time): a throwaway tree with the repo's own `.gitleaks.toml` — a GitHub token and a private
// key block, made at run time (so this file carries neither), must be found, the token also inside a test file (the allowlist
// goes by value, never by path); an allowlisted placeholder must not be found; the same tree without the plants is clean. A
// missing gitleaks is reported as missing, never as a clean tree.
//
// The public tree itself is scanned by the gate step "Secrets (gitleaks)" (tools/check/targets/check.mjs), not here — once is enough.
//
// Run:  node --test --test-reporter=tap tools/check/secrets.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSecrets, gitleaksVersion } from "./secrets.mjs";
import { REPO } from "./cleanliness.mjs";

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const random62 = (n) => [...crypto.randomBytes(n)].map((b) => B62[b % 62]).join("");
const githubToken = () => "gh" + "p_" + random62(36);
const privateKeyBlock = () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  return privateKey.export({ type: "pkcs1", format: "pem" });
};

function withTree(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-test-"));
  try {
    fs.copyFileSync(path.join(REPO, ".gitleaks.toml"), path.join(root, ".gitleaks.toml"));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    return fn(root, Object.keys(files));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const CLEAN = { "src/a.js": "export const greeting = \"hello\";\n", "README.md": "# sample\n" };

test("gitleaks is installed here — the gate step would be red without it", () => {
  assert.ok(gitleaksVersion(), "gitleaks is not installed: brew install gitleaks (or a release binary on Linux), see CONTRIBUTING");
});

test("counter-proof: a planted token and a private key are found, also in a test file; the clean tree has nothing", () => {
  withTree(CLEAN, (root, files) => assert.deepEqual(scanSecrets({ root, files }).findings, [], "the clean tree must have no finding"));
  const planted = {
    ...CLEAN,
    "src/config.js": `export const token = "${githubToken()}";\n`,
    "server/backend/test/sample.test.js": `const KEY = "${githubToken()}";\n`,
    "deploy/key.pem": privateKeyBlock(),
  };
  withTree(planted, (root, files) => {
    const r = scanSecrets({ root, files });
    const got = r.findings.map((f) => `${f.rule} ${f.file}`).sort();
    assert.deepEqual(got, ["github-pat server/backend/test/sample.test.js", "github-pat src/config.js", "private-key deploy/key.pem"]);
    assert.ok(r.findings.every((f) => Number.isInteger(f.line) && f.line >= 1), "every finding names its line");
  });
});

test("an allowlisted placeholder is not reported — and the allowlist goes by exact value", () => {
  withTree({ ...CLEAN, "server/backend/test/x.test.js": 'const POSTGRES_PASSWORD = "pw-secret-0815";\nconst SECRET = "SECRET-S1-29-7f3a";\n' },
    (root, files) => assert.deepEqual(scanSecrets({ root, files }).findings, []));
  // One character more and the value is no longer the listed one: found again.
  // (Built at run time: written whole, this file would be a finding of the gate step itself.)
  withTree({ ...CLEAN, "server/backend/test/x.test.js": `const SECRET = "${"SECRET-S1-29-7f3a" + "b"}";\n` },
    (root, files) => assert.equal(scanSecrets({ root, files }).findings.length, 1));
});

test("a missing gitleaks is reported as missing, not as a clean tree", () => {
  withTree(CLEAN, (root, files) => assert.deepEqual(scanSecrets({ root, files, env: { ...process.env, PATH: "/nonexistent" } }), { missing: true }));
});

test("the gate runs the scan in every mode — before the --quick exit, so the pre-push hook has it too", () => {
  const check = fs.readFileSync(path.join(REPO, "tools/check/targets/check.mjs"), "utf8");
  const call = check.indexOf("scanSecrets({ root: REPO, files: publicFiles(REPO) })");
  const quickExit = check.indexOf("if (quick) {");
  assert.ok(call > 0, "tools/check/targets/check.mjs no longer calls scanSecrets over the public files");
  assert.ok(quickExit > call, "the scan must stand before the --quick exit (the pre-push hook runs --quick)");
  const missingBranch = /if \(sec\.missing\) \{([\s\S]*?)\} else \{/.exec(check.slice(call, quickExit));
  assert.ok(missingBranch && /failures\.push\(/.test(missingBranch[1]), "a missing gitleaks must be a failure, not a note");
});
