// The gateway's outer shell against the REAL process (index.js as a child, gateway-harness.mjs): a request that ends the gateway,
// a foreign cookie with `%`, a reset during the upgrade handler, the login limit behind a local tunnel shared by all, deleting a user
// against their running requests, and the policy for unhandled rejections. The event stream's guards are in push.test.js and
// containers.test.js. The delivery token of the ingest path is GONE (with the managing teardown): the test "ingest is gone"
// below holds that /api/ingest/* without a session is 401 and wakes no B.
//
// Sabotage (this file against an index.js/users.js/containers.js without the outer-shell fixes): red: the unreadable URL (the
// gateway ends at `GET //`), the foreign cookie (500), the reset (exit 1 at the reset), the login limit (the maintainer from their
// address 429), both user-deletion tests (session valid in the middle of the deletion; `purged:true` despite a failed
// `volume rm`), the error policy (wiring). The pure-function tests at the end do not exist without outerShell.js.
//
// No clock: waits on the gateway's start line, on gates of the fake docker and on requests at the echo backend; every wait point
// aborts when the gateway ends (that is the red case) instead of hanging.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { prepareSetup } from "./gateway-harness.mjs";
// As a namespace: a missing export (addressKey, checkSlots, users.loginProbation) turns the single test red, not the whole file.
import * as outerShell from "./outerShell.js";
import * as users from "./users.js";

const { clientAddress, loginBrake, parseCookies, requestUrl } = outerShell;

const HERE = path.dirname(new URL(import.meta.url).pathname);

test("an unreadable request URL is a 400 — the gateway lives on (//, ///, /\\, //x:99999, absolute target with an impossible port, /%)", async () => {
  const gw = await prepareSetup();
  try {
    await gw.start();
    for (const target of ["//", "///", "/\\", "//x:99999", "http://a:99999/", "/%"]) {
      const response = await gw.raw(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      assert.match(response, /^HTTP\/1\.1 400 /, `${target}: "${response.slice(0, 60)}" — gateway alive: ${gw.alive()}\n${gw.log()}`);
      assert.equal((await fetch(`${gw.base}/gw/info`)).status, 200, `${target}: the gateway no longer answers`);
    }
    // The same throw in the upgrade path: the socket falls, the gateway does not.
    await gw.raw("GET // HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    assert.equal((await fetch(`${gw.base}/gw/info`)).status, 200);
    assert.equal(gw.alive(), true, gw.log());
  } finally { await gw.end(); }
});

test("a foreign cookie with `%` next to the session — /gw/me and /api/* keep working (used to be 500)", async () => {
  const gw = await prepareSetup();
  try {
    const u = gw.users.createUser({ username: "maintainer", password: "correct-123" });
    const sess = gw.users.createSession(u.id);
    await gw.start();
    const header = { cookie: `other_app=50%; legacy=%E9t%E9; cbase_gw=${sess}` };
    const me = await fetch(`${gw.base}/gw/me`, { headers: header });
    const text = await me.text();
    assert.equal(me.status, 200, text);
    assert.equal(JSON.parse(text).user.username, "maintainer");
    const api = await fetch(`${gw.base}/api/chats`, { headers: header });
    assert.equal(api.status, 200, "the proxy path with the same cookie line");
  } finally { await gw.end(); }
});

test("a client reset while the upgrade handler waits on ensureBackend does not end the gateway", async () => {
  const gw = await prepareSetup();
  try {
    const u = gw.users.createUser({ username: "maintainer", password: "correct-123" });
    const sess = gw.users.createSession(u.id);
    await gw.start();
    gw.marker("hangs-inspect"); // ensureBackend -> ensureRunning -> `docker inspect` waits at the gate
    const s = net.connect(gw.port, "127.0.0.1");
    s.on("error", () => {});
    await new Promise((r) => s.on("connect", r));
    s.write("GET /api/tunnel?port=5432 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n"
      + `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: cbase_gw=${sess}\r\n\r\n`);
    assert.equal(await gw.waitAtGate("inspect"), true, `the upgrade handler did not reach ensureBackend:\n${gw.log()}`);
    s.resetAndDestroy(); // RST — tab closed, dead zone, or on purpose
    gw.openGate("inspect");
    // Either the gateway carries on (ensureRunning checks health at the echo backend) — or it died at the reset.
    const what = await Promise.race([
      gw.echo.waitForTruthy((e) => e.url === "/api/health").then(() => "further"),
      gw.ended().then((e) => `ended ${JSON.stringify(e)}`),
    ]);
    assert.equal(what, "further", gw.log());
    assert.equal((await fetch(`${gw.base}/gw/info`)).status, 200);
    assert.equal(gw.alive(), true);
  } finally { await gw.end(); }
});

test("the login limit applies per real client address (CF-Connecting-IP from loopback) and counts only failures; a distributed guesser does not lock a proven address", async () => {
  const gw = await prepareSetup();
  try {
    gw.users.createUser({ username: "maintainer", password: "correct-123" });
    await gw.start();
    const login = (username, password, ip) => fetch(`${gw.base}/gw/login`, {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ username, password }),
    }).then((r) => r.status);
    // (a) A stranger at ONE address: ten failures, then THIS address waits — also with the right password.
    for (let i = 0; i < 10; i++) assert.equal(await login("nobody", "wrong-xyz", "203.0.113.7"), 401, `attempt ${i + 1}`);
    assert.equal(await login("nobody", "wrong-xyz", "203.0.113.7"), 429);
    assert.equal(await login("maintainer", "correct-123", "203.0.113.7"), 429, "the guesser's address waits");
    // (b) The maintainer from THEIR address gets through — used to be 429: behind a local tunnel all shared 127.0.0.1.
    assert.equal(await login("maintainer", "correct-123", "198.51.100.9"), 200, "a stranger locked the user out");
    // (c) Correct logins do not count (used to be: every attempt counted BEFORE the check).
    for (let i = 0; i < 12; i++) assert.equal(await login("maintainer", "correct-123", "198.51.100.10"), 200, `login ${i + 1}`);
    // (d) A distributed guesser on "maintainer": thirty failures from three addresses => a NEW address waits, a proven one does not.
    for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) {
      for (let i = 0; i < 10; i++) assert.equal(await login("maintainer", "wrong", ip), 401);
    }
    assert.equal(await login("maintainer", "correct-123", "192.0.2.99"), 429, "the name waits for new addresses");
    assert.equal(await login("maintainer", "correct-123", "198.51.100.9"), 200, "a proven address stays open");
  } finally { await gw.end(); }
});

test("in the middle of deleting a user their session no longer applies, and no new container appears", async () => {
  const gw = await prepareSetup();
  try {
    const admin = gw.users.createUser({ username: "admin", password: "correct-123", role: "admin" });
    const adminSess = gw.users.createSession(admin.id);
    const victim = gw.users.createUser({ username: "victim", password: "correct-123" });
    const victimSess = gw.users.createSession(victim.id);
    await gw.start();
    gw.marker("hangs-exec"); // destroy stands in the stop of the project containers (docker exec into B)
    const erase = fetch(`${gw.base}/gw/admin/users/${victim.id}?purge=1`, { method: "DELETE", headers: { cookie: `cbase_gw=${adminSess}` } });
    assert.equal(await gw.waitAtGate("exec"), true, gw.log());
    const r = await fetch(`${gw.base}/api/chats`, { headers: { cookie: `cbase_gw=${victimSess}` } });
    assert.equal(r.status, 401, "the session still applied in the middle of the deletion — the request went to a B that is just falling");
    const l = await fetch(`${gw.base}/gw/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "victim", password: "correct-123" }) });
    assert.equal(l.status, 401, "a locked user does not log in again");
    gw.openGate("exec");
    const response = await erase;
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { ok: true, purged: true });
    assert.deepEqual(gw.calls().filter((z) => /^(run|start) /.test(z)), [], "a container was created anew or started");
    assert.equal(gw.users.getUser(victim.id), null, "the user is deleted after the removal");
  } finally { await gw.end(); }
});

// A delivery token as the gateway used to issue it: the table in its last form, with the SHA-256 of the plaintext. Written by
// hand because the function no longer exists — this is how it lies in every gateway.db that ran before the managing teardown.
function createOldDeliveryTokenOn(dataDir, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const db = new DatabaseSync(path.join(dataDir, "gateway.db"));
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ingest_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
               created_at INTEGER NOT NULL, last_used_at INTEGER);
             CREATE INDEX IF NOT EXISTS idx_ingest_tokens_user ON ingest_tokens(user_id);`);
    db.prepare("INSERT INTO ingest_tokens (token_hash, user_id, label, created_at) VALUES (?,?,?,?)")
      .run(crypto.createHash("sha256").update(token).digest("hex"), userId, "Extractor", Date.now());
  } finally { db.close(); }
  return token;
}
const ingestTables = (dataDir) => {
  const db = new DatabaseSync(path.join(dataDir, "gateway.db"), { readOnly: true });
  // The gateway still runs and writes (the session of the last request): without a wait at the lock that is "database is
  // locked" (red under load). The same wait as users.js initUsers.
  db.exec("PRAGMA busy_timeout = 5000");
  try { return db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%ingest_tokens%' ORDER BY name").all().map((r) => r.name); }
  finally { db.close(); }
};

// The ingest delivery path is gone (managing teardown). A bearer with 64 base-16 characters — also one that used to be a valid
// delivery token — opens nothing under /api/ingest/: 401, no B is woken, the backend sees nothing. With a session /api/ingest/*
// is a path like any other (the backend answers).
// Sabotage: against an index.js/users.js that still knows the token: the old token applies (the table stays, CREATE IF NOT
// EXISTS), the gateway passes POST /api/ingest/episodes on to B — "401" and "the backend saw nothing" are red there.
test("ingest is gone: a bearer with 64 base-16 characters on POST /api/ingest/episodes is 401 — no B is woken, the backend sees nothing", async () => {
  const gw = await prepareSetup();
  try {
    const u = gw.users.createUser({ username: "maintainer", password: "correct-123" });
    const sess = gw.users.createSession(u.id);
    const old = createOldDeliveryTokenOn(gw.data, u.id);
    await gw.start();
    for (const token of [old, crypto.randomBytes(32).toString("hex")]) {
      assert.match(token, /^[a-f0-9]{64}$/);
      const r = await fetch(`${gw.base}/api/ingest/episodes`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "ws-1", episodes: [] }),
      });
      assert.equal(r.status, 401, await r.clone().text());
      assert.deepEqual(await r.json(), { error: "not signed in", gateway: true });
    }
    for (const [m, filePath] of [["GET", "/api/ingest/workspaces"], ["GET", "/api/ingest/episodes?system=teams&limit=5"], ["POST", "/api/ingest/files"]]) {
      const r = await fetch(`${gw.base}${filePath}`, { method: m, headers: { authorization: `Bearer ${old}` }, ...(m === "POST" ? { body: "{}" } : {}) });
      assert.equal(r.status, 401, `${m} ${filePath}`);
    }
    assert.deepEqual(gw.echo.seen.filter((e) => e.url.startsWith("/api/ingest/")), [], "the backend saw a request under /api/ingest/");
    assert.deepEqual(gw.calls().filter((z) => /^(run|start) /.test(z)), [], "a container was created or started");
    // With a session: a path like any other — passed through, no special path.
    const including = await fetch(`${gw.base}/api/ingest/episodes`, { method: "POST", headers: { cookie: `cbase_gw=${sess}` }, body: "{}" });
    assert.equal(including.status, 200, "with a session the backend answers");
    assert.deepEqual((await including.json()).echo, { m: "POST", url: "/api/ingest/episodes" });
    assert.deepEqual(ingestTables(gw.data), [], "the table ingest_tokens is gone");
  } finally { await gw.end(); }
});

// The table is dropped at start following the pattern of tunnel_tokens — with its index, and without touching other tables.
// Sabotage: with CREATE TABLE IF NOT EXISTS the existing one stays — red.
test("initUsers makes an existing ingest_tokens disappear together with its index", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-ingest-drop-"));
  try {
    users.initUsers(dir);
    const u = users.createUser({ username: "maintainer", password: "correct-123" });
    createOldDeliveryTokenOn(dir, u.id);
    assert.deepEqual(ingestTables(dir), ["idx_ingest_tokens_user", "ingest_tokens", "sqlite_autoindex_ingest_tokens_1"], "precondition: the old table is there");
    users.initUsers(dir);
    assert.deepEqual(ingestTables(dir), [], "ingest_tokens stayed behind");
    assert.equal(users.getUser(u.id)?.username, "maintainer", "the users stay");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("`purged` only after real removal — if `volume rm` fails, the user stays locked (500), and a second deletion succeeds", async () => {
  const gw = await prepareSetup();
  try {
    const admin = gw.users.createUser({ username: "admin", password: "correct-123", role: "admin" });
    const adminSess = gw.users.createSession(admin.id);
    const victim = gw.users.createUser({ username: "victim", password: "correct-123" });
    await gw.start();
    const erase = () => fetch(`${gw.base}/gw/admin/users/${victim.id}?purge=1`, { method: "DELETE", headers: { cookie: `cbase_gw=${adminSess}` } });
    gw.marker("volume-rm-fails");
    const first = await erase();
    assert.equal(first.status, 500, "a failed `volume rm` reported success");
    assert.equal((await first.json()).purged, false);
    assert.equal(gw.users.getUser(victim.id)?.locked, true, "the user stays — locked");
    fs.rmSync(path.join(gw.state, "volume-rm-fails"));
    const then = await erase();
    assert.equal(then.status, 200, await then.clone().text());
    assert.deepEqual(await then.json(), { ok: true, purged: true });
    assert.equal(gw.users.getUser(victim.id), null);
  } finally { await gw.end(); }
});

// The policy itself on a real process (with a built-in counter-test: the same process WITHOUT the policy ends), plus the wiring
// in index.js (index.js is not importable — the line is read).
test("an unhandled rejection is reported and does not end the process; index.js installs the policy before everything else", () => {
  const module = path.join(HERE, "outerShell.js");
  const script = (withPolicy) => `import { installErrorPolicy } from ${JSON.stringify(module)};
${withPolicy ? "installErrorPolicy();" : ""}
Promise.reject(new Error("probe-rejection"));
setImmediate(() => setImmediate(() => console.log("alive")));`;
  const including = spawnSync(process.execPath, ["--input-type=module", "-e", script(true)], { encoding: "utf8" });
  assert.equal(including.status, 0, including.stderr);
  assert.match(including.stdout, /alive/);
  assert.match(including.stderr, /unhandled rejection.*probe-rejection/s);
  const without = spawnSync(process.execPath, ["--input-type=module", "-e", script(false)], { encoding: "utf8" });
  assert.notEqual(without.status, 0, "counter-test: without the policy the process must end at the rejection");
  assert.doesNotMatch(without.stdout, /alive/);
  const index = fs.readFileSync(path.join(HERE, "index.js"), "utf8");
  const call = index.indexOf("\ninstallErrorPolicy();");
  assert.ok(call > 0, "index.js does not install the policy");
  assert.ok(call < index.indexOf("users.initUsers("), "the policy stands after the first step that can throw");
  assert.doesNotMatch(index, /process\.on\(\s*["']uncaughtException/, "uncaughtException stays Node's end (reason: outerShell.js)");
});

// ── The pure functions (outerShell.js) ──
test("outerShell: CF-Connecting-IP applies only from the trusted outpost; foreign addresses cannot claim one", () => {
  const req = (remoteAddress, cf) => ({ socket: { remoteAddress }, headers: cf ? { "cf-connecting-ip": cf } : {} });
  assert.equal(clientAddress(req("127.0.0.1", "198.51.100.9")), "198.51.100.9");
  assert.equal(clientAddress(req("::1", "2001:db8::1")), "2001:db8::1");
  assert.equal(clientAddress(req("::ffff:127.0.0.1", "198.51.100.9")), "198.51.100.9");
  assert.equal(clientAddress(req("172.20.0.5", "198.51.100.9")), "172.20.0.5", "a user container over the bridge may not claim an address");
  assert.equal(clientAddress(req("127.0.0.1", "no-ip; drop")), "127.0.0.1", "only a real address counts");
  assert.equal(clientAddress(req("127.0.0.1")), "127.0.0.1");
  process.env.GW_TRUSTED_PROXYS = "172.20.0.5";
  try { assert.equal(clientAddress(req("172.20.0.5", "198.51.100.9")), "198.51.100.9"); }
  finally { delete process.env.GW_TRUSTED_PROXYS; }
});

test("outerShell: loginBrake — window, cap of the maps, sweeping", () => {
  const b = loginBrake({ windowMs: 1000, perAddress: 2, perName: 3, maxEntries: 5 });
  b.failure("a", "x", 0); b.failure("a", "x", 1);
  assert.equal(b.locked("a", "y", 2), "address");
  assert.equal(b.locked("a", "y", 1001), null, "open again after the window");
  b.failure("b", "X ", 10);
  assert.equal(b.locked("c", "x", 20), "name", "the name is normalized (like verifyLogin)");
  b.success("d", "x", 20);
  assert.equal(b.locked("d", "x", 21), null, "a proven address is exempt from the name limit");
  for (let i = 0; i < 20; i++) b.failure(`z${i}`, `n${i}`, 30);
  assert.ok(b.size().addresses <= 5 && b.size().names <= 5, JSON.stringify(b.size()));
  b.sweep(5000);
  assert.deepEqual(b.size(), { addresses: 0, names: 0, proven: 1 });
});

test("outerShell: parseCookies and requestUrl never throw", () => {
  assert.deepEqual(parseCookies("other_app=50%; cbase_gw=abc; x=a=b; empty"), { other_app: "50%", cbase_gw: "abc", x: "a=b", empty: "" });
  assert.deepEqual(parseCookies("ok=%C3%A9"), { ok: "é" });
  assert.deepEqual(parseCookies(undefined), {});
  assert.equal(requestUrl("//"), null);
  assert.equal(requestUrl("http://a:99999/"), null);
  assert.equal(requestUrl("/gw/info?x=1").pathname, "/gw/info");
});

// ── the login brake ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// (1) It counted per FULL address — with IPv6 per /128. A requester without an account took a new address of their /64 and a new
// name per attempt: no limit applied, and every attempt ran through scryptSync on the event loop (400 attempts all 401, /gw/info
// up to 1.7 s). (2) The proof (exception from the name limit) applied per /128 and lived only in memory: a new privacy address of
// the same connection and every restart of the gateway made it ineffective.
// Sabotage: against an outerShell.js/index.js/users.js without these fixes — red: the /64 at the real gateway (30x 401),
// addressKey, proof per /64 and after a restart, scrypt synchronous, checkSlots.
const logIn = (gw, username, password, ip) => fetch(`${gw.base}/gw/login`, {
  method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ username, password }),
}).then(async (r) => { await r.arrayBuffer(); return r.status; });

test("changing addresses of ONE IPv6 /64 with changing names count as one connection — from the 11th failure 429", async () => {
  const gw = await prepareSetup();
  try {
    gw.users.createUser({ username: "maintainer", password: "correct-123" });
    await gw.start();
    const status = [];
    for (let k = 0; k < 30; k++) status.push(await logIn(gw, `n${k}`, "wrong-123", `2001:db8:1:2::${(k + 1).toString(16)}`));
    assert.deepEqual(status, [...Array(10).fill(401), ...Array(20).fill(429)], `status per attempt: ${status.join(",")}`);
    assert.equal(await logIn(gw, "maintainer", "correct-123", "2001:db8:1:3::1"), 200, "the neighboring /64 stays open");
  } finally { await gw.end(); }
});

test("addressKey — IPv6 per /64, IPv4 per address, IPv4 in IPv6 form as IPv4; the brake counts by it", () => {
  const s = outerShell.addressKey;
  assert.ok(s, "no addressKey in outerShell.js");
  assert.equal(s("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(s("2001:0DB8:0001:0002:ffff:0:0:1"), "2001:db8:1:2::/64");
  assert.equal(s("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(s("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(s("fe80::1%en0"), "fe80:0:0:0::/64");
  assert.equal(s("64:ff9b::198.51.100.9"), "64:ff9b:0:0::/64");
  assert.equal(s("::ffff:198.51.100.9"), "198.51.100.9", "an IPv4 in IPv6 form is the IPv4");
  assert.equal(s("198.51.100.9"), "198.51.100.9");
  assert.equal(s("?"), "?", "what is no address stays");
  const b = loginBrake({ windowMs: 1000 });
  for (let i = 1; i <= 10; i++) b.failure(`2001:db8:1:2::${i}`, `n${i}`, 0);
  assert.equal(b.locked("2001:db8:1:2::ffff", "fresh", 1), "address", "the /64 waits");
  assert.equal(b.locked("2001:db8:1:3::1", "fresh", 1), null, "the neighboring /64 does not");
});

test("the proof applies per /64 and survives a restart (gateway.db) — a guesser does not lock the name for the proven connection", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-proven-"));
  try {
    users.initUsers(dir);
    const storage = users.loginProbation;
    assert.ok(storage, "no persistent proof in users.js");
    // thirty failures on "maintainer" from thirty /64s (none of them reaches the address limit)
    const rate = (b, now) => { for (let i = 1; i <= 30; i++) b.failure(`2001:db8:9:${i.toString(16)}::1`, "maintainer", now); };
    const prior = loginBrake({ storage });
    prior.success("2a02:3100:aa:bb::1111", "Maintainer", 1000);
    rate(prior, 2000);
    assert.equal(prior.locked("2a02:3100:aa:bb::2222", "maintainer", 2001), null, "a new address of the same /64 (privacy address) is proven");
    assert.equal(prior.locked("2a02:3100:aa:cc::1", "maintainer", 2001), "name", "a foreign /64 waits");
    const after = loginBrake({ storage }); // restart of the gateway: new instance, the same gateway.db
    rate(after, 3000);
    assert.equal(after.locked("2a02:3100:aa:bb::1111", "maintainer", 3001), null, "the proof was gone after the restart");
    after.sweep(1000 + 30 * 24 * 3600_000 + 1); // after 30 days it has expired and been swept
    assert.equal(storage.read("maintainer", "2a02:3100:aa:bb::/64"), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("verifyLogin does not compute scrypt on the event loop — a previously scheduled setImmediate runs before the check ends", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-scrypt-"));
  try {
    users.initUsers(dir);
    users.createUser({ username: "maintainer", password: "correct-123" });
    for (const [name, pw, expected] of [["maintainer", "correct-123", "maintainer"], ["maintainer", "wrong-123", null], ["unknown", "x", null]]) {
      let inBetween = false;
      setImmediate(() => { inBetween = true; });
      const u = await users.verifyLogin(name, pw);
      assert.equal(inBetween, true, `${name}/${pw}: scrypt ran synchronously — the event loop stood still`);
      assert.equal(u?.username ?? null, expected);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("checkSlots — at most two password checks at once, beyond that an immediate no; index.js takes the slot before verifyLogin and returns it in the finally", () => {
  const p = outerShell.checkSlots?.(2);
  assert.ok(p, "no checkSlots in outerShell.js");
  assert.equal(p.proofs(), true);
  assert.equal(p.proofs(), true);
  assert.equal(p.proofs(), false, "the third gets no slot");
  p.gib();
  assert.equal(p.proofs(), true);
  const index = fs.readFileSync(path.join(HERE, "index.js"), "utf8");
  const login = index.slice(index.indexOf('p === "/gw/login"'), index.indexOf('p === "/gw/logout"'));
  const slot = login.indexOf("checks.proofs()");
  assert.ok(slot > 0 && slot < login.indexOf("await users.verifyLogin("), "no slot before the check");
  assert.match(login, /try \{ u = await users\.verifyLogin\([^)]*\); \} finally \{ checks\.gib\(\); \}/);
});

// ── no delivery path any more ──
// The Teams watch left cbase: its delivery path /gw/watches/<user>/deliver is gone. A request there is an ordinary
// unknown /gw path — the session branch answers it (401 without a session) and nothing is woken.
// Counter-proof: the old branch put back in index.js => 503/401 with `gateway: true` from the delivery branch, not the session one.
test("POST /gw/watches/<user>/deliver is no route any more: the session branch answers 401, nothing is woken", async () => {
  const gw = await prepareSetup();
  try {
    const u = gw.users.createUser({ username: "watch-gone", password: "correct-123" });
    await gw.start();
    const r = await fetch(`${gw.base}/gw/watches/${u.id}/deliver`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${"t".repeat(48)}` }, body: "{}" });
    assert.equal(r.status, 401);
    assert.equal(gw.calls().filter((z) => /^(run|start) /.test(z)).length, 0, "nothing woken");
  } finally {
    await gw.end();
  }
});
