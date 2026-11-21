// Precondition of writing: `GET …/files/read` reports `sha`, `PUT …/files/write { base }` writes only onto that state (server files.js,
// devtools/code-route.js; the editor side: web/src/lib/file-status.ts). An open editor is minutes old; if an agent wrote the file in
// the meantime, ⌘S used to overwrite its work silently. The promises, each with the sabotage that breaks it:
//   (a) Reading reports `sha` = sha256 of the delivered text (UTF-8, CRLF and umlauts as delivered); binary/too large: no `sha`.
//   (b) Writing WITH a matching `base` writes and reports the new `sha`; WITHOUT `base` it writes as before (iOS, older clients).
//   (c) If the file changed since reading => 409 `CHANGED` with the `current` sha; the file stays byte-exact as the agent wrote it.
//   (d) If it was deleted meanwhile => 409 `CHANGED`, `missing: true`; it is NOT recreated.
//   (e) If it is no longer text (binary) => 409 (`current: null`).
//   (f) A `base` that is not a sha256 => 400, nothing written (a client typo is no permission).
//   (g) The same check at workspace level (codeRoute has two callers). The copy: files-in-copy.test.js (2).
//
// COUNTER-TESTS (each shown red once):
//   devtools/code-route.js without the precondition (no sha, no 409)                  => (a)(b)(c)(d)(e)(f)(g) red
//   files.js `baseDeviation` always returns null (the check is missing)               => (c)(d)(e)(g) red
//   files.js `readingOrMissing` without the ENOENT case (missing => throw)            => (d) red (400 instead of 409 missing)
//
// Run alone: CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/files-base.test.js

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { json, makeProject, makeWorkspace, withServer } from "./server-harness.mjs";

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const read = (base, route, rel) => json(`${base}${route}/files/read?path=${encodeURIComponent(rel)}`);
const write = (base, route, body) => json(`${base}${route}/files/write`, { method: "PUT", body: JSON.stringify(body) });

async function checkLevel(base, route, root, prefix = "") {
  const rel = `${prefix}till/prices.ts`;
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const first = "export const preis = 1;\r\n// Ärger mit Umlauten\r\n";
  fs.writeFileSync(abs, first);

  // (a) Reading reports the sha of the delivered text.
  const r = await read(base, route, rel);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.content, first);
  assert.equal(r.body.sha, sha(first), "(a) sha = sha256 of the delivered text (CRLF and umlauts as delivered)");
  fs.writeFileSync(path.join(root, `${prefix}image.bin`), Buffer.from([0, 1, 2, 3]));
  const bin = await read(base, route, `${prefix}image.bin`);
  assert.deepEqual([bin.status, bin.body.binary, "sha" in bin.body], [200, true, false], "(a) binary: no sha");

  // (b) matching base: written, the new sha in the response.
  const two = "export const price = 2;\r\n";
  let w = await write(base, route, { path: rel, content: two, base: r.body.sha });
  assert.equal(w.status, 200, `(b) ${JSON.stringify(w.body)}`);
  assert.equal(fs.readFileSync(abs, "utf8"), two);
  assert.equal(w.body.sha, sha(two), "(b) the response names the sha of what was written");

  // (c) an agent writes in between => 409, its file stays.
  const agent = "export const price = 3; // by the agent\n";
  fs.writeFileSync(abs, agent);
  w = await write(base, route, { path: rel, content: "my old state\n", base: sha(two) });
  assert.equal(w.status, 409, `(c) ${JSON.stringify(w.body)}`);
  assert.equal(w.body.code, "CHANGED");
  assert.equal(w.body.current, sha(agent), "(c) current = sha of what is there now");
  assert.equal(fs.readFileSync(abs, "utf8"), agent, "(c) the agent's file is untouched");

  // (b) without base: overwritten deliberately, as before.
  w = await write(base, route, { path: rel, content: "deliberate\n" });
  assert.equal(w.status, 200, `(b) without base ${JSON.stringify(w.body)}`);
  assert.equal(fs.readFileSync(abs, "utf8"), "deliberate\n");

  // (d) deleted => 409 missing, not recreated.
  fs.rmSync(abs);
  w = await write(base, route, { path: rel, content: "back again?\n", base: sha("deliberate\n") });
  assert.deepEqual([w.status, w.body?.code, w.body?.missing, w.body?.current], [409, "CHANGED", true, null], `(d) ${JSON.stringify(w.body)}`);
  assert.equal(fs.existsSync(abs), false, "(d) the deleted file was not recreated");

  // (e) no longer text => 409 with current null.
  fs.writeFileSync(abs, Buffer.from([0, 0, 1]));
  w = await write(base, route, { path: rel, content: "text\n", base: sha("deliberate\n") });
  assert.deepEqual([w.status, w.body?.code, w.body?.current, w.body?.missing], [409, "CHANGED", null, undefined], `(e) ${JSON.stringify(w.body)}`);
  assert.deepEqual([...fs.readFileSync(abs)], [0, 0, 1], "(e) the binary file is untouched");

  // (f) base is not a sha256 => 400, nothing written.
  for (const baseValue of ["abc", 42, sha("x").toUpperCase(), ""]) {
    w = await write(base, route, { path: rel, content: "typo\n", base: baseValue });
    assert.equal(w.status, 400, `(f) base ${JSON.stringify(baseValue)}: ${JSON.stringify(w.body)}`);
  }
  assert.deepEqual([...fs.readFileSync(abs)], [0, 0, 1], "(f) nothing written");
}

test("(a)–(f) project level: reading reports sha, writing with base holds or answers 409 CHANGED, never overwrites silently", async () => {
  await withServer(async ({ base, wsPath, projPath }) => {
    const ws = await makeWorkspace(base, "Base", wsPath);
    const proj = await makeProject(base, ws.id, projPath, "Till");
    await checkLevel(base, `/api/projects/${proj.id}`, projPath);
  });
});

test("(g) workspace level: same precondition (codeRoute, second caller)", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Base", wsPath);
    await checkLevel(base, `/api/workspaces/${ws.id}`, wsPath, "level/");
  });
});
