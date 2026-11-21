// The address of a clone in the web (src/lib/project-clone.ts `checkClone`) against the fixture set that iOS
// (`clone-ios-binding.test.mjs`) and the server (`server/backend/test/clone-check.test.js`) run as well.
//
// Why in the gate: if the client deviates from the server, the error shows up only after "Create" (400, the source has to be created
// again), or the credential is looked up and stored under a different host than the server looks for it (NO_ACCESS despite access).
//
// Counter-test: the built-in sabotage swaps two expectations and requires the comparison to fail. Run against the code (then
// reverted): without the IPv4 rule ⇒ "0x7f.1", "127.1", "010.1.2.3", "1.2.3.256" red; with `new URL(raw).hostname` instead of the raw
// text ⇒ "0x7f.1", "127.1" and "010.1.2.3" red (WHATWG rewrites them to 127.0.0.1 or 8.1.2.3); without resolving "." and ".." ⇒
// "…/repo/." and "…/repo/x/.." red.
//
// Run:  node --test web/test/project-clone-check.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const FIX = path.join(repo, "server", "backend", "test", "fixtures", "clone-check", "cases.json");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-clone-check-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "project-clone.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { checkClone } = await import(pathToFileURL(path.join(out, "project-clone.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ }

const { cases } = JSON.parse(fs.readFileSync(FIX, "utf8"));

/** The result in the form of the fixture: `{ host, name }` or `{ code }`. */
function form(r) { return r.ok ? { host: r.detail.host, name: r.detail.name } : { code: r.code }; }

function deviations(list) {
  const output = [];
  for (const f of list) {
    const holds = form(checkClone(f.url, f.branch));
    try { assert.deepStrictEqual(holds, f.client); } catch { output.push(`${JSON.stringify(f.url)} (${JSON.stringify(f.branch)}): expected ${JSON.stringify(f.client)}, actual ${JSON.stringify(holds)}`); }
  }
  return output;
}

test("the fixture set is not empty and carries both sides", () => {
  assert.ok(cases.length >= 40, `only ${cases.length} cases`);
  for (const f of cases) {
    assert.equal(typeof f.url, "string");
    assert.equal(typeof f.branch, "string");
    assert.ok(f.client && f.server, `${f.url}: client and server belong in every case`);
  }
});

test("checkClone yields the client expectation for every case", () => {
  const output = deviations(cases);
  assert.deepEqual(output, [], `web ≠ fixture:\n${output.join("\n")}`);
});

test("counter-test: two swapped expectations are noticed", () => {
  const i = cases.findIndex((f) => f.client.host);
  const j = cases.findIndex((f) => f.client.code === "HOST_UNCLEAR");
  assert.ok(i >= 0 && j >= 0);
  const sabotaged = cases.map((f, k) => (k === i ? { ...f, client: cases[j].client } : k === j ? { ...f, client: cases[i].client } : f));
  assert.equal(deviations(sabotaged).length, 2);
});

test("the looked-up host is the one PUT …/git/creds stores under: lower case, no port, never Unicode", () => {
  for (const f of cases.filter((x) => x.client.host)) {
    assert.match(f.client.host, /^[a-z0-9.-]+$/, f.url);
    assert.equal(f.client.host, f.server.host, `${f.url}: client and server look up the access under different hosts`);
  }
});
