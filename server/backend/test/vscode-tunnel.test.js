import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// VS Code Remote Tunnels (electron/server/vscode-tunnel.js) against the replica CLI (fixtures/fake-code-cli.mjs): login
// step with device code, tunnel with link, stop, restart after a crash, restart at server start, logout — and the
// counter-case that without CBASE_VSCODE_TUNNEL=1 none of it exists. The real login cannot be automated
// (Microsoft/GitHub device code); the real CLI was measured in the container (device-code line, `user show` -> "not
// logged in"/exit 1, `unregister` without login -> 0).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fixtures", "fake-code-cli.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-vstunnel-"));
const cliDir = path.join(root, "cli-data");
process.env.CBASE_VSCODE_TUNNEL = "1";
process.env.CBASE_CODE_CLI = FAKE;
process.env.CBASE_VSCODE_DIR = cliDir;
process.env.CBASE_VSCODE_BACKOFF_MS = "150";
fs.chmodSync(FAKE, 0o755);

const { startServer } = await import("../electron/server/server.js");
const vt = await import("../electron/server/vscode-tunnel.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// No deadline (no clock a test turns red at; the emergency brake is the suite) — `what` goes to stderr every 30 s.
async function waitFor(fn, what) {
  const start = Date.now();
  let reported = 0;
  for (;;) {
    const last = await fn();
    if (last) return last;
    const sec = Math.floor((Date.now() - start) / 30_000);
    if (sec > reported) { reported = sec; console.error(`[waiting] for ${sec * 30} s: ${what}`); }
    await sleep(50);
  }
}
const f = (n) => path.join(cliDir, n);

test("VS Code Remote Tunnel: login with device code, link, stop, crash, restart, logout", async () => {
  let server;
  const dataRoot = path.join(root, "data");
  const start = async () => { server = await startServer({ port: 0, dataRoot, webDir: path.join(root, "web"), pickDirectory: null, notify: null }); return `http://127.0.0.1:${server.address().port}`; };
  const stop = async () => { if (server) await new Promise((r) => server.close(r)); server = null; };
  try {
    let base = await start();
    const status = async () => (await fetch(`${base}/api/vscode-tunnel`)).json();
    const post = (way, body) => fetch(`${base}/api/vscode-tunnel/${way}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

    // Starting point: available, off, not logged in, version read.
    let st = await status();
    assert.equal(st.available, true);
    assert.equal(st.phase, "off");
    assert.equal(st.account, "");
    assert.equal(st.version, "code 1.137.0");
    assert.ok(Array.isArray(st.workspaces));

    // Invalid name: 400, nothing started.
    const r400 = await post("start", { name: "Bad Name" });
    assert.equal(r400.status, 400);
    assert.equal(vt._intern.proc, null);

    // The VS Code Server is under Microsoft's licence: without the user's acceptance nothing starts — 409 LICENSE, no CLI process,
    // nothing stored as accepted. COUNTER-TEST: startTunnel without the licence check => red here.
    assert.equal(st.licenseAccepted, false);
    assert.match(st.licenseUrl, /^https:\/\/aka\.ms\/vscode-server-license$/);
    const rNoLicense = await post("start", { name: "cbase-Test", provider: "microsoft" });
    assert.equal(rNoLicense.status, 409);
    assert.equal((await rNoLicense.json()).code, "LICENSE");
    assert.equal(vt._intern.proc, null, "no tunnel process without the accepted licence");
    assert.equal((await status()).licenseAccepted, false, "a refused start stores no acceptance");

    // Start with a Microsoft account: first the login step with device code (Microsoft URL, because the provider is passed
    // EXPLICITLY — the tunnel command itself would take GitHub). The acceptance travels with this first start and is stored.
    const rStart = await post("start", { name: "cbase-Test", provider: "microsoft", acceptLicense: true });
    assert.equal(rStart.status, 200);
    // Every response has the same shape as GET — without `workspaces` the pill would tear down the whole page at the first
    // click on start ("r.workspaces is not iterable").
    assert.ok(Array.isArray((await rStart.json()).workspaces), "start answers with workspaces");
    st = await waitFor(async () => { const s = await status(); return s.phase === "login" && s.loginCode ? s : null; }, "login phase with device code");
    assert.equal(st.name, "cbase-test", "the name is lowercased");
    assert.equal(st.loginCode, "AB12-CD34");
    assert.match(st.loginUrl, /microsoft\.com\/devicelogin/);
    assert.equal(st.active, true);

    // The human enters the code -> tunnel starts -> link.
    fs.writeFileSync(f("login-ok"), "");
    st = await waitFor(async () => { const s = await status(); return s.phase === "connected" ? s : null; }, "connected with link");
    assert.equal(st.link, "https://vscode.dev/tunnel/cbase-test/home/tester");
    assert.match(st.account, /logged in as tester \(microsoft\)/);
    assert.equal(st.loginCode, "", "the device code is gone after login");
    // At the first client the CLI writes a warn line with "error handling call" — not an error.
    await waitFor(async () => (await status()).rows.some((z) => /NoAttachedServerError/.test(z)), "warn row read");
    assert.equal((await status()).error, "", "a warn row of the CLI is not an error");

    // Crash of the tunnel: comes back by itself (backoff 150 ms), counter stands at 1.
    fs.writeFileSync(f("crash-once"), "");
    await waitFor(() => vt._intern.restarts === 1, "restart counted");
    st = await waitFor(async () => { const s = await status(); return s.phase === "connected" && s.link ? s : null; }, "connected again after the crash");
    assert.ok(st.rows.some((z) => /restart 1\/5/.test(z)), "the details name the restart");

    // Stop: process gone, setting off.
    const rStop = await post("stop");
    assert.equal(rStop.status, 200);
    assert.ok(Array.isArray((await rStop.json()).workspaces), "stop answers with workspaces");
    st = await status();
    assert.equal(st.phase, "off");
    assert.equal(st.active, false);
    assert.equal(vt._intern.proc, null);

    // On again (without parameters: name and provider from the setting, account is there -> no login).
    assert.equal((await post("start")).status, 200);
    st = await waitFor(async () => { const s = await status(); return s.phase === "connected" ? s : null; }, "second start without login step");
    assert.equal(st.name, "cbase-test");
    assert.equal(st.loginCode, "");

    // Server restart IN A NEW CONTAINER (different hostname): the tunnel starts again because `active` is set — WITHOUT a
    // login step. The real CLI encrypts the token with the hostname; without VSCODE_CLI_DISABLE_KEYCHAIN_ENCRYPT it would
    // stay at "login" here (a deploy with a running tunnel cost a new login).
    await stop();
    assert.equal(vt._intern.proc, null, "server.close ends the tunnel");
    process.env.FAKE_CODE_HOSTNAME = "container-b";
    base = await start();
    st = await waitFor(async () => { const s = await status(); return s.phase === "connected" || s.phase === "login" ? s : null; }, "restart after server start");
    assert.equal(st.phase, "connected", "no new login after the container swap");
    assert.equal(st.active, true);
    assert.match(st.account, /logged in as tester/);

    // Logout: tunnel off, registration and account gone.
    assert.equal((await post("logout")).status, 200);
    st = await status();
    assert.equal(st.phase, "off");
    assert.equal(st.account, "");
    assert.ok(!fs.existsSync(f("account")) && !fs.existsSync(f("registered")), "account and registration are deleted");

    // Expired device code: error with message, no longer wanted — the next click starts over.
    assert.equal((await post("start", { provider: "github" })).status, 200);
    await waitFor(async () => (await status()).phase === "login", "login phase again");
    fs.writeFileSync(f("login-fail"), "");
    st = await waitFor(async () => { const s = await status(); return s.phase === "error" ? s : null; }, "error after expired code");
    assert.match(st.error, /authorization expired/);
    assert.equal(st.active, false);
    fs.rmSync(f("login-fail"));
  } finally {
    vt.stopTunnel(null);
    await stop();
  }
});

test("without CBASE_VSCODE_TUNNEL=1: not available, start is rejected with 409", async () => {
  const saved = process.env.CBASE_VSCODE_TUNNEL;
  process.env.CBASE_VSCODE_TUNNEL = "";
  let server;
  try {
    server = await startServer({ port: 0, dataRoot: path.join(root, "data2"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const st = await (await fetch(`${base}/api/vscode-tunnel`)).json();
    assert.equal(st.available, false);
    assert.equal(st.phase, "off");
    const r = await fetch(`${base}/api/vscode-tunnel/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 409);
  } finally {
    process.env.CBASE_VSCODE_TUNNEL = saved;
    if (server) await new Promise((r) => server.close(r));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});

// The autostart after a server start never accepts the licence on the user's behalf: a container that ran a tunnel before the licence
// question existed stays off until the user accepts in the pill. COUNTER-TEST: autostart without its licenseAccepted check => red.
test("autostart without an accepted licence starts nothing and stores nothing", async () => {
  const written = [];
  const store = { getSetting: (k, d) => ({ "vscode_tunnel.active": "1" })[k] ?? d, setSetting: (k, v) => written.push([k, v]) };
  await vt.autostart(store);
  assert.equal(vt._intern.proc, null, "a tunnel started without the user's acceptance");
  assert.deepEqual(written, [], "the autostart wrote settings (an acceptance?) on the user's behalf");
});
