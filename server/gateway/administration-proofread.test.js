// Cross-reading of the administration at the REAL gateway (index.js as a child, gateway-harness.mjs with a fake docker).
// The deploy-tool counterparts live in the deploy tool's limits.ops.test.mjs.
//
// What holds here — and the way that breaks it (counter-tests, each shown red once, source restored afterwards):
//  · stale authorization: a request whose body was still in flight (or that waited on docker) changes nothing if its admin
//    has been locked or demoted in the meantime — checked AFTER the body and in the PUT right before saving.
//      Sabotage: delete the line `if (!stillAllowed(req, res)) return;` in the create path of index.js ⇒ "stale
//      authorization" red (the locked admin created "intruder", 201); delete the line `if (!stillAllowed(req, res, target)) return;`
//      BEFORE saving in the PUT ⇒ red in case (e) (200, the demoted admin wrote 6 GiB).
//  · deleted target: a target deleted during the request is a 404 — never 200 with `null`, never an orphaned row; in the
//    middle of its deletion the PUT saves nothing (409).
//      Sabotage: in users.js setResources `WHERE EXISTS (…)` → `WHERE 1` ⇒ "deleted target" red (a row for a user that does
//      not exist); delete the line `if (!n) return send(res, 404, …)` in respondWithUser of index.js ⇒ red (stop: 200 with
//      `null`); delete `if (containers.teardownRunning(target)) return send(res, 409, …)` BEFORE saving in the PUT ⇒ red
//      (409 "saved but not applied", the row of the deleted user changed); all checks after the body
//      (`stillAllowed(req, res, target)` → `stillAllowed(req, res)` in PATCH, password and PUT, plus the two above) ⇒ red
//      (200 `null`, orphaned row).
//  · closing connections: locking, a new password and deleting close what a session had already opened (port tunnel, SSE); a
//    tunnel or stream that still waited for its container during the lock no longer opens.
//      Sabotage: delete the call `closeStreams(target)` when locking in index.js ⇒ red (after the ripcord: both connections
//      open); proxy.js closeStreams without `ding.destroy()` ⇒ red (already at locking: both open — the test ends at the
//      first group and never sees password and deletion); delete the check after ensureBackend in the upgrade path of index.js
//      ⇒ red in the window (101 instead of 401), in the /api path ⇒ red (200 instead of 401).
//  · admin redirect: GET /gw/admin without a session redirects to ADMINISTRATION_JUMP.
//      Sabotage: the old state (`location: "/"`) ⇒ "admin redirect" red.
//  · start alignment (gateway side): at start every deviating container is aligned to its stored value — "no upper limit" from
//    a time with fewer threads is raised, also on a stopped container; the start does not lower RAM below an unmeasured
//    consumption either; a row that the initial fill just took over from the container is left alone.
//      Sabotage: the call `sameLimitsFrom(…)` at start replaced by `0` ⇒ "start alignment" red (no update row; the second case
//      red with "gate" ≠ "finished", no hang); `{ except: fresh }` → `{}` ⇒ red (the freshly taken-over, stopped container
//      got 3 instead of 3.4 GiB); delete the measurement check (`if (reason) …`) ⇒ red (the running container without
//      measurement was lowered from 8 to 4 GiB).
//  · start alignment, second case: an admin who saves DURING the start alignment keeps their value — the update of the
//    alignment can arrive after that of the PUT (harness: marker `hangs-update` holds exactly the first update at the gate),
//    afterwards the stored value is sent after it.
//      Sabotage: delete the line `if (afterwards && !sameValues(afterwards, r)) await containers.applyResources(userId, afterwards);`
//      ⇒ red (2 instead of 3 update rows, last 4 instead of 6 GiB).
//
// Waiting is on events: the start lines of the gateway, gates of the fake docker, "100 Continue" (the handler stands in
// the reading of the body, see harness halfRequest), rows in gateway.db and responses. The ONE exception is closing a
// connection in the closing-connections test: without the defect it NEVER closes — there the ripcord of the fakes (RIPCORD_MS)
// stands as a red line instead of a hang, no deadline.
//
// Run:  node --test --test-reporter=tap server/gateway/administration-proofread.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { prepareSetup } from "./gateway-harness.mjs";
import { hostSpecs } from "./containers.js";
import * as V from "./administration-contract.js";
import { RIPCORD_MS } from "../../server/backend/test/ripcord.mjs";

const G = 1024 ** 3;
const SPEC = hostSpecs();
const S = V.CPU_PRIO_SHARES;
const cname = (id) => `cbase-u-${id}`;
const fresh2 = (gw, name, role = "user") => gw.users.createUser({ username: name, password: "correct-123", role });
const updates = (gw) => gw.calls().filter((z) => z.startsWith("update "));
const desired = (gw) => JSON.parse(fs.readFileSync(path.join(gw.data, "resources-desired.json"), "utf8"));

function asUser(gw, sess) {
  return async (method, filePath, body) => {
    const r = await fetch(gw.base + filePath, {
      method,
      redirect: "manual",
      headers: { ...(sess ? { cookie: `cbase_gw=${sess}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML or empty */ }
    return { status: r.status, json, text, location: r.headers.get("location") };
  };
}
// A request that is awaited only later: if the test fails before, its finally tears down the gateway, and the open
// request would be reported as an unhandled rejection ("fetch failed") — at the place of the actual finding.
const later = (p) => { p.catch(() => {}); return p; };
const login = (gw, username, password) => fetch(`${gw.base}/gw/login`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }),
}).then((r) => r.status);

// The ripcord for "does the connection close?" (header): "closed" — or after RIPCORD_MS "open", as a red line instead of a hang.
async function toOrOpen(v) {
  let clock;
  const r = await Promise.race([v.whenClosed.then(() => "closed"), new Promise((res) => { clock = setTimeout(() => res("open"), RIPCORD_MS); })]);
  clearTimeout(clock);
  return r;
}
const UPGRADE = (sess) => "GET /api/tunnel?port=5432 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n"
  + `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: cbase_gw=${sess}\r\n\r\n`;
const STREAM = (sess) => `GET /api/events HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\nCookie: cbase_gw=${sess}\r\n\r\n`;

test("stale authorization: a request whose body was still in flight or that waited on docker changes nothing once its admin has been locked or demoted", async () => {
  const gw = await prepareSetup();
  try {
    const B = fresh2(gw, "bert", "admin");
    const [A1, A2, A3, A4, A5] = ["a-one", "a-two", "a-three", "a-four", "a-five"].map((n) => fresh2(gw, n, "admin"));
    const C = fresh2(gw, "carl");
    gw.container(cname(C.id), { mem: 4 * G, shares: S.normal });
    const prior = { ramGiB: 4, cpuPrio: "normal", cpuMax: null };
    gw.users.setResources(C.id, prior, null);
    const sess = Object.fromEntries([B, A1, A2, A3, A4, A5].map((u) => [u.id, gw.users.createSession(u.id)]));
    const b = asUser(gw, sess[B.id]);
    await gw.start();

    // (a) Locked while the body was in flight: no new admin.
    const create = await gw.halfRequest("POST", "/gw/admin/users", sess[A1.id], { username: "intruder", password: "correct-123", role: "admin" });
    assert.equal((await b("PATCH", `/gw/admin/users/${A1.id}`, { locked: true })).status, 200);
    const ra = await create.rest();
    assert.equal(ra.status, 401, ra.text);
    assert.ok(!gw.users.listUsers().some((u) => u.username === "intruder"), "a locked admin created a new admin");

    // (b) Locked while the body was in flight: unlocking oneself does not work.
    const unlock = await gw.halfRequest("PATCH", `/gw/admin/users/${A2.id}`, sess[A2.id], { locked: false });
    assert.equal((await b("PATCH", `/gw/admin/users/${A2.id}`, { locked: true })).status, 200);
    const rb = await unlock.rest();
    assert.equal(rb.status, 401, rb.text);
    assert.equal(gw.users.getUser(A2.id).locked, true, "the locked admin unlocked themselves");

    // (c) Demoted while the body was in flight: no foreign password.
    const pw = await gw.halfRequest("POST", `/gw/admin/users/${C.id}/password`, sess[A3.id], { password: "taken-over-123" });
    assert.equal((await b("PATCH", `/gw/admin/users/${A3.id}`, { role: "user" })).status, 200);
    const rc = await pw.rest();
    assert.equal(rc.status, 403, rc.text);
    assert.equal(await login(gw, "carl", "taken-over-123"), 401, "the demoted admin set a foreign password");
    assert.equal(await login(gw, "carl", "correct-123"), 200);

    // (d) Demoted while the body was in flight: no resources.
    const put = await gw.halfRequest("PUT", `/gw/admin/users/${C.id}/resources`, sess[A4.id], { ramGiB: 6, cpuPrio: "up", cpuMax: 1 });
    assert.equal((await b("PATCH", `/gw/admin/users/${A4.id}`, { role: "user" })).status, 200);
    const rd = await put.rest();
    assert.equal(rd.status, 403, rd.text);
    assert.deepEqual(gw.users.getResources(C.id), prior);

    // (e) Demoted while the PUT waited on docker (the situation before the lowering verdict): the check right before saving.
    gw.marker("hangs-inspect");
    const putE = later(asUser(gw, sess[A5.id])("PUT", `/gw/admin/users/${C.id}/resources`, { ramGiB: 6, cpuPrio: "up", cpuMax: 1 }));
    assert.equal(await gw.waitAtGate("inspect"), true, gw.log());
    const back = later(b("PATCH", `/gw/admin/users/${A5.id}`, { role: "user" })); // its response measures the container — waits at the same gate
    assert.equal(await gw.waitUntil(() => gw.users.getUser(A5.id).role === "user"), true, gw.log());
    gw.openGate("inspect");
    const re = await putE;
    assert.equal(re.status, 403, re.text);
    assert.equal((await back).status, 200);
    assert.deepEqual(gw.users.getResources(C.id), prior, "the demoted admin kept writing after the wait");
    assert.deepEqual(updates(gw), [], "no docker update for a request without authorization");
  } finally { await gw.end(); }
});

test("deleted target: a target deleted during the request is a 404 — never 200 with null, never an orphaned row; in the middle of its deletion the PUT saves nothing", async () => {
  const gw = await prepareSetup();
  try {
    // users.js writes only for a user that exists (in the same statement).
    const foreign = "00000000-0000-4000-8000-00000000dead";
    assert.equal(gw.users.setResources(foreign, { ramGiB: 3, cpuPrio: "up", cpuMax: null }, null), false);
    assert.equal(gw.users.supplementResources(foreign, { ramGiB: 3, cpuPrio: "up", cpuMax: null }), false);
    assert.equal(gw.users.getResources(foreign), null, "a row for a user that does not exist");

    const B = fresh2(gw, "bert", "admin");
    const [D, E, F, H, K] = ["dora", "emil", "fritz", "hans", "karl"].map((n) => fresh2(gw, n));
    for (const u of [D, E, F]) gw.container(cname(u.id), { gone: true }); // deletion without a container — it goes through immediately
    for (const u of [H, K]) gw.container(cname(u.id), { mem: 2 * G, shares: S.normal });
    for (const u of [D, E, F, H, K]) gw.users.setResources(u.id, { ramGiB: 2, cpuPrio: "normal", cpuMax: null }, null);
    const sess = gw.users.createSession(B.id);
    const b = asUser(gw, sess);
    await gw.start();
    const erase = async (u) => { const r = await b("DELETE", `/gw/admin/users/${u.id}`); assert.equal(r.status, 200, r.text); };

    // PUT: the body arrives only after the deletion.
    const put = await gw.halfRequest("PUT", `/gw/admin/users/${D.id}/resources`, sess, { ramGiB: 3, cpuPrio: "up", cpuMax: null });
    await erase(D);
    const r1 = await put.rest();
    assert.equal(r1.status, 404, r1.text);
    assert.equal(gw.users.getResources(D.id), null, "an orphaned row for the deleted user");
    assert.equal(desired(gw)[D.id], undefined);

    // PATCH and password: the same.
    const patch = await gw.halfRequest("PATCH", `/gw/admin/users/${E.id}`, sess, { role: "admin" });
    await erase(E);
    const r2 = await patch.rest();
    assert.equal(r2.status, 404, r2.text);
    const pw = await gw.halfRequest("POST", `/gw/admin/users/${F.id}/password`, sess, { password: "new-password" });
    await erase(F);
    const r3 = await pw.rest();
    assert.equal(r3.status, 404, r3.text);

    // The response to an action whose target was deleted meanwhile: 404 instead of 200 with `null`.
    gw.marker("hangs-stop"); // only the NEXT stop waits — the one of the deletion runs through
    const stop = later(b("POST", `/gw/admin/users/${H.id}/stop`, {}));
    assert.equal(await gw.waitAtGate("stop"), true, gw.log());
    await erase(H);
    gw.openGate("stop");
    const r4 = await stop;
    assert.equal(r4.status, 404, r4.text);
    assert.notEqual(r4.text, "null");

    // In the middle of the deletion (the teardown stands in the stop of the project containers): the PUT that waited on docker before saves nothing.
    gw.marker("hangs-inspect");
    const putK = later(b("PUT", `/gw/admin/users/${K.id}/resources`, { ramGiB: 3, cpuPrio: "up", cpuMax: null }));
    assert.equal(await gw.waitAtGate("inspect"), true, gw.log());
    const deleteK = later(b("DELETE", `/gw/admin/users/${K.id}`));
    assert.equal(await gw.waitUntil(() => gw.users.getUser(K.id)?.locked === true), true, gw.log()); // lock and destroy() in the same move
    gw.marker("hangs-exec");
    gw.openGate("inspect");
    const r5 = await putK;
    assert.equal(r5.status, 409, r5.text);
    assert.match(r5.json.error, /^This user.s environment is currently being removed$/, "saved while the user was being torn down");
    assert.deepEqual(gw.users.getResources(K.id), { ramGiB: 2, cpuPrio: "normal", cpuMax: null });
    gw.openGate("exec");
    assert.equal((await deleteK).status, 200);
    assert.equal(gw.users.getResources(K.id), null);
    assert.deepEqual(updates(gw), []);
  } finally { await gw.end(); }
});

test("closing connections: locking, a new password and deleting close open port tunnels and event streams; what still waited for the container during the lock no longer opens", async () => {
  const gw = await prepareSetup();
  const connections = [];
  try {
    const B = fresh2(gw, "bert", "admin");
    const [C, E, F, W] = ["carl", "emil", "fritz", "willi"].map((n) => fresh2(gw, n));
    const sess = Object.fromEntries([B, C, E, F, W].map((u) => [u.id, gw.users.createSession(u.id)]));
    const b = asUser(gw, sess[B.id]);
    await gw.start();
    const open = async (text, pattern) => {
      const v = await gw.connect();
      connections.push(v);
      v.write(text);
      assert.ok(await v.waitForTruthy(pattern), `not opened: ${v.text().slice(0, 200)}`);
      return v;
    };
    const tunnel = (u) => open(UPGRADE(sess[u.id]), /^HTTP\/1\.1 101 /);
    const stream = (u) => open(STREAM(sess[u.id]), /: hallo/);

    // Locking.
    const [t1, s1] = [await tunnel(C), await stream(C)];
    assert.equal((await b("PATCH", `/gw/admin/users/${C.id}`, { locked: true })).status, 200);
    assert.deepEqual([await toOrOpen(t1), await toOrOpen(s1)], ["closed", "closed"], "tunnel and stream of the locked user stayed open");

    // A new password (setPassword ends the sessions).
    const [t2, s2] = [await tunnel(E), await stream(E)];
    assert.equal((await b("POST", `/gw/admin/users/${E.id}/password`, { password: "new-password" })).status, 200);
    assert.deepEqual([await toOrOpen(t2), await toOrOpen(s2)], ["closed", "closed"], "tunnel and stream survived the new password");

    // Deleting (locks first).
    const t3 = await tunnel(F);
    assert.equal((await b("DELETE", `/gw/admin/users/${F.id}`)).status, 200);
    assert.equal(await toOrOpen(t3), "closed", "the deleted user's tunnel stayed open");

    // The window: tunnel and stream wait for the container (ensureBackend) while the lock happens — they do not open afterwards.
    gw.marker("hangs-inspect");
    const t4 = await gw.connect();
    const s4 = await gw.connect();
    connections.push(t4, s4);
    t4.write(UPGRADE(sess[W.id]));
    s4.write(STREAM(sess[W.id]));
    assert.equal(await gw.waitAtGate("inspect"), true, gw.log());
    const lock = later(b("PATCH", `/gw/admin/users/${W.id}`, { locked: true })); // measures the container afterwards — waits at the same gate
    assert.equal(await gw.waitUntil(() => gw.users.getUser(W.id).locked === true), true, gw.log());
    gw.openGate("inspect");
    const [a4, b4] = await Promise.all([t4.waitForTruthy(/^HTTP\/1\.1 \d{3} /), s4.waitForTruthy(/^HTTP\/1\.1 \d{3} /)]);
    assert.match(a4 ?? "(closed without response)", /^HTTP\/1\.1 401 /, "a tunnel that waited during the lock was opened");
    assert.match(b4 ?? "(closed without response)", /^HTTP\/1\.1 401 /, "a stream that waited during the lock was opened");
    assert.equal((await lock).status, 200);
  } finally {
    for (const v of connections) v.end();
    await gw.end();
  }
});

test("admin redirect: GET /gw/admin without a session redirects to ADMINISTRATION_JUMP (as with a session)", async () => {
  const gw = await prepareSetup();
  try {
    await gw.start();
    const r = await asUser(gw, null)("GET", "/gw/admin");
    assert.deepEqual([r.status, r.location], [302, V.ADMINISTRATION_JUMP]);
  } finally { await gw.end(); }
});

test("start alignment: at start the gateway aligns every deviating container to its value — “no upper limit” from a time with fewer threads is raised (also stopped); no lowering without measurement; just-taken-over rows stay untouched", async () => {
  assert.ok(SPEC.threads > 1, "the case needs a host with more than one thread");
  const gw = await prepareSetup();
  try {
    const admin = fresh2(gw, "admin", "admin");
    const [fewer, stopped, lower, equal, fresh] = ["fewer", "stopped", "lower", "equal", "fresh"].map((n) => fresh2(gw, n));
    // "No limit", stored when the host had 1 thread: `docker update --cpus 1` — today a hard limit of 1.
    gw.container(cname(fewer.id), { mem: 4 * G, cpus: 1, shares: S.normal });
    gw.container(cname(stopped.id), { stopped: true, mem: 2 * G, cpus: 1, shares: S.up });
    gw.container(cname(lower.id), { mem: 8 * G, shares: S.normal }); // running, without a measurable id
    gw.container(cname(equal.id), { mem: 2 * G, shares: S.normal });
    gw.container(cname(fresh.id), { stopped: true, mem: Math.round(3.4 * G) }); // the initial fill rounds to 3 GiB
    gw.container(cname(admin.id), { gone: true });
    gw.users.setResources(admin.id, { ramGiB: 2, cpuPrio: "normal", cpuMax: null }, null);
    gw.users.setResources(fewer.id, { ramGiB: 4, cpuPrio: "normal", cpuMax: null }, admin.id);
    gw.users.setResources(stopped.id, { ramGiB: 2, cpuPrio: "up", cpuMax: null }, admin.id);
    gw.users.setResources(lower.id, { ramGiB: 4, cpuPrio: "normal", cpuMax: null }, admin.id);
    gw.users.setResources(equal.id, { ramGiB: 2, cpuPrio: "normal", cpuMax: null }, admin.id);
    const a = asUser(gw, gw.users.createSession(admin.id));
    await gw.start();

    assert.match(gw.log(), /Resources: 1 users taken over from the existing state, 2 containers aligned to the stored value/);
    assert.deepEqual(updates(gw).sort(), [
      `update --memory ${2 * G} --memory-swap ${4 * G} --cpu-shares ${S.up} --cpus ${SPEC.threads} id-${cname(stopped.id)}`,
      `update --memory ${4 * G} --memory-swap ${8 * G} --cpu-shares ${S.normal} --cpus ${SPEC.threads} id-${cname(fewer.id)}`,
    ].sort(), "by id, with --cpus <threads of the host> — and only for the two");
    assert.match(gw.log(), new RegExp(`Limits of ${lower.id} NOT aligned .*cannot be measured`));
    assert.deepEqual(gw.users.getResources(fresh.id), { ramGiB: 3, cpuPrio: "normal", cpuMax: null }, "taken over from the container");

    const v = await a("GET", "/gw/admin/administration");
    assert.equal(v.status, 200, v.text);
    const from = Object.fromEntries(v.json.user.map((n) => [n.username, n.deviating]));
    assert.deepEqual(from, { admin: false, fewer: false, stopped: false, lower: true, equal: false, fresh: true },
      "aligned ⇒ equal; unmeasured not lowered and just taken over ⇒ visibly “deviates”");
  } finally { await gw.end(); }
});

test("start alignment: a save DURING the start alignment wins — the alignment does not reset the just-saved value with the row from before", async () => {
  assert.ok(SPEC.threads > 1, "the case needs a host with more than one thread");
  const gw = await prepareSetup();
  try {
    const admin = fresh2(gw, "admin", "admin");
    const W = fresh2(gw, "willi");
    gw.container(cname(admin.id), { gone: true });
    gw.users.setResources(admin.id, { ramGiB: 2, cpuPrio: "normal", cpuMax: null }, null);
    gw.container(cname(W.id), { mem: 4 * G, cpus: 1, shares: S.normal }); // "no limit" from a time with 1 thread
    gw.users.setResources(W.id, { ramGiB: 4, cpuPrio: "normal", cpuMax: null }, admin.id);
    const a = asUser(gw, gw.users.createSession(admin.id));
    gw.marker("hangs-update"); // the FIRST update — that of the start alignment (4 GiB, no limit) — waits at the gate
    const start = later(gw.start());
    // The gate OR the end of the start: if the start does not align at all, no update comes — then this is a red line, not a hang.
    const atGate = await Promise.race([gw.waitAtGate("update").then((ok) => (ok ? "gate" : "dead")), start.then(() => "finished", () => "dead")]);
    assert.equal(atGate, "gate", `the start alignment stopped at no docker update (${atGate}) — does it align at all?\n${gw.log()}`);
    // Now an admin saves 6 GiB/up: stored and applied (its update runs through, the marker is used up).
    const put = await a("PUT", `/gw/admin/users/${W.id}/resources`, { ramGiB: 6, cpuPrio: "up", cpuMax: null });
    assert.equal(put.status, 200, put.text);
    const afterPut = updates(gw).length;
    gw.openGate("update"); // only NOW does the update of the alignment arrive — with the value from before
    await start;
    const u = updates(gw);
    assert.equal(u.length, afterPut + 1, `the alignment sends the stored value after it: ${JSON.stringify(u)}`);
    assert.equal(u.at(-1), `update --memory ${6 * G} --memory-swap ${12 * G} --cpu-shares ${S.up} --cpus ${SPEC.threads} id-${cname(W.id)}`,
      "in the end the stored value applies, not the row from before the save");
    const v = await a("GET", "/gw/admin/administration");
    assert.equal(v.json.user.find((n) => n.username === "willi").deviating, false);
  } finally { await gw.end(); }
});
