// First-time setup needs the setup token (setup-token.js) — against the REAL gateway (gateway-harness.mjs) and as pure functions.
//   (1) a fresh gateway reports setup + setupToken (and the version of its package.json), stores the token with mode 0600 and prints it in its log
//   (2) without the token, or with a wrong one: 403 SETUP_TOKEN and NO user — the stranger who comes first gets nothing
//   (3) with the token: 201, the admin exists, the token file is gone, a second setup is refused
//   (4) GW_SETUP_TOKEN wins over the file, and its value is not written to the log
// COUNTER-TEST: POST /gw/setup without the setupTokenMatches check => (2) red (201 for a stranger).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareSetup } from "./gateway-harness.mjs";
import { ensureSetupToken, setupTokenMatches, tokenFile } from "./setup-token.js";

const post = (gw, body) => fetch(`${gw.base}/gw/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test("(1)-(3) the first admin needs the token from the log or <data>/setup-token; nobody else gets in", async () => {
  const gw = await prepareSetup();
  try {
    await gw.start();
    const info = await fetch(`${gw.base}/gw/info`).then((r) => r.json());
    assert.equal(info.setup, true);
    // The product version comes from the package.json next to index.js (tools/version.mjs keeps it in step with the tree).
    assert.equal(info.version, JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version);
    assert.equal(info.setupToken, true, "the setup form must know it has to ask for the token");
    const file = tokenFile(gw.data);
    const token = fs.readFileSync(file, "utf8").trim();
    assert.ok(token.length >= 20, "a real random token");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "only the operator can read it");
    assert.ok(gw.log().includes(token), "the operator finds the token in the gateway log");

    for (const body of [{ username: "eve", password: "pw-eve-123456" }, { username: "eve", password: "pw-eve-123456", setupToken: "wrong" }, { username: "eve", password: "pw-eve-123456", setupToken: "" }]) {
      const r = await post(gw, body);
      assert.equal(r.status, 403, `a setup without the right token went through: ${JSON.stringify(body)}`);
      assert.equal(r.body.code, "SETUP_TOKEN");
    }
    assert.equal((await fetch(`${gw.base}/gw/info`).then((r) => r.json())).setup, true, "a refused setup must not create a user");

    const ok = await post(gw, { username: "admin", password: "pw-admin-123456", setupToken: ` ${token}\n` });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.user.role, "admin");
    assert.equal(fs.existsSync(file), false, "the token file is removed once the admin exists");
    const again = await post(gw, { username: "x", password: "pw-x-placeholder", setupToken: token });
    assert.equal(again.status, 403);
    assert.equal(again.body.error, "already set up");
    const after = await fetch(`${gw.base}/gw/info`).then((r) => r.json());
    assert.deepEqual([after.setup, after.setupToken], [false, false]);
  } finally { await gw.end(); }
});

test("(4) GW_SETUP_TOKEN wins over the file and stays out of the log", async () => {
  const gw = await prepareSetup({ env: { GW_SETUP_TOKEN: "operator-chosen-token-1234" } });
  try {
    await gw.start();
    assert.equal(fs.existsSync(tokenFile(gw.data)), false, "with GW_SETUP_TOKEN no file is written");
    assert.ok(gw.log().includes("GW_SETUP_TOKEN"), "the log says where the token comes from");
    assert.ok(!gw.log().includes("operator-chosen-token-1234"), "the operator's own token stays out of the log");
    assert.equal((await post(gw, { username: "admin", password: "pw-admin-123456", setupToken: "other" })).status, 403);
    assert.equal((await post(gw, { username: "admin", password: "pw-admin-123456", setupToken: "operator-chosen-token-1234" })).status, 201);
  } finally { await gw.end(); }
});

test("pure: ensureSetupToken keeps a stored token, setupTokenMatches never matches empty input", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-setup-token-"));
  try {
    const a = ensureSetupToken(dir, {});
    const b = ensureSetupToken(dir, {});
    assert.equal(a.token, b.token, "a restart before the setup keeps the token the operator already copied");
    assert.equal(ensureSetupToken(dir, { GW_SETUP_TOKEN: "env-token" }).token, "env-token");
    assert.equal(setupTokenMatches(a.token, a.token), true);
    for (const given of [undefined, null, "", "x", 42]) assert.equal(setupTokenMatches(a.token, given), false, String(given));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
