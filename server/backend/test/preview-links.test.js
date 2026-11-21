// Preview links for project containers. Real server (`withAgentsServer`), real routes; only these are faked:
//   - the ngrok SDK (via `setNgrokSdk`): counts sessions and open listeners, writes every open into `events`, rejects the authtoken
//     "tok-wrong" with ERR_NGROK_105 and can make the next open fail with a given ngrok error text;
//   - the ngrok API (`http.createServer`, port 0, CBASE_NGROK_API): accepts only the test key, reserves and releases, can make the
//     next reservation (collision) or release fail on purpose.
// No network call to ngrok, no clock: expiry is checked with a time passed in (checkProcedure(t)), the post-start via
// `reinstate()` directly (the harness switches the post-start timer off).
//
// The promises, each with the way that breaks it:
//   (1) Access: PUT requires both keys (400), a failed check stores NOTHING, no access value in a response or in the event stream,
//       deleting with active links 409.
//   (2) dev: creating opens WITHOUT a domain on 127.0.0.1:<port>, the second link 409 LIMIT, ERR_NGROK_334 => 502 with the
//       occupied sentence and an ended row; revoking closes, a second revoke is 200, afterwards the session is closed. Without
//       access 412, without a port 400, each of the four keys missing on its own 400.
//   (3) names: reserve -> open (in this order), ONE session for three links, the 4th link 409, a collision re-rolls, a failed open
//       releases, a failed release is made up for by checkProcedure.
//   (4) checkProcedure(t) ends exactly the expired links, "unlimited" never; (4b) and - as a fallback net, with the observer
//       detached - those whose project or service was deleted (the row stays as history, schema-register.test.js names the reason).
//   (5) post-start (restart on the same data folder): the same name, NO new reservation; a `start` row without url is ended; a
//       failed reopen stands on `error` and the next procedure reopens.
//   (6) targetFor: instance IP (IPv6 bracketed), 404 unknown, 409 without IP, 400 for `instance: null` of a relocated project.
//   (7) no MCP tool calls the routes, and the API fence has no row for them (403 from a project network).
//   (8) every deletion path of the data layer ends the links on its target AT ONCE - without a tick - and closes their listeners:
//       instance (`deleteProjectInstance`, one and all), service (`deleteProjectService`), project (`deleteProject`). The fallback
//       net in the tick: instance gone (observer detached) => ended; new IP of the same instance => reopened on the new target;
//       without IP => listener closed, `error`, with IP open again; a link without an instance of a project relocated in the
//       meantime => ended.
//   (9) no access value - not even a REJECTED one - in a response, in the event stream, in `ngrok_access.error`, in a link's `error`
//       or in the log (console.log/error/warn, captured in EVERY test via `withPreview`). The fake SDK and the fake API repeat the
//       received value in their error texts, like ngrok (ERR_NGROK_105/107 "Your authtoken: ..."); the test checks that the path
//       was entered (`•••` is in the text).
//   (10) deleting the API key or access releases first; if a reservation stays open => 409 APPROVAL_OPEN with `open`, nothing
//        deleted; `release` without a key logs; a reservation whose response was lost is searched for and released.
//   (11) responses and SSE carry EXACTLY the keys of the contract (preview/contract.js), the table's CHECK clauses the same value sets.
//
// COUNTER-TESTS (each sabotage shown red, then restored):
//   preview/ngrok-session.js `fetchSession` without the fallback to the running session - `open` builds one per link => (3) red
//     with "three links, ONE session" and (5) red (session counter: a session stayed open after the server end).
//   (8)  `store.setTargetRemovedObserver(targetRemoved)` commented out in server.js => (8) red ("instance removed: ended at once,
//        without a tick" - the link was still `online`).
//   (8)  `checkTarget` skipped in the tick => (8) red (redirected: [] instead of [b]).
//   (9)  `redact` returns the text unchanged => (1), (3), (5), (9), (10) red (access value in the 400 response, in the 502, in the
//        event stream, in the log).
//   (10) `approvalsBeforeTheDelete` without the 409 => (10) red (200 instead of 409 APPROVAL_OPEN); without `cleanLostReservation`
//        => (10) red (the lost reservation stays at the fake API).
//   (11) `linkFrom` with one more field (`ngrokDomainId`) => (2) and (11) red.
// The rewrite proxy: the fake SDK now sees the proxy as its target (`forward`, http://127.0.0.1:<p>); `target` is where the proxy
// forwards (`proxyTarget`) - the target checks of (2) and (8) therefore still hold the service. Also: exactly one proxy per open
// listener (at the end of every test and after a failed open in (3)), after revoking the proxy's port is closed (ECONNREFUSED, (2)).
//   - `close` in preview/ngrok-session.js does not close the proxy => (2) red ("connected" instead of ECONNREFUSED) and all tests
//     with links red (one proxy per listener, none left). Without `server.unref()` in the proxy this run HUNG instead of turning red
//     (the forgotten proxies kept the test process open).
//   - the failed open does not close its proxy => (3) red (3 proxies, 2 listeners).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { setNgrokSdk, sessionClosed } from "../electron/server/preview/ngrok-session.js";
import { openProxies, proxyTarget } from "../electron/server/preview/rewrite-proxy.js";
import {
  OCCUPIED_SENTENCE, SERVICE_GONE_SENTENCE, INSTANCE_GONE_SENTENCE, PROJECT_GONE_SENTENCE, RELOCATED_SET, PreviewError, checkProcedure, reinstate,
  previewPostWork, previewServerEnd, targetFor, targetRemoved,
} from "../electron/server/preview/links.js";
import { ENDED_REASONS, LINK_FIELDS, MODES, SSE_TYPE, STATUS_FIELDS, ACCESS_FIELDS, STATES } from "../electron/server/preview/contract.js";
import { rowFor } from "../electron/server/projectbox/fence-table.js";
import { withAgentsServer, projectWithoutInstance, waitForTruthy } from "./agent-harness.mjs";
import { GLOBAL } from "./quiet.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Test values - invented, valid nowhere. They are searched for in every response and in the event stream.
const TOKEN = "tok-SECRET-7c1e9a";
const KEY = "key-SECRET-3b8f20";
// Rejected values - they must not appear anywhere either (ngrok repeats them in the error text).
const TOK_WRONG = "tok-wrong-5d2e91";
const KEY_WRONG = "key-wrong-a07c34";
const VALUES = [TOKEN, KEY, TOK_WRONG, KEY_WRONG];
const withValue = (t) => VALUES.find((w) => String(t).includes(w));
const DEV_URL = "https://test-dev-address.ngrok-free.dev";
const DAY = 86_400_000;

// ── Fakes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

function fakeSdk(events) {
  const tally = { built: 0, open: 0, listener: [], openFails: [] };
  class Listener {
    constructor(e) { this.e = e; }
    url() { return this.e.domain ? `https://${this.e.domain}` : DEV_URL; }
    id() { return this.e.id; }
    async close() { if (this.e.open) { this.e.open = false; events.push(`close ${this.e.domain || "dev"}`); } }
  }
  class Builder {
    constructor(s) { this.s = s; this.e = {}; }
    domain(d) { this.e.domain = d; return this; }
    metadata(m) { this.e.metadata = m; return this; }
    async listenAndForward(target) {
      if (this.s.shut) throw new Error("session closed");
      const f = tally.openFails.shift();
      // Like ngrok (ERR_NGROK_107 and others): the error text names the session's authtoken.
      if (f) throw new Error(`${f} (Your authtoken: ${this.s.t})`);
      // The listener forwards to the rewrite proxy: `forward` is its address, `target` the service behind it.
      const e = { ...this.e, forward: target, target: proxyTarget(target), open: true, id: `l${tally.listener.length + 1}`, session: this.s.seq };
      tally.listener.push(e);
      events.push(`open ${e.domain || "dev"}`);
      return new Listener(e);
    }
  }
  class Session {
    constructor(seq, t) { this.seq = seq; this.t = t; this.shut = false; }
    httpEndpoint() { return new Builder(this); }
    async close() { if (!this.shut) { this.shut = true; tally.open -= 1; } }
  }
  class SessionBuilder {
    authtoken(t) { this.t = t; return this; }
    handleDisconnection(f) { this.f = f; return this; }
    async connect() {
      if (this.t !== TOKEN) throw Object.assign(new Error(`authentication failed: The authtoken you specified is invalid. Your authtoken: ${this.t}. ERR_NGROK_105`), { errorCode: "ERR_NGROK_105" });
      tally.built += 1;
      tally.open += 1;
      return new Session(tally.built, this.t);
    }
  }
  return { sdk: { SessionBuilder }, tally, openListener: () => tally.listener.filter((e) => e.open) };
}

async function fakeApi(events) {
  // `reserved`: what stands at "ngrok" (id -> name); `postLost`: that many reservations arise whose response is lost.
  const tally = { requests: [], postFails: [], deleteFails: [], postLost: 0, reserved: new Map(), n: 0 };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    tally.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, version: req.headers["ngrok-version"], body });
    const respond = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(obj ? JSON.stringify(obj) : ""); };
    // Like ngrok's error texts these can repeat the key too - so it goes into every message.
    const key = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (req.headers.authorization !== `Bearer ${KEY}` || req.headers["ngrok-version"] !== "2") {
      return respond(401, { error_code: "ERR_NGROK_201", status_code: 401, msg: `The API key you specified is invalid: ${key}` });
    }
    if (req.method === "GET" && req.url === "/reserved_domains?limit=1") return respond(200, { reserved_domains: [] });
    if (req.method === "GET" && req.url === "/reserved_domains?limit=100") {
      return respond(200, { reserved_domains: [...tally.reserved].map(([id, domain]) => ({ id, domain })), next_page_uri: null });
    }
    if (req.method === "POST" && req.url === "/reserved_domains") {
      const forced = tally.postFails.shift();
      if (forced) return respond(forced, { error_code: "ERR_NGROK_413", status_code: forced, msg: `The domain is already reserved (key ${key}).` });
      const { domain } = JSON.parse(body);
      const id = `rd_${++tally.n}`;
      events.push(`reserve ${domain}`);
      tally.reserved.set(id, domain);
      if (tally.postLost > 0) { tally.postLost -= 1; return req.socket.destroy(); } // created, response lost
      return respond(201, { id, domain });
    }
    const del = /^\/reserved_domains\/([^/]+)$/.exec(req.url);
    if (req.method === "DELETE" && del) {
      const forced = tally.deleteFails.shift();
      if (forced) return respond(forced, { error_code: "ERR_NGROK_500", status_code: forced, msg: `internal (key ${key})` });
      events.push(`release ${del[1]}`);
      tally.reserved.delete(del[1]);
      return respond(204, null);
    }
    return respond(404, { msg: "unknown" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    tally,
    url: `http://127.0.0.1:${server.address().port}`,
    shut: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** The global event stream as text - `shut()` belongs in the finally (open readers hold server.close up). */
function streamWith(base) {
  let text = "", rest = "";
  const events = [];
  const req = http.get(`${base}/api/events`, (res) => {
    res.setEncoding("utf8");
    res.on("data", (c) => {
      text += c;
      rest += c;
      let i;
      while ((i = rest.indexOf("\n\n")) >= 0) {
        const block = rest.slice(0, i);
        rest = rest.slice(i + 2);
        for (const z of block.split("\n")) if (z.startsWith("data: ")) { try { events.push(JSON.parse(z.slice(6))); } catch { /* heartbeat */ } }
      }
    });
  });
  req.on("error", () => {});
  return { events, text: () => text, shut: () => req.destroy() };
}

// A request: status, body (text AND JSON) and Cache-Control - `Connection: close` (no dead socket after restart()).
async function calls(base, filePath, { method = "GET", body } = {}) {
  const res = await fetch(`${base}${filePath}`, {
    method,
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, text, json, cache: res.headers.get("cache-control") };
}

/** The whole setup: server, fake SDK, fake API, a project with a service (port 3000) and one without a port. */
async function withPreview(fn) {
  const events = [];
  const fake = fakeSdk(events);
  const ngapi = await fakeApi(events);
  const prior = process.env.CBASE_NGROK_API;
  process.env.CBASE_NGROK_API = ngapi.url;
  setNgrokSdk(fake.sdk);
  // Capture the log: the server runs in this process - what it logs lands here. It is passed on anyway.
  const log = [];
  const real = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(real)) console[k] = (...a) => { log.push(a.map(String).join(" ")); real[k](...a); };
  try {
    await withAgentsServer(async (ctx) => {
      const project = await ctx.projectWithoutInstance({ name: "Kasse Süd", path: path.join(ctx.root, "till") });
      const web = store.addProjectService(project.id, { name: "Web-Frontend", kind: "frontend", port: 3000 });
      const withoutPort = store.addProjectService(project.id, { name: "Worker", kind: "worker", port: null });
      // One stream per server run: restart() tears the old one down - `newStream()` afterwards.
      const streams = [];
      const newStream = async () => {
        const st = streamWith(ctx.base);
        streams.push(st);
        await waitForTruthy(() => st.events.some((e) => e.type === "init"), "event stream connected");
        return st;
      };
      const stream = await newStream();
      try {
        await fn({ ...ctx, project, web, withoutPort, fake, ngapi, events, stream, newStream, log, R: (filePath, o) => calls(ctx.base, filePath, o) });
        await previewPostWork();
        // Exactly one rewrite proxy per open listener - no port stays without a link (not even after a failed open).
        assert.equal(openProxies(), fake.openListener().length, "one proxy per listener, no more");
        // No access value in the event stream - read only after a marker in the live stream (everything up to it has arrived).
        await ctx.barrier(streams.at(-1), GLOBAL);
        for (const st of streams) assert.equal(withValue(st.text()), undefined, "no access value in the event stream");
        // ... and none in the log.
        const leaked = log.find((z) => withValue(z));
        assert.equal(leaked, undefined, `no access value in the log: ${String(leaked).slice(0, 200)}`);
      } finally {
        for (const st of streams) st.shut();
      }
    });
  } finally {
    Object.assign(console, real);
    await sessionClosed();
    setNgrokSdk(null);
    if (prior === undefined) delete process.env.CBASE_NGROK_API; else process.env.CBASE_NGROK_API = prior;
    await ngapi.shut();
  }
}

/** A second project with a service in the test's workspace (via the store like `projectWithoutInstance`). */
function projectWithService(ws, root) {
  const project = projectWithoutInstance({ workspaceId: ws.id, name: "Warehouse", path: path.join(root, "warehouse") });
  return { project, service: store.addProjectService(project.id, { name: "Web", kind: "frontend", port: 4000 }) };
}

/** Try a TCP connection to `url`: "connected" or the error code. */
const connect = (url) => new Promise((r) => {
  const { hostname, port } = new URL(url);
  const s = net.connect(Number(port), hostname);
  s.on("connect", () => { s.destroy(); r("connected"); });
  s.on("error", (e) => r(e.code));
});

const link = (project, service, fields = {}) => ({ projectId: project.id, instance: null, serviceId: service.id, validDays: 7, ...fields });
const withoutValue = (r) => { assert.equal(withValue(r.text), undefined, `no access value in ${r.text.slice(0, 200)}`); return r; };

// ── (1) access ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(1) access: both keys required, a failed check stores nothing, no value goes back, no-store", async () => {
  await withPreview(async ({ R, fake, ngapi }) => {
    let r = withoutValue(await R("/api/integrations/ngrok"));
    assert.equal(r.status, 200);
    assert.equal(r.cache, "no-store");
    assert.deepEqual({ ...r.json, sdk: undefined }, { authtoken: false, apiKey: false, mode: "off", limit: 0, active: 0, checkedAt: null, error: "", sdk: undefined });
    assert.equal(r.json.sdk, true);

    for (const body of [{}, { authtoken: TOKEN }, { apiKey: null }, { authtoken: 5, apiKey: null }, { authtoken: null, apiKey: 7 }, []]) {
      r = withoutValue(await R("/api/integrations/ngrok", { method: "PUT", body }));
      assert.equal(r.status, 400, `PUT ${JSON.stringify(body)}`);
      assert.equal(r.cache, "no-store");
    }
    // A wrong authtoken: 400 CHECK, nothing stored (response and log without the rejected value).
    r = withoutValue(await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: TOK_WRONG, apiKey: null } }));
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "CHECK");
    assert.match(r.json.error, /ERR_NGROK_105/);
    assert.match(r.json.error, /Your authtoken: •••/, "the path was entered: the SDK named the value, the response carries it redacted");
    // Right authtoken, wrong key: both fail together - the token stays unstored too.
    r = withoutValue(await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: TOKEN, apiKey: KEY_WRONG } }));
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "CHECK");
    assert.match(r.json.error, /401/);
    assert.match(r.json.error, /invalid: •••/, "the API named the key, the response carries it redacted");
    assert.equal((await R("/api/integrations/ngrok")).json.authtoken, false, "a failed check stores nothing");
    assert.deepEqual(store.ngrokAccessRaw(), { authtoken: "", apiKey: "", checkedAt: null, error: "" });

    r = withoutValue(await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: TOKEN, apiKey: null } }));
    assert.equal(r.status, 200);
    assert.equal(r.json.mode, "dev");
    assert.equal(r.json.limit, 1);
    assert.ok(r.json.checkedAt > 0);
    assert.equal(fake.tally.open, 0, "the check session is closed again at once");
    r = withoutValue(await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: null, apiKey: KEY } }));
    assert.deepEqual([r.status, r.json.mode, r.json.limit, r.json.authtoken, r.json.apiKey], [200, "names", 3, true, true]);
    const check = ngapi.tally.requests.findLast((a) => a.method === "GET");
    assert.deepEqual([check.url, check.auth, check.version], ["/reserved_domains?limit=1", `Bearer ${KEY}`, "2"]);
    withoutValue(await R("/api/preview-links"));

    // "" deletes, null leaves - without active links both work.
    r = await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: null, apiKey: "" } });
    assert.deepEqual([r.status, r.json.mode, r.json.authtoken], [200, "dev", true]);
    r = await R("/api/integrations/ngrok", { method: "DELETE" });
    assert.deepEqual([r.status, r.json, r.cache], [200, { ok: true }, "no-store"]);
    assert.equal((await R("/api/integrations/ngrok")).json.mode, "off");
  });
});

// ── (2) dev ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(2) dev: without access 412, shape 400, without a port 400, opens without domain on the target, limit 1, revoke closes the session", async () => {
  await withPreview(async (ctx) => {
    const { R, project, web, withoutPort, fake, stream } = ctx;
    let r = await R("/api/preview-links", { method: "POST", body: link(project, web) });
    assert.deepEqual([r.status, r.json.code], [412, "WITHOUT_ACCESS"]);
    await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: TOKEN, apiKey: null } });

    for (const k of ["projectId", "instance", "serviceId", "validDays"]) {
      const body = link(project, web);
      delete body[k];
      r = await R("/api/preview-links", { method: "POST", body });
      assert.equal(r.status, 400, `without ${k}`);
      assert.match(r.json.error, new RegExp(`„${k}“ fehlt`));
    }
    for (const bad of [{ validDays: 2 }, { serviceId: "1" }, { instance: "" }, { projectId: "" }]) {
      r = await R("/api/preview-links", { method: "POST", body: link(project, web, bad) });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    r = await R("/api/preview-links", { method: "POST", body: link(project, withoutPort) });
    assert.deepEqual([r.status, r.json.code], [400, "WITHOUT_PORT"]);
    r = await R("/api/preview-links", { method: "POST", body: link(project, web, { projectId: "exists-not" }) });
    assert.equal(r.status, 404);
    r = await R("/api/preview-links", { method: "POST", body: link(project, web, { instance: "main" }) });
    assert.equal(r.status, 404, "without a project container there is no instance \"main\"");
    assert.equal(store.previewLinksActive().length, 0, "no rejected request leaves a row");

    const prior = Date.now();
    r = withoutValue(await R("/api/preview-links", { method: "POST", body: link(project, web) }));
    assert.equal(r.status, 201);
    assert.equal(r.cache, "no-store");
    const l = r.json;
    assert.deepEqual({ ...l, id: undefined, createdAt: undefined, runningSinceAt: undefined }, {
      id: undefined, projectId: project.id, projectName: "Kasse Süd", instance: null, serviceId: web.id, serviceName: "Web-Frontend", port: 3000,
      mode: "dev", url: DEV_URL, state: "online", error: "", createdAt: undefined, runningSinceAt: undefined, endedAt: null, endedReason: null,
    });
    assert.ok(l.createdAt >= prior && l.runningSinceAt === l.createdAt + 7 * DAY);
    assert.equal(fake.openListener().length, 1);
    assert.equal(fake.openListener()[0].domain, undefined, "dev: NO .domain()");
    assert.equal(fake.openListener()[0].target, "http://127.0.0.1:3000", "the proxy forwards to the service");
    const forward = fake.openListener()[0].forward;
    assert.match(forward, /^http:\/\/127\.0\.0\.1:\d+$/, "the listener forwards to the rewrite proxy, not to the service");
    assert.equal(await connect(forward), "connected", "the proxy listens");
    assert.equal(fake.openListener()[0].metadata, `cbase-preview:${l.id}`);

    r = await R("/api/preview-links", { method: "POST", body: link(project, web) });
    assert.deepEqual([r.status, r.json.code], [409, "LIMIT"]);
    assert.match(r.json.error, /Free-Plan: ein Link zur Zeit/);

    // Deleting with an active link: 409 with the count.
    r = await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: "", apiKey: null } });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /1 aktiver Link/);
    assert.equal((await R("/api/integrations/ngrok", { method: "DELETE" })).status, 409);

    let list = withoutValue(await R("/api/preview-links")).json;
    assert.deepEqual([list.active.length, list.history.length, list.mode, list.limit, list.sdk], [1, 0, "dev", 1, true]);

    r = await R(`/api/preview-links/${l.id}`, { method: "DELETE" });
    assert.deepEqual([r.status, r.json.state, r.json.endedReason, r.cache], [200, "ended", "revoke", "no-store"]);
    assert.equal(fake.openListener().length, 0, "the revoke closes the listener");
    assert.equal(await connect(forward), "ECONNREFUSED", "... and the proxy behind it");
    assert.equal(fake.tally.open, 0, "after the last revoke the session is closed");
    r = await R(`/api/preview-links/${l.id}`, { method: "DELETE" });
    assert.deepEqual([r.status, r.json.state], [200, "ended"], "a second revoke is 200");
    assert.equal((await R("/api/preview-links/exists-not", { method: "DELETE" })).status, 404);

    // ERR_NGROK_334: the dev address is occupied by another agent.
    fake.tally.openFails.push("failed to start tunnel: The endpoint 'https://test-dev-address.ngrok-free.dev' is already online. ERR_NGROK_334");
    r = withoutValue(await R("/api/preview-links", { method: "POST", body: link(project, web, { validDays: null }) }));
    assert.deepEqual([r.status, r.json.code], [502, "NGROK"]);
    assert.ok(r.json.error.startsWith(OCCUPIED_SENTENCE), r.json.error);
    assert.deepEqual([r.json.link.state, r.json.link.endedReason], ["ended", "error"]);
    assert.equal(store.previewLinksActive().length, 0);
    assert.equal(fake.tally.open, 0, "no active link - the session is closed");
    list = (await R("/api/preview-links")).json;
    assert.deepEqual(list.history.map((x) => x.endedReason), ["error", "revoke"], "history: newest first");

    await ctx.barrier(stream, GLOBAL);
    const changeover = stream.events.filter((e) => e.type === "preview/link" && e.link.id === l.id).map((e) => e.link.state);
    assert.deepEqual(changeover, ["start", "online", "ended"], "every state change goes out via SSE");
  });
});

// ── (3) names ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(3) names: reserve -> open, three links ONE session, 4th link 409, collision, open fails => released, release made up for", async () => {
  await withPreview(async ({ R, project, web, fake, ngapi, events }) => {
    await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: TOKEN, apiKey: KEY } });
    events.length = 0;
    const links = [];
    for (let i = 0; i < 3; i++) {
      const r = withoutValue(await R("/api/preview-links", { method: "POST", body: link(project, web) }));
      assert.equal(r.status, 201, r.text);
      links.push(r.json);
    }
    for (const [i, l] of links.entries()) {
      const domain = new URL(l.url).hostname;
      assert.match(domain, /^kasse-sued-[a-z0-9]{6}\.ngrok\.app$/);
      assert.equal(l.mode, "names");
      assert.deepEqual(events.slice(2 * i, 2 * i + 2), [`reserve ${domain}`, `open ${domain}`], "first reserve, then open");
    }
    assert.equal(new Set(links.map((l) => l.url)).size, 3);
    assert.equal(fake.tally.open, 1, "three links, ONE session");
    assert.equal(new Set(fake.openListener().map((e) => e.session)).size, 1);

    let r = await R("/api/preview-links", { method: "POST", body: link(project, web) });
    assert.deepEqual([r.status, r.json.code, r.json.error], [409, "LIMIT", "3 von 3 Links aktiv (ngrok Hobbyist)"]);
    r = await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: null, apiKey: "" } });
    assert.equal(r.status, 409, "deleting the API key with active names links");

    // Revoke: closes AND releases.
    r = await R(`/api/preview-links/${links[0].id}`, { method: "DELETE" });
    assert.equal(r.status, 200);
    assert.ok(events.includes(`close ${new URL(links[0].url).hostname}`));
    assert.ok(events.includes("release rd_1"));

    // Collision: the first reservation 400 => a new name.
    const posts = () => ngapi.tally.requests.filter((a) => a.method === "POST").length;
    let prior = posts();
    ngapi.tally.postFails.push(400);
    r = await R("/api/preview-links", { method: "POST", body: link(project, web) });
    assert.equal(r.status, 201, r.text);
    assert.equal(posts() - prior, 2, "one failed attempt, one hit");
    links.push(r.json);

    // Open fails => the reserved name is released.
    await R(`/api/preview-links/${links[1].id}`, { method: "DELETE" });
    fake.tally.openFails.push("failed to bind: ERR_NGROK_9009");
    prior = posts();
    r = withoutValue(await R("/api/preview-links", { method: "POST", body: link(project, web) }));
    assert.deepEqual([r.status, r.json.code], [502, "NGROK"]);
    assert.match(r.json.error, /ERR_NGROK_9009/);
    assert.equal(openProxies(), fake.openListener().length, "a failed open closes its rewrite proxy again");
    const failed = store.previewLink(r.json.link.id);
    assert.ok(failed.ngrokDomainId && failed.approvedAt, "reserved and released again");
    assert.ok(events.includes(`release ${failed.ngrokDomainId}`));
    assert.equal(store.ngrokAccessRaw().error.includes("ERR_NGROK_9009"), true, "the last error stands at the access");

    // Open AND release fail => checkProcedure makes up for the release.
    fake.tally.openFails.push("failed to bind: ERR_NGROK_9009");
    ngapi.tally.deleteFails.push(500);
    r = await R("/api/preview-links", { method: "POST", body: link(project, web) });
    assert.equal(r.status, 502);
    const open = store.previewLink(r.json.link.id);
    assert.ok(open.ngrokDomainId && !open.approvedAt, "release pending");
    const later = await checkProcedure(Date.now());
    assert.deepEqual(later.approved, [open.id]);
    assert.ok(store.previewLink(open.id).approvedAt);

    for (const l of store.previewLinksActive()) assert.equal((await R(`/api/preview-links/${l.id}`, { method: "DELETE" })).status, 200);
    assert.equal(fake.tally.open, 0, "after the last revoke the session is closed");
    assert.equal(fake.openListener().length, 0);
    assert.equal(store.previewLinksWithoutApproval().length, 0, "every reservation is released");
  });
});

// ── (4) expiry ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(4) checkProcedure(t) ends exactly the expired links - unlimited never", async () => {
  await withPreview(async ({ R, project, web }) => {
    await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: TOKEN, apiKey: KEY } });
    const now = Date.now();
    const id = async (validDays) => (await R("/api/preview-links", { method: "POST", body: link(project, web, { validDays }) })).json.id;
    const one = await id(1), thirty = await id(30), always = await id(null);
    assert.deepEqual((await checkProcedure(now)).expired, []);
    assert.deepEqual((await checkProcedure(now + 2 * DAY)).expired, [one]);
    assert.deepEqual([store.previewLink(one).endedReason, store.previewLink(one).endedAt], ["expired", now + 2 * DAY]);
    assert.deepEqual((await checkProcedure(now + 31 * DAY)).expired, [thirty]);
    assert.deepEqual((await checkProcedure(now + 3650 * DAY)).expired, []);
    assert.deepEqual(store.previewLinksActive().map((l) => l.id), [always]);
    await R(`/api/preview-links/${always}`, { method: "DELETE" });
  });
});

test("(4b) fallback net: project or service deleted WITHOUT an observer - the tick ends the link (listener closed, name released), the row stays", async () => {
  await withPreview(async ({ R, ws, project, web, fake, events, root }) => {
    await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: TOKEN, apiKey: KEY } });
    const second = store.addProjectService(project.id, { name: "API", kind: "backend", port: 8000 });
    const a = (await R("/api/preview-links", { method: "POST", body: link(project, second) })).json;
    const other = projectWithService(ws, root);
    const b = (await R("/api/preview-links", { method: "POST", body: link(other.project, other.service) })).json;
    const c = (await R("/api/preview-links", { method: "POST", body: link(project, web) })).json;
    assert.deepEqual([a.state, b.state, c.state], ["online", "online", "online"]);
    // Detach the observer (the immediate ending is checked by (8)) - so this test checks only the fallback net in the tick.
    store.setTargetRemovedObserver(null);
    try {
      assert.equal(store.deleteProjectService(second.id), true);
      assert.equal(store.deleteProject(ws.id, other.project.id), true);
    } finally {
      // Deliberately NOT re-attached: the next test starts its own server, and startServer attaches it - re-attaching here
      // would hide the sabotage for (8) in the counter-test (hookup in server.js removed).
      store.setTargetRemovedObserver(null);
    }
    assert.equal(store.previewLink(a.id).endedAt, null, "without an observer the link waits for the tick");
    const r = await checkProcedure(Date.now());
    assert.deepEqual(r.orphaned.sort(), [a.id, b.id].sort());
    for (const [l, set] of [[a, /Service deleted/], [b, /Project deleted/]]) {
      const z = store.previewLink(l.id);
      assert.deepEqual([z.state, z.endedReason], ["ended", "error"]);
      assert.match(z.error, set);
      assert.ok(z.approvedAt && events.includes(`release ${z.ngrokDomainId}`), "name released");
    }
    assert.deepEqual(fake.openListener().map((e) => e.metadata), [`cbase-preview:${c.id}`], "only the link with a target stays open");
    assert.equal((await R(`/api/preview-links/${c.id}`, { method: "DELETE" })).status, 200);
  });
});

// ── (5) post-start ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("(5) post-start: the same name without a new reservation, `start` without url is ended, failed reopen => error => tick", async () => {
  await withPreview(async (ctx) => {
    const { R, project, web, fake, ngapi, events } = ctx;
    await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: TOKEN, apiKey: KEY } });
    const a = (await R("/api/preview-links", { method: "POST", body: link(project, web) })).json;
    const b = (await R("/api/preview-links", { method: "POST", body: link(project, web) })).json;
    // An aborted creation: row `start` with a reservation, without url (the process died between reserving and opening).
    store.createPreviewLink({ id: "aborted", projectId: project.id, instance: null, serviceId: web.id, port: 3000, mode: "names", createdAt: Date.now(), runningSinceAt: null });
    store.changePreviewLink("aborted", { ngrokDomainId: "rd_old" });

    await previewServerEnd(); // what the "serverEnd" hook does: session closed, rows stay
    assert.equal(fake.tally.open, 0);
    await ctx.restart();
    await ctx.newStream();
    const posts = ngapi.tally.requests.filter((x) => x.method === "POST").length;
    events.length = 0;
    fake.tally.openFails.push("reconnect failed: ERR_NGROK_3200"); // hits the reopen of a

    await reinstate();
    assert.equal(ngapi.tally.requests.filter((x) => x.method === "POST").length, posts, "NO new reservation");
    const existing = store.previewLink(a.id), db = store.previewLink(b.id);
    assert.deepEqual([existing.state, existing.url], ["error", a.url]);
    assert.match(existing.error, /ERR_NGROK_3200/);
    assert.deepEqual([db.state, db.url], ["online", b.url]);
    assert.ok(events.includes(`open ${new URL(b.url).hostname}`), "the same name");
    const from = store.previewLink("aborted");
    assert.deepEqual([from.state, from.endedReason], ["ended", "error"]);
    assert.ok(from.approvedAt && events.includes("release rd_old"), "the reservation of the aborted creation is released");

    // The next tick reopens the link in `error` - on its name.
    const r = await checkProcedure(Date.now());
    assert.deepEqual(r.reopened, [a.id]);
    assert.deepEqual([store.previewLink(a.id).state, store.previewLink(a.id).url], ["online", a.url]);
    assert.ok(events.includes(`open ${new URL(a.url).hostname}`));
    assert.equal(fake.tally.open, 1, "ONE session even after the restart");
    for (const l of store.previewLinksActive()) await R(`/api/preview-links/${l.id}`, { method: "DELETE" });
    assert.equal(fake.tally.open, 0);
  });
});

// ── (6) target ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(6) targetFor: instance IP (IPv6 bracketed), unknown 404, without IP 409, null for a relocated project 400, otherwise 127.0.0.1", () => {
  const targets = {
    "p1/main": { identifier: "p1/main", ip: "10.230.2.2" },
    "p1/k1": { identifier: "p1/k1", ip: "" },
    "p6/main": { identifier: "p6/main", ip: "::1" },
  };
  const target = (k) => targets[k] || null;
  assert.equal(targetFor({ projectId: "p1", instance: "main", port: 3000 }, { target }), "http://10.230.2.2:3000");
  assert.equal(targetFor({ projectId: "p6", instance: "main", port: 3000 }, { target }), "http://[::1]:3000");
  assert.equal(targetFor({ projectId: "p2", instance: null, port: 5173 }, { target }), "http://127.0.0.1:5173");
  const error = (f) => { try { f(); } catch (e) { assert.ok(e instanceof PreviewError); return [e.status, e.code]; } return null; };
  assert.deepEqual(error(() => targetFor({ projectId: "p1", instance: "exists-not", port: 1 }, { target })), [404, "INSTANCE"]);
  assert.deepEqual(error(() => targetFor({ projectId: "p1", instance: "k1", port: 1 }, { target })), [409, "WITHOUT_IP"]);
  assert.deepEqual(error(() => targetFor({ projectId: "p1", instance: null, port: 1 }, { target })), [400, "INSTANCE"]);
});

// ── (7) no MCP route ────────────────────────────────────────────────────────────────────────────────────────────────────

test("(7) no MCP tool calls the routes, and the API fence has no row for them (403 from a project network)", () => {
  const MCP = path.join(HERE, "../electron/mcp");
  const files = [];
  const run = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) run(p); else if (n.name.endsWith(".js")) files.push(p); } };
  run(MCP);
  assert.ok(files.length > 5, `MCP files found (${files.length})`);
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    assert.ok(!/preview-links|integrations\/ngrok/.test(text), `${path.relative(MCP, f)} calls a preview route`);
  }
  for (const [m, p] of [["GET", "/api/preview-links"], ["POST", "/api/preview-links"], ["DELETE", "/api/preview-links/x"],
    ["GET", "/api/integrations/ngrok"], ["PUT", "/api/integrations/ngrok"], ["DELETE", "/api/integrations/ngrok"]]) {
    assert.equal(rowFor(m, p), null, `${m} ${p} has no fence row`);
  }
});

// ── (8) deletion paths end at once, the tick catches the rest ──────────────────────────────────────────────────────────────

/** The operating mark for the duration of `fn` (instanceTarget only answers with it) - reset in the finally. */
async function inOps(fn) {
  const saved = { CBASE_CONTAINER: process.env.CBASE_CONTAINER, CBASE_DIND: process.env.CBASE_DIND };
  Object.assign(process.env, { CBASE_CONTAINER: "1", CBASE_DIND: "1" });
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("(8) instance, service, project deleted => link ended at once, listener closed; tick: instance gone, new IP, without IP, relocated", async () => {
  await withPreview(async ({ R, ws, root, project, web, fake, events }) => inOps(async () => {
    await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: TOKEN, apiKey: KEY } });
    const api = store.addProjectService(project.id, { name: "API", kind: "backend", port: 8000 });
    store.createProjectInstance({ projectId: project.id, instance: "main", state: "ready", convertedAt: Date.now(), ip: "10.230.5.2" });
    store.createProjectInstance({ projectId: project.id, instance: "copy-a", state: "ready", ip: "10.230.6.2" });
    const fresh = async (fields, p = project, d = web) => {
      const r = await R("/api/preview-links", { method: "POST", body: link(p, d, fields) });
      assert.equal(r.status, 201, r.text);
      return r.json;
    };
    const open = () => Object.fromEntries(fake.openListener().map((e) => [e.metadata.replace("cbase-preview:", ""), e.target]));
    const a = await fresh({ instance: "copy-a" });
    const b = await fresh({ instance: "main" });
    const c = await fresh({ instance: "main" }, project, api);
    assert.deepEqual(open(), { [a.id]: "http://10.230.6.2:3000", [b.id]: "http://10.230.5.2:3000", [c.id]: "http://10.230.5.2:8000" });

    // Instance removed: ended BEFORE deleteProjectInstance returns - no await, no tick in between.
    assert.equal(store.deleteProjectInstance(project.id, "copy-a"), 1);
    let z = store.previewLink(a.id);
    assert.deepEqual([z.state, z.endedReason, z.error], ["ended", "error", INSTANCE_GONE_SENTENCE], "instance removed: ended at once, without a tick");
    await previewPostWork();
    assert.ok(!(a.id in open()), "the copy's listener is closed");
    z = store.previewLink(a.id);
    assert.ok(z.approvedAt && events.includes(`release ${z.ngrokDomainId}`), "name released");

    // Service deleted: the same.
    assert.equal(store.deleteProjectService(api.id), true);
    z = store.previewLink(c.id);
    assert.deepEqual([z.state, z.error], ["ended", SERVICE_GONE_SENTENCE], "service deleted: ended at once");
    await previewPostWork();
    assert.deepEqual(Object.keys(open()), [b.id]);

    // Tick: the same instance with a new IP => reopened on the new target, same name.
    store.changeProjectInstance(project.id, "main", { ip: "10.230.9.2" });
    let r = await checkProcedure(Date.now());
    assert.deepEqual([r.redirected, r.orphaned], [[b.id], []]);
    assert.deepEqual(open(), { [b.id]: "http://10.230.9.2:3000" }, "the old listener is closed, the new one points to the new IP");
    assert.deepEqual([store.previewLink(b.id).state, store.previewLink(b.id).url], ["online", b.url]);
    assert.deepEqual((await checkProcedure(Date.now())).redirected, [], "same target: nothing");

    // Without IP => listener closed, `error`; with IP => open again.
    store.changeProjectInstance(project.id, "main", { ip: "" });
    r = await checkProcedure(Date.now());
    assert.deepEqual(r.withoutTarget, [b.id]);
    assert.deepEqual(open(), {});
    assert.equal(store.previewLink(b.id).state, "error");
    store.changeProjectInstance(project.id, "main", { ip: "10.230.9.2" });
    r = await checkProcedure(Date.now());
    assert.deepEqual(r.reopened, [b.id]);
    assert.deepEqual(open(), { [b.id]: "http://10.230.9.2:3000" });

    // Fallback net: without an observer the link stays after the deletion - the tick ends it (instance gone).
    store.setTargetRemovedObserver(null);
    try {
      store.deleteProjectInstance(project.id); // all instances
      assert.equal(store.previewLink(b.id).endedAt, null, "without an observer the link waits for the tick");
      r = await checkProcedure(Date.now());
      assert.deepEqual(r.orphaned, [b.id]);
      assert.equal(store.previewLink(b.id).error, INSTANCE_GONE_SENTENCE);
    } finally {
      store.setTargetRemovedObserver(targetRemoved);
    }
    assert.deepEqual(open(), {});

    // A link WITHOUT an instance (127.0.0.1 in B) - the project relocates => the tick ends it.
    const d = await fresh({ instance: null });
    assert.equal(open()[d.id], "http://127.0.0.1:3000");
    store.createProjectInstance({ projectId: project.id, instance: "main", state: "ready", convertedAt: Date.now(), ip: "10.230.5.2" });
    r = await checkProcedure(Date.now());
    assert.deepEqual(r.orphaned, [d.id]);
    assert.equal(store.previewLink(d.id).error, RELOCATED_SET);

    // All instances at once (without `instance`): every link of an instance of the project.
    const e = await fresh({ instance: "main" });
    store.deleteProjectInstance(project.id);
    assert.deepEqual([store.previewLink(e.id).state, store.previewLink(e.id).error], ["ended", INSTANCE_GONE_SENTENCE]);

    // Project deleted (one WITHOUT an instance row): at once.
    const other = projectWithService(ws, root);
    const f = await fresh({ instance: null }, other.project, other.service);
    assert.equal(store.deleteProject(ws.id, other.project.id), true);
    assert.deepEqual([store.previewLink(f.id).state, store.previewLink(f.id).error], ["ended", PROJECT_GONE_SENTENCE], "project deleted: ended at once");
    await previewPostWork();
    assert.deepEqual(open(), {}, "no listener open any more");
    assert.equal(fake.tally.open, 0, "and the session is closed");
    assert.equal(store.previewLinksWithoutApproval().length, 0, "every name is released");
  }));
});

// ── (9) no access value, not even in the error text ─────────────────────────────────────────────────────────────────────────

test("(9) ngrok names the value in the error - neither response, access, link, stream nor log carry it", async () => {
  await withPreview(async ({ R, project, web, fake, ngapi, log }) => {
    await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: TOKEN, apiKey: KEY } });
    // Reserving fails with 500 (no re-roll), the API's message names the key.
    ngapi.tally.postFails.push(500);
    let r = withoutValue(await R("/api/preview-links", { method: "POST", body: link(project, web) }));
    assert.deepEqual([r.status, r.json.code], [502, "NGROK"]);
    assert.match(r.json.error, /key •••/, "the API named the key - redacted");
    // Opening fails, the SDK's message names the authtoken.
    fake.tally.openFails.push("failed to start tunnel: ERR_NGROK_107");
    r = withoutValue(await R("/api/preview-links", { method: "POST", body: link(project, web) }));
    assert.equal(r.status, 502);
    assert.match(r.json.error, /Your authtoken: •••/);
    // Opening AND release fail: the release message (with key) goes into the log.
    fake.tally.openFails.push("failed to bind: ERR_NGROK_9009");
    ngapi.tally.deleteFails.push(500);
    withoutValue(await R("/api/preview-links", { method: "POST", body: link(project, web) }));
    assert.ok(log.some((z) => z.includes("[preview] release") && z.includes("key •••")), "the release message is logged - redacted");
    const access = withoutValue(await R("/api/integrations/ngrok"));
    assert.match(access.json.error, /•••/, "ngrok_access.error carries the text - redacted");
    const tally = withoutValue(await R("/api/preview-links"));
    assert.equal(tally.json.history.length, 3);
    for (const l of tally.json.history) assert.match(l.error, /•••/, "the error per link - redacted");
    // A rejected authtoken while checking.
    r = withoutValue(await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: TOK_WRONG, apiKey: null } }));
    assert.equal(r.json.code, "CHECK");
    await checkProcedure(Date.now()); // makes up for the release
  });
});

// ── (10) release before deleting, lost reservation ─────────────────────────────────────────────────────────────────────────

test("(10) deleting key/access with an open release => 409 APPROVAL_OPEN, nothing deleted; lost reservation is cleaned up", async () => {
  await withPreview(async ({ R, project, web, ngapi, events, log }) => {
    await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: TOKEN, apiKey: KEY } });
    const l = (await R("/api/preview-links", { method: "POST", body: link(project, web) })).json;
    ngapi.tally.deleteFails.push(500);
    await R(`/api/preview-links/${l.id}`, { method: "DELETE" });
    assert.equal(store.previewLinksWithoutApproval().length, 1, "the release at the revoke failed");

    ngapi.tally.deleteFails.push(500);
    let r = await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: null, apiKey: "" } });
    assert.deepEqual([r.status, r.json.code, r.json.open, r.cache], [409, "APPROVAL_OPEN", 1, "no-store"]);
    assert.equal((await R("/api/integrations/ngrok")).json.apiKey, true, "the key is NOT deleted");
    ngapi.tally.deleteFails.push(500);
    r = await R("/api/integrations/ngrok", { method: "DELETE" });
    assert.deepEqual([r.status, r.json.code, r.json.open], [409, "APPROVAL_OPEN", 1]);
    assert.equal(store.ngrokAccessRaw().apiKey, KEY, "the access is NOT deleted");

    // The API answers again: deleting releases first, then deletes.
    r = await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: null, apiKey: "" } });
    assert.deepEqual([r.status, r.json.mode], [200, "dev"]);
    assert.equal(store.previewLinksWithoutApproval().length, 0);
    assert.equal(ngapi.tally.reserved.size, 0, "nothing stands at ngrok any more");

    // Without a key: `release` logs instead of silently returning false.
    store.createPreviewLink({ id: "without-key", projectId: project.id, instance: null, serviceId: web.id, port: 3000, mode: "names", createdAt: Date.now(), runningSinceAt: null });
    store.changePreviewLink("without-key", { ngrokDomainId: "rd_foreign" });
    store.endPreviewLink("without-key", { reason: "error", error: "Test" });
    assert.deepEqual((await checkProcedure(Date.now())).approved, []);
    assert.ok(log.some((z) => z.includes("rd_foreign") && z.includes("no API key stored")), "without a key: logged");
    // Without a stored key the 409 protects nothing any more: the access can be deleted.
    assert.equal((await R("/api/integrations/ngrok", { method: "DELETE" })).status, 200);

    // Lost response: the reservation arises, the response never comes - searched for and released.
    await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: TOKEN, apiKey: KEY } });
    ngapi.tally.postLost = 1;
    r = await R("/api/preview-links", { method: "POST", body: link(project, web) });
    assert.deepEqual([r.status, r.json.code], [502, "NGROK"]);
    assert.equal(ngapi.tally.reserved.size, 0, "the lost reservation is released at ngrok again");
    assert.ok(ngapi.tally.requests.some((a) => a.url === "/reserved_domains?limit=100"), "searched for");
    assert.ok(events.filter((e) => e.startsWith("release rd_")).length >= 2, "released");
  });
});

// ── (11) the contract ───────────────────────────────────────────────────────────────────────────────────────────────────

test("(11) responses and SSE carry exactly the keys of the contract; the CHECK clauses the same value sets", async () => {
  await withPreview(async ({ R, project, web, stream, barrier }) => {
    let r = await R("/api/integrations/ngrok");
    assert.deepEqual(Object.keys(r.json), [...ACCESS_FIELDS], "GET ngrok");
    r = await R("/api/integrations/ngrok", { method: "PUT", body: { authtoken: TOKEN, apiKey: null } });
    assert.deepEqual(Object.keys(r.json), [...ACCESS_FIELDS], "PUT ngrok");
    const l = (await R("/api/preview-links", { method: "POST", body: link(project, web) })).json;
    assert.deepEqual(Object.keys(l), [...LINK_FIELDS], "POST");
    const tally = (await R("/api/preview-links")).json;
    assert.deepEqual(Object.keys(tally), [...STATUS_FIELDS], "GET Liste");
    assert.deepEqual(Object.keys(tally.active[0]), [...LINK_FIELDS]);
    r = await R(`/api/preview-links/${l.id}`, { method: "DELETE" });
    assert.deepEqual(Object.keys(r.json), [...LINK_FIELDS], "DELETE");
    assert.deepEqual(Object.keys((await R("/api/preview-links")).json.history[0]), [...LINK_FIELDS]);
    await barrier(stream, GLOBAL);
    const sse = stream.events.filter((e) => e.type === SSE_TYPE);
    assert.ok(sse.length >= 3);
    for (const e of sse) assert.deepEqual(Object.keys(e.link), [...LINK_FIELDS], "SSE");
  });
  // The table's CHECK clauses (store/ does not import the contract - store/ is domain-free).
  const source = fs.readFileSync(path.join(HERE, "../electron/server/store/preview-links.js"), "utf8");
  const check = (column) => {
    const m = new RegExp(`CHECK \\((?:${column} IS NULL OR )?${column} IN \\(([^)]*)\\)`).exec(source);
    assert.ok(m, `CHECK for ${column}`);
    return m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, ""));
  };
  assert.deepEqual(check("mode"), MODES.filter((x) => x !== "off"));
  assert.deepEqual(check("state"), [...STATES]);
  assert.deepEqual(check("ended_reason"), [...ENDED_REASONS]);
});
