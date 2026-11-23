// cbase gateway — the control plane of client/server operation.
// Tasks: cbase login (cookie sessions), user administration (admin), container per user (ensure/stop/destroy), reverse proxy
// /api/* → container, serving the shared web UI (web/out). No external dependencies — only Node built-ins.
// The administration: users and the resources of their containers under /gw/admin/*; the UI is Settings → Administration in web
// and iOS.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as users from "./users.js";
import { ensureSetupToken, removeSetupToken, setupTokenMatches } from "./setup-token.js";
import { startupWarnings } from "./startup-warnings.js";
import { buildStampReader, infoVersionFields } from "./build-info.js";
import * as containers from "./containers.js";
import { proxyRequest, activeStreams, trackStream, passThroughUpgradeResponse, closeStreams } from "./proxy.js";
import { pushConfiguration, sendTestPush, unwatchBackend, watchBackend } from "./push.js";
import {
  deviating, lastAdmin, userView, checkAccountDelete, checkCreate, checkPassword, checkPatch, checkResources, ramUnderConsumption, resourcesFields,
  writeDesiredFile, lowersRam, serverView, templateFromEnvironment, valuesFromInspect,
} from "./resources.js";
import { ACCOUNT_DELETE_PATH, CONTAINER_ACTIONS, ADMINISTRATION_JUMP } from "./administration-contract.js";
import {
  requestUrl, clientAddress, installErrorPolicy, loginBrake, parseCookies as cookiesFrom, checkSlots,
} from "./outerShell.js";

// An unhandled rejection is reported and does not end the gateway — the reasoning is in outerShell.js installErrorPolicy. A
// synchronous throw from an event still ends it; the answer to that is listeners at the seams (upgrade socket, read stream of the
// web UI).
installErrorPolicy();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.GW_PORT || 7719);
const HOST = process.env.GW_HOST || "127.0.0.1"; // production: 0.0.0.0 (behind TLS termination)
const DATA_DIR = process.env.GW_DATA || path.join(__dirname, "data");
const WEB_DIR = process.env.GW_WEB_DIR || path.resolve(__dirname, "..", "..", "web", "out");
const IDLE_STOP_MIN = Number(process.env.GW_IDLE_STOP_MIN || 0); // 0 = never put to sleep
const SECURE = process.env.GW_SECURE === "1";
const COOKIE = "cbase_gw";
// The product version (one for the whole tree, tools/version.mjs): read from the package.json shipped next to this file.
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
// What the server runs: the build stamp of the live release (build-info.js) — the gateway lives in <root>/gateway/, the release in
// <root>/current/.
const readBuildStamp = buildStampReader(process.env.GW_BUILD_FILE || path.resolve(__dirname, "..", "current", "build.json"));

users.initUsers(DATA_DIR);
// First-time setup needs a token only the operator can read (setup-token.js): null once the first user exists.
let setupToken = users.countUsers() === 0 ? ensureSetupToken(DATA_DIR) : null;
// Every creation of a user container reads that user's limits from gateway.db (without a row: the unit applies).
containers.setResourcesSource((userId) => users.getResources(userId));

// ── Helpers ──────────────────────────────────────────────────────────────────
const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
};

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}

// Cookie parsing is in outerShell.js (a foreign cookie with `%` must not turn every request into a 500).
const parseCookies = (req) => cookiesFrom(req.headers.cookie);

// An error response that cannot itself throw: after the head was sent (proxy, web UI stream) `writeHead` throws — in an async
// handler's catch that would be the next unhandled rejection.
function errorResponse(res, code, obj) {
  if (res.headersSent || res.destroyed || res.writableEnded) { try { res.destroy(); } catch {} return; }
  try { send(res, code, obj); } catch { try { res.destroy(); } catch {} }
}

function setSessionCookie(res, token) {
  const attrs = [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${30 * 24 * 3600}`];
  if (SECURE) attrs.push("Secure");
  res.setHeader("set-cookie", attrs.join("; "));
}
const clearSessionCookie = (res) =>
  res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE ? "; Secure" : ""}`);

const sessionOf = (req) => users.getSession(parseCookies(req)[COOKIE]);

// Login brake: per REAL client address and per user name, only failures count — rules and limits in outerShell.js loginBrake. IPv6
// per /64, the proof in gateway.db (survives restarts), scrypt asynchronous and at most two checks at once.
const brake = loginBrake({ storage: users.loginProbation });
const checks = checkSlots(2);
setInterval(() => brake.sweep(), 5 * 60_000).unref();

// Activity per user (for the idle reaper).
const lastActivity = new Map();
const touch = (uid) => lastActivity.set(uid, Date.now());
// No container for a locked or deleted user — deleting locks FIRST (users.lockUser), then tears down. A request that already
// passed authentication and the schedule wakeup get no further here; a start already running is awaited by containers.destroy.
// The event-stream observer only for an active user.
async function ensureBackend(userId) {
  if (!users.isActive(userId)) throw new Error("User locked or deleted");
  const ready = await containers.ensureRunning(userId);
  if (users.isActive(userId)) watchBackend(userId, ready.port);
  return ready;
}

// The setup token, printed like at startup — at start and when the last user is gone (self-deletion of the sole user).
function announceSetupToken() {
  if (!setupToken) return;
  // A token the operator set in the environment is already known to them; it is not written to the log.
  console.log(setupToken.source === "GW_SETUP_TOKEN"
    ? "[gateway] First-time setup: no user yet — the setup form asks for the token from GW_SETUP_TOKEN"
    : `[gateway] First-time setup: no user yet — the setup form asks for this token: ${setupToken.token} (from ${setupToken.source})`);
}

// ── Deleting a user: ONE teardown path ─────────────────────────────
// For the admin's DELETE and for the self-deletion (POST /gw/account/delete). Lock FIRST (sessions drop, login and ensureBackend
// refuse), then tear down — otherwise destroy would run with valid sessions, and a request in that window would create a new B
// (orphaned, with the old home if purge=0) while the answer said `purged:true`. The row is deleted only when the container is REALLY
// gone (and with purge the volumes); otherwise it stays locked, and the same delete can be repeated. Everything up to the first await
// runs synchronously in the caller's turn — when the call returns its promise, sessions and streams are already gone.
// Returns `{ ok: true }` or `{ error: "container" | "volumes" }`.
async function eraseUser(userId, { purge }) {
  users.lockUser(userId);
  unwatchBackend(userId);
  closeStreams(userId); // open tunnels and event streams drop with the sessions
  const report = await containers.destroy(userId, { purge });
  unwatchBackend(userId); // a start that was already running before the lock may have registered it again
  if (!report.containerAway) return { error: "container" };
  if (purge && !report.volumesGone) return { error: "volumes" };
  users.deleteUser(userId);
  writeDesired();
  // The last user is gone: the gateway is back in its first-time state — the setup needs the token again (setup-token.js).
  if (users.countUsers() === 0 && !setupToken) { setupToken = ensureSetupToken(DATA_DIR); announceSetupToken(); }
  return { ok: true };
}

// The self-deletion runs in the background (the purge may outlast the tunnel's ~100 s limit); its row is marked
// (users.requestErase), so a failed or interrupted erasure is retried at every start and in the periodic tick below. One run per
// user at a time.
const erasing = new Set();
// A teardown that keeps failing is retried every tick; its warning is written once per row and hour, not once a minute.
const INCOMPLETE_WARNING_GAP_MS = 60 * 60_000;
const incompleteWarnedAt = new Map(); // userId → when the "incomplete" warning was last written
function eraseInBackground(userId) {
  if (erasing.has(userId)) return;
  erasing.add(userId);
  eraseUser(userId, { purge: true })
    .then((r) => {
      if (r.ok) {
        incompleteWarnedAt.delete(userId);
        console.log(`[gateway] Account ${userId} deleted by its owner (container and both volumes removed)`);
        return;
      }
      const now = Date.now();
      if (now - (incompleteWarnedAt.get(userId) ?? -Infinity) < INCOMPLETE_WARNING_GAP_MS) return;
      incompleteWarnedAt.set(userId, now);
      console.warn(`[gateway] Account deletion of ${userId} incomplete (${r.error === "container" ? "container" : "data volumes"} not removed) — stays locked, retried every tick (this warning at most once an hour)`);
    })
    .catch((e) => console.error(`[gateway] Account deletion of ${userId}:`, e?.message || e))
    .finally(() => erasing.delete(userId));
}
// `atStart`: the start names what it found (the line is the tests' proof that the START retried, not the tick).
function retryErasures({ atStart = false } = {}) {
  const ids = users.listEraseRequested();
  if (atStart && ids.length) console.log(`[gateway] Retrying ${ids.length} pending account deletion(s) at start`);
  for (const id of ids) eraseInBackground(id);
}

// ── Administration: resources per user container ──────────────────
// The computations are in resources.js (pure, guard resources.test.js), docker in containers.js; only the wiring is here.
const template = (spec = containers.hostSpecs()) => templateFromEnvironment(containers.UNIT_TEMPLATE, spec);

// `resources-desired.json` (for the operator's status check, the deploy tool's limits.mjs) after EVERY change and at every start. An error
// here stops no change: the row in gateway.db is the truth, the file only its imprint for the deploy.
function writeDesired() {
  try { writeDesiredFile(DATA_DIR, users.listResources(), containers.hostSpecs().threads); }
  catch (e) { console.error("[gateway] resources-desired.json:", e?.message || e); }
}

// The initial fill: every user without a row gets once what their container carries NOW (inspect), without a container the
// template — so rolling out changes no container. If docker does not answer, the user stays without a row (their creation then
// takes the unit as before) and is next on the next call. An admin who has saved in the meantime wins (users.supplementResources
// writes only where nothing is). Returns: the ids whose row was just created.
async function supplementMissingRows() {
  const spec = containers.hostSpecs();
  const fresh = [];
  for (const u of users.listUsers()) {
    if (users.getResources(u.id)) continue;
    let l;
    try { l = await containers.situation(u.id); } catch (e) { console.warn(`[gateway] Resources of ${u.id}: ${e?.message || e} — retrying later`); continue; }
    if (users.supplementResources(u.id, l.hostConfig ? valuesFromInspect(l.hostConfig, spec) : template(spec))) fresh.push(u.id);
  }
  if (fresh.length) writeDesired();
  return fresh;
}

// At start, align every container with a row to its stored value. The occasion is "no CPU upper limit": for `docker update` it is
// `--cpus <host threads>` (resources.js, head) — if the host gets more threads (planned upgrade 4 → 8), it has silently become a
// hard limit of 4, and a stopped container would carry it over every `docker start`. After a host restart the gateway restarts too,
// and here it is lifted. Only what `deviating` reports is aligned (the same computation as the administration's "deviates" marker),
// by the same route as a save (containers.applyResources: by id, swap 2 × RAM). Lowering RAM below a RUNNING container's
// consumption the start does not do either: the same rule as the PUT (against a measurement, otherwise not) — then a warning, and
// the row stays "deviating". Excluded are the rows the initial fill just took from exactly this container. Returns: how many were
// aligned.
// The alignment runs next to the first requests: an admin may save meanwhile (PUT …/resources saves AND applies itself). So the row
// from before the loop never counts, only the one freshly read after each wait — and if a save stored a new value during our own
// `docker update` (our update may arrive after the PUT's and overwrite it with the old one), the new one follows right behind.
// Otherwise the start would silently reset a just-saved value — the same bug as at the deploy swap.
const sameValues = (a, b) => a.ramGiB === b.ramGiB && a.cpuPrio === b.cpuPrio && (a.cpuMax ?? null) === (b.cpuMax ?? null);
async function sameLimitsFrom({ except = [] } = {}) {
  const { threads } = containers.hostSpecs();
  let measured; // ONE measurement for all, only when needed
  let aligned = 0;
  for (const { userId } of users.listResources()) {
    if (except.includes(userId)) continue;
    let l;
    try { l = await containers.situation(userId); } catch (e) { console.warn(`[gateway] Limits of ${userId}: ${e?.message || e} — not aligned`); continue; }
    let r = users.getResources(userId); // fresh after the wait (deleted ⇒ no row any more)
    if (!r || l.state === "missing" || !deviating(r, l.hostConfig, threads)) continue;
    if (l.state === "running" && lowersRam(r, l.hostConfig)) {
      if (measured === undefined) measured = await containers.consumptionPerContainer();
      r = users.getResources(userId); // and once more after the measurement
      if (!r || !deviating(r, l.hostConfig, threads)) continue;
      const reason = lowersRam(r, l.hostConfig) ? ramUnderConsumption(r, measured?.[l.id]?.ramBytes ?? null) : null;
      if (reason) { console.warn(`[gateway] Limits of ${userId} NOT aligned (the container deviates): ${reason}`); continue; }
    }
    try {
      await containers.applyResources(userId, r);
      const afterwards = users.getResources(userId);
      // A value a PUT stored it has also checked (lowering against a measurement) — it goes without a second measurement.
      if (afterwards && !sameValues(afterwards, r)) await containers.applyResources(userId, afterwards);
      aligned++;
    } catch (e) { console.warn(`[gateway] Limits of ${userId} not aligned: ${e?.message || e}`); }
  }
  return aligned;
}

// A user in the contract's shape (USER_FIELDS), measured for exactly this container.
async function userOf(userId, selfId) {
  const user = users.getUser(userId);
  if (!user) return null;
  const situation = await containers.situation(userId);
  const byKey = situation.state === "running" ? await containers.consumptionPerContainer() : null;
  return userView({ user, selfId, values: users.getResources(userId), situation, consumption: byKey?.[situation.id] ?? null, threads: containers.hostSpecs().threads });
}

// The response to a change that has already happened. If docker does not answer afterwards, that is a 502 saying so — not a 500
// with raw docker text that would look like a failed job (the contract has no "unknown" state). If the user no longer exists
// afterwards (deleted during the request), it is a 404 — otherwise 200 with body `null`, which no client can read as a user.
async function respondWithUser(res, code, userId, selfId) {
  let n;
  try { n = await userOf(userId, selfId); }
  catch (e) { return send(res, 502, { error: `Done, but the container cannot be measured right now: ${e?.message || e}` }); }
  if (!n) return send(res, 404, { error: "Unknown user (deleted in the meantime)" });
  return send(res, code, n);
}

// What was checked BEFORE an `await` no longer holds afterwards. The admin check sat only at the start of the branch — a request
// whose body was still in flight (or waiting on docker) continued with the earlier authorization: a just-locked or demoted admin
// could unlock themselves or create a new admin that way. And the target may have been deleted in that time. Hence after EVERY
// `await` before a change: re-read the session (getSession reads the user fresh — locked, deleted or with a new password it is
// gone, demoted it carries "user"), re-read the target — and NO `await` between this check and the change. false = answered.
function stillAllowed(req, res, target = null) {
  const s = sessionOf(req);
  if (!s) { send(res, 401, { error: "not signed in (the session ended during the request)", gateway: true }); return false; }
  if (s.user.role !== "admin") { send(res, 403, { error: "admins only" }); return false; }
  if (target !== null && !users.getUser(target)) { send(res, 404, { error: "Unknown user (deleted in the meantime)" }); return false; }
  return true;
}

// The list: ONE measurement for all users of the response (every row in the same window).
async function administrationView(selfId) {
  await supplementMissingRows();
  const spec = containers.hostSpecs();
  const list = users.listUsers();
  const values = new Map(users.listResources().map((r) => [r.userId, r]));
  const lagen = await Promise.all(list.map((u) => containers.situation(u.id)));
  const measurement = lagen.some((l) => l.state === "running") ? await containers.consumptionPerContainer() : null;
  return {
    server: serverView(spec, list.map((u) => values.get(u.id)).filter(Boolean)),
    user: list.map((user, i) => userView({
      user, selfId, values: values.get(user.id) ?? null, situation: lagen[i], consumption: measurement?.[lagen[i].id] ?? null, threads: spec.threads,
    })),
  };
}

// For /gw/env: the caller's own values, read-only. If docker does not answer, `actual` and `consumption` are null (unknown) — /gw/env
// stays as reachable as before, the old contract (state, port, startedAt, activeStreams) does not hang on the administration.
async function ownResources(userId) {
  if (!users.getResources(userId)) await supplementMissingRows().catch(() => {});
  const situation = await containers.situation(userId).catch(() => null);
  const byKey = situation?.state === "running" ? await containers.consumptionPerContainer() : null;
  return resourcesFields({ values: users.getResources(userId), situation, consumption: byKey?.[situation.id] ?? null, threads: containers.hostSpecs().threads });
}

// ── Static web UI (shared web/out) ──────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".map": "application/json",
  ".webmanifest": "application/manifest+json", ".gif": "image/gif", ".webp": "image/webp",
};

function serveStatic(res, urlPath) {
  // An unreadable path is a 400: `GET /%` would otherwise throw URIError (500).
  let raw;
  try { raw = decodeURIComponent(urlPath); } catch { res.writeHead(400); return res.end("bad path"); }
  const clean = path.normalize(raw).replace(/^([/\\])+/, "/");
  if (clean.includes("..")) { res.writeHead(400); return res.end("bad path"); }
  const candidates = clean === "/"
    ? ["/index.html"]
    : [clean, `${clean}.html`, path.join(clean, "index.html")];
  for (const rel of candidates) {
    const file = path.join(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR)) continue;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      const immutable = clean.startsWith("/_next/");
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "content-length": st.size,
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
      // A read stream without an error listener (file removed between stat and open, e.g. when swapping web/out) would be an
      // unhandled 'error' and the end of the gateway.
      return fs.createReadStream(file).on("error", () => { try { res.destroy(); } catch {} }).pipe(res);
    } catch {}
  }
  try {
    const nf = fs.readFileSync(path.join(WEB_DIR, "404.html"));
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(nf);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────────

// URL parsing used to sit in the async handler BEFORE the try, with nobody catching the rejection — `GET //` without login ended
// the gateway for everyone. Now: unreadable URL ⇒ 400, and the handler has a catcher at the seam.
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("[gateway] Request", req.method, String(req.url).slice(0, 200), "—", e?.stack || e);
    errorResponse(res, 500, { error: String(e?.message || e) });
  });
});

async function handle(req, res) {
  const url = requestUrl(req.url);
  if (!url) return send(res, 400, { error: "invalid request URL" });
  const p = url.pathname;
  const m = req.method;

  try {
    // ── Gateway API (/gw/*) ──
    if (p === "/gw/info" && m === "GET") {
      const sess = sessionOf(req);
      return send(res, 200, {
        gateway: true, ...infoVersionFields(readBuildStamp(), VERSION),
        setup: users.countUsers() === 0,
        setupToken: users.countUsers() === 0, // the setup form asks for the token (setup-token.js)
        authenticated: !!sess,
        user: sess ? { username: sess.user.username, role: sess.user.role } : null,
      });
    }

    if (p === "/gw/setup" && m === "POST") {
      if (users.countUsers() > 0) return send(res, 403, { error: "already set up" });
      const b = await readBody(req);
      // A second setup may have finished while this body was read; never write a new token file after that.
      if (users.countUsers() > 0) return send(res, 403, { error: "already set up" });
      if (!setupToken) setupToken = ensureSetupToken(DATA_DIR);
      if (!setupTokenMatches(setupToken.token, b.setupToken)) {
        return send(res, 403, { error: "setup token missing or wrong — it is in the gateway log and in <data>/setup-token", code: "SETUP_TOKEN" });
      }
      const u = users.createUser({ username: b.username, password: b.password, role: "admin" });
      removeSetupToken(DATA_DIR);
      setupToken = null;
      users.setResources(u.id, template(), null); // every user has a row — the first one from the template
      writeDesired();
      setSessionCookie(res, users.createSession(u.id));
      return send(res, 201, { user: { username: u.username, role: u.role } });
    }

    if (p === "/gw/login" && m === "POST") {
      const address = clientAddress(req);
      const b = await readBody(req);
      if (brake.locked(address, b.username)) return send(res, 429, { error: "too many attempts — wait a moment" });
      if (!checks.proofs()) return send(res, 429, { error: "too many logins at once right now — wait a moment" });
      let u;
      try { u = await users.verifyLogin(b.username, b.password); } finally { checks.gib(); }
      if (!u) {
        brake.failure(address, b.username);
        return send(res, 401, { error: "Login failed" });
      }
      brake.success(address, b.username);
      setSessionCookie(res, users.createSession(u.id));
      return send(res, 200, { user: { username: u.username, role: u.role } });
    }

    if (p === "/gw/logout" && m === "POST") {
      users.deleteSession(parseCookies(req)[COOKIE]);
      clearSessionCookie(res);
      return send(res, 200, { ok: true });
    }


    // From here: authenticated gateway endpoints.
    if (p.startsWith("/gw/")) {
      const sess = sessionOf(req);
      if (!sess) {
        // Without a session to the SAME target as with one — otherwise "/" would lose the jump into the administration. The web
        // shows the login there first.
        if (p === "/gw/admin" && m === "GET") { res.writeHead(302, { location: ADMINISTRATION_JUMP }); return res.end(); }
        return send(res, 401, { error: "not signed in", gateway: true });
      }
      const uid = sess.user.id ?? null;

      if (p === "/gw/me" && m === "GET") return send(res, 200, { user: { username: sess.user.username, role: sess.user.role } });

      // Delete the OWN account (App Store guideline 5.1.1(v)): re-authenticated with the current password through the same brake
      // and check slots as the login; wrong ⇒ 403 and nothing is locked. The last active admin cannot leave other users without an
      // admin (409); the sole user may — the gateway is then back in setup state. The answer comes once the row is marked and locked;
      // the teardown (always with both volumes) runs in the background.
      if (p === ACCOUNT_DELETE_PATH && m === "POST") {
        const address = clientAddress(req);
        const body = await readBody(req);
        const pr = checkAccountDelete(body);
        if (pr.error) return send(res, 400, { error: pr.error });
        const name = sess.user.username;
        if (brake.locked(address, name)) return send(res, 429, { error: "too many attempts — wait a moment" });
        if (!checks.proofs()) return send(res, 429, { error: "too many checks at once right now — wait a moment" });
        let u;
        try { u = await users.verifyLogin(name, pr.values.password); } finally { checks.gib(); }
        if (!u || u.id !== uid) {
          brake.failure(address, name);
          return send(res, 403, { error: "Wrong password", code: "PASSWORD" });
        }
        brake.success(address, name); // a correct password proves this address for the name, as a login does
        // After the await: the session must still be this user's (locked, deleted or a new password meanwhile ⇒ 401). No await from
        // here until the row is marked — two admins deleting themselves at once cannot both get through the check below.
        if (sessionOf(req)?.user.id !== uid) return send(res, 401, { error: "not signed in (the session ended during the request)", gateway: true });
        if (users.countRemainingOthers(uid) > 0 && lastAdmin(users.listUsers(), uid)) {
          return send(res, 409, { error: "You are the last active admin — make someone else an admin first, then delete your account.", code: "LAST_ADMIN" });
        }
        users.requestErase(uid);
        eraseInBackground(uid); // locks, unwatches and closes the streams before it first waits
        clearSessionCookie(res);
        return send(res, 202, { ok: true });
      }

      if (p === "/gw/push" && m === "GET") {
        const list = users.listPushDevices(uid);
        return send(res, 200, {
          ...pushConfiguration(),
          deviceCount: list.length,
          // The token itself NEVER comes back — it is the key to the device. Only what answers the question "does anything arrive
          // on my device?" is returned.
          devices: list.map((d) => ({
            installationId: d.installationId, environment: d.environment, locale: d.locale,
            createdAt: d.createdAt || 0, lastSeen: d.lastSeen || 0,
            lastStatus: d.lastStatus || 0, lastReason: d.lastReason || "", lastPushAt: d.lastPushAt || 0,
          })),
        });
      }
      // Test notification: checks the LINE (key, token, environment), not the settings — hence here in the gateway and regardless
      // of the backend's verdict.
      if (p === "/gw/push/test" && m === "POST") {
        const b = await readBody(req).catch(() => ({}));
        const r = await sendTestPush(uid, {
          title: String(b?.title || "cbase"),
          subtitle: String(b?.subtitle || "Test"),
          body: String(b?.body || ""),
        });
        return send(res, 200, r);
      }
      if (p === "/gw/push/devices/current" && (m === "PUT" || m === "DELETE")) {
        const b = await readBody(req);
        const installationId = String(b.installationId || "");
        if (!/^[a-f0-9-]{16,80}$/i.test(installationId)) return send(res, 400, { error: "invalid installation id" });
        if (m === "DELETE") {
          users.removePushDevice(uid, installationId);
          return send(res, 200, { ok: true });
        }
        const token = String(b.token || "").toLowerCase();
        const environment = String(b.environment || "");
        const locale = String(b.locale || "en").slice(0, 16);
        // Apple does not fix the token length by contract; check only the hex form and a generous upper bound instead of baking in
        // today's usual length.
        if (!/^[a-f0-9]{32,512}$/.test(token)) return send(res, 400, { error: "invalid APNs device token" });
        if (!['sandbox', 'production'].includes(environment)) return send(res, 400, { error: "invalid APNs environment" });
        return send(res, 200, { ok: true, device: users.upsertPushDevice(uid, { installationId, token, environment, locale }) });
      }

      // One-time ticket for the port tunnel: WebSocket clients (Node/undici) send no cookies — the client fetches a short-lived
      // ticket here, authenticated, and attaches it to the upgrade URL. Usable once, valid 30 s.
      if (p === "/gw/tunnel-ticket" && m === "POST") {
        const ticket = crypto.randomBytes(24).toString("hex");
        tunnelTickets.set(ticket, { userId: sess.user.id, expires: Date.now() + 30_000 });
        return send(res, 200, { ticket });
      }

      if (p === "/gw/env" && m === "GET") {
        const st = await containers.status(sess.user.id);
        // Additionally ENV_ADDITION_FIELDS (resources, actual, consumption) — Settings → Environment shows them read-only.
        return send(res, 200, { ...st, activeStreams: activeStreams(sess.user.id), ...(await ownResources(sess.user.id)) });
      }
      if (p === "/gw/env/ensure" && m === "POST") {
        await ensureBackend(sess.user.id);
        touch(sess.user.id);
        return send(res, 200, { ready: true });
      }
      // Storage of the own environment: used (volume) + quota (optional) + free on the host.
      if (p === "/gw/env/storage" && m === "GET") {
        const st = await containers.storage(sess.user.id);
        const quotaGb = Number(process.env.GW_USER_QUOTA_GB || 0);
        return send(res, 200, {
          usedBytes: st.usedBytes,
          quotaBytes: quotaGb > 0 ? quotaGb * 1024 ** 3 : null,
          hostFreeBytes: await containers.hostFreeBytes(),
        });
      }
      // What the server still has in total (RAM, swap, load, disk) — for the resource pill. The user container knows only its own
      // quota, hence here at the host.
      if (p === "/gw/host" && m === "GET") return send(res, 200, await containers.hostResources());

      // ── Admin (administration) ──
      // Every body carries EXACTLY its required fields (missing or foreign ⇒ 400, `null` is a statement); every response to a
      // change is the user in the list's shape. Between the "last admin" check and the write there is no await — two admins
      // demoting each other at the same time cannot both get through.
      if (p === "/gw/admin" || p.startsWith("/gw/admin/")) {
        if (sess.user.role !== "admin") return send(res, 403, { error: "admins only" });
        // The old page is replaced: whoever calls /gw/admin (bookmark, older app) lands in Settings → Administration.
        if (p === "/gw/admin" && m === "GET") { res.writeHead(302, { location: ADMINISTRATION_JUMP }); return res.end(); }
        if (p === "/gw/admin/administration" && m === "GET") {
          let view;
          try { view = await administrationView(sess.user.id); }
          catch (e) { return send(res, 502, { error: String(e?.message || e) }); }
          return send(res, 200, view);
        }
        // GET /gw/admin/users no longer exists: the list has ONE place (/gw/admin/administration); two places for the same list
        // drift apart.
        if (p === "/gw/admin/users" && m === "POST") {
          const body = await readBody(req);
          if (!stillAllowed(req, res)) return; // authorization AFTER the body, no await until the creation
          const pr = checkCreate(body);
          if (pr.error) return send(res, 400, { error: pr.error });
          let u;
          try { u = users.createUser(pr.values); }
          catch (e) { return send(res, 400, { error: String(e.message || e) }); }
          users.setResources(u.id, template(), null);
          writeDesired();
          return respondWithUser(res, 201, u.id, sess.user.id);
        }
        const userMatch = p.match(new RegExp(`^/gw/admin/users/([0-9a-f-]+)(?:/(password|resources|${CONTAINER_ACTIONS.join("|")}))?$`));
        if (userMatch) {
          const target = userMatch[1]; const sub = userMatch[2] || "";
          if (!users.getUser(target)) return send(res, 404, { error: "Unknown user" });
          if (sub === "" && m === "DELETE") {
            if (target === sess.user.id) return send(res, 400, { error: "own account cannot be deleted" });
            // A row its owner deleted is always purged — otherwise this delete would drop the mark and leave the volumes behind.
            const purge = url.searchParams.get("purge") === "1" || users.eraseRequested(target);
            const result = await eraseUser(target, { purge }); // the one teardown path (see eraseUser)
            if (result.error === "container") {
              return send(res, 500, { error: "The container could not be removed — the user stays locked; repeat the delete.", purged: false });
            }
            if (result.error === "volumes") {
              return send(res, 500, { error: "The data volumes could not be removed — the user stays locked; repeat the delete.", purged: false });
            }
            return send(res, 200, { ok: true, purged: purge });
          }
          if (sub === "" && m === "PATCH") {
            const body = await readBody(req);
            if (!stillAllowed(req, res, target)) return; // authorization and target AFTER the body, no await until the change
            const pr = checkPatch(body);
            if (pr.error) return send(res, 400, { error: pr.error });
            const w = pr.values;
            if ("role" in w) {
              if (w.role !== "admin" && lastAdmin(users.listUsers(), target)) {
                return send(res, 400, { error: "The last active admin cannot be demoted — make someone else an admin first." });
              }
              users.setRole(target, w.role);
            } else if (w.locked) {
              if (target === sess.user.id) return send(res, 400, { error: "own account cannot be locked" });
              if (lastAdmin(users.listUsers(), target)) return send(res, 400, { error: "The last active admin cannot be locked." });
              users.lockUser(target); // sessions drop at once; login and container start refuse
              unwatchBackend(target); // no notifications to a locked user's devices; the container itself keeps running
              closeStreams(target); // and whatever a session had already opened (tunnel, DevTools, SSE) drops now
            } else {
              if (containers.teardownRunning(target)) return send(res, 409, { error: "This user's environment is currently being removed" });
              // The owner deleted this account: it only goes forward (the erasure is retried), never back to an active user.
              if (!users.unlockUser(target)) return send(res, 409, { error: "This user deleted their account — the deletion is pending and cannot be undone." });
            }
            return respondWithUser(res, 200, target, sess.user.id);
          }
          if (sub === "password" && m === "POST") {
            const body = await readBody(req);
            if (!stillAllowed(req, res, target)) return; // re-check
            const pr = checkPassword(body);
            if (pr.error) return send(res, 400, { error: pr.error });
            try { users.setPassword(target, pr.values.password); }
            catch (e) { return send(res, 400, { error: String(e.message || e) }); }
            closeStreams(target); // setPassword ends the sessions — and with them whatever was open through them
            return send(res, 200, { ok: true });
          }
          if (sub === "resources" && m === "PUT") {
            const spec = containers.hostSpecs();
            const body = await readBody(req);
            if (!stillAllowed(req, res, target)) return; // re-check — and once more right before saving (below)
            const pr = checkResources(body, spec);
            if (pr.error) return send(res, 400, { error: pr.error });
            if (containers.teardownRunning(target)) return send(res, 409, { error: "This user's environment is currently being removed" });
            // Lowering RAM below consumption is a 409 with the number — only against a RUNNING container (a stopped one has no
            // working set) and only if the limit drops (raising kills nothing). If docker does not answer here, NOTHING is saved:
            // whether it lowers is then unknown, and unknown is not a yes.
            let prior;
            try { prior = await containers.situation(target); }
            catch (e) { return send(res, 502, { error: `Not saved — the container cannot be measured right now: ${e?.message || e}` }); }
            if (prior.state === "running" && lowersRam(pr.values, prior.hostConfig)) {
              const byKey = await containers.consumptionPerContainer();
              const consumptionBytes = byKey?.[prior.id]?.ramBytes ?? null;
              const reason = ramUnderConsumption(pr.values, consumptionBytes);
              if (reason) return send(res, 409, { error: reason, consumptionBytes });
            }
            // The measurement above waited (docker, cgroup) — authorization, target and teardown RIGHT before saving, with no await
            // in between. Without that a meanwhile demoted admin would keep writing, and a meanwhile deleted user would get an
            // orphaned row (users.setResources writes only for an existing user anyway).
            if (!stillAllowed(req, res, target)) return;
            if (containers.teardownRunning(target)) return send(res, 409, { error: "This user's environment is currently being removed" });
            // Save first, then apply: a start that applyResources awaits or that comes after already reads the new value. If applying
            // fails, the value stays saved — the row then shows "deviating", and the error message says so.
            if (!users.setResources(target, pr.values, sess.user.id)) return send(res, 404, { error: "Unknown user (deleted in the meantime)" });
            writeDesired();
            try { await containers.applyResources(target, pr.values); }
            catch (e) { return send(res, e?.status || 502, { error: `Saved, but not applied: ${e?.message || e}` }); }
            return respondWithUser(res, 200, target, sess.user.id);
          }
          if (CONTAINER_ACTIONS.includes(sub) && m === "POST") {
            if (sub === "stop") {
              unwatchBackend(target);
              await containers.stop(target);
              return respondWithUser(res, 200, target, sess.user.id);
            }
            // start · restart: a locked user gets no container (the same rule as ensureBackend, here in plain words).
            if (!users.isActive(target)) return send(res, 409, { error: "The user is locked — unlock first, then start." });
            if (containers.teardownRunning(target)) return send(res, 409, { error: "This user's environment is currently being removed" });
            try {
              if (sub === "restart") { unwatchBackend(target); await containers.restart(target); }
              await ensureBackend(target);
              touch(target);
            } catch (e) { return send(res, e?.status || 502, { error: String(e?.message || e) }); }
            return respondWithUser(res, 200, target, sess.user.id);
          }
        }
        return send(res, 404, { error: "unknown admin endpoint" });
      }

      void uid;
      return send(res, 404, { error: "unknown gateway endpoint" });
    }

    // ── Backend API: authenticated → ensure container → pass through ──
    if (p.startsWith("/api/")) {
      // Liveness of the gateway itself — without login (and without waking a container).
      if (p === "/api/health" && m === "GET") return send(res, 200, { ok: true, gateway: true });
      // /api/ingest/* is a path like any other: there is no delivery token any more, 401 without a session — and no B is woken.
      const sess = sessionOf(req);
      if (!sess) return send(res, 401, { error: "not signed in", gateway: true });
      const { port } = await ensureBackend(sess.user.id);
      // the session no longer holds after the wait (locked, deleted, new password) — then no stream that would stay open afterwards.
      if (sessionOf(req)?.user.id !== sess.user.id) return send(res, 401, { error: "not signed in", gateway: true });
      return proxyRequest(req, res, { port, userId: sess.user.id, onActivity: () => touch(sess.user.id) });
    }

    // ── Static UI ──
    if (m !== "GET" && m !== "HEAD") return send(res, 405, { error: "method not allowed" });
    return serveStatic(res, p);
  } catch (e) {
    // 503 "busy" (containers.js ensureRunning): B is running but not answering right now — the client retries, nothing was
    // replaced. Any other throw stays 500.
    if (e?.busy) return errorResponse(res, 503, { error: String(e.message), busy: true, gateway: true });
    return errorResponse(res, 500, { error: String(e?.message || e) });
  }
}

// No socket timeouts (SSE); generous header timeout.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

// ── Port tunnel: pass the WebSocket upgrade on /api/tunnel through to the container ──
// The gateway speaks NO WebSocket protocol — it only checks the ticket (or cookie), writes the upgrade request raw to the
// container and then splices both TCP sockets. Framing is settled between client (undici WebSocket) and backend (ws).
const tunnelTickets = new Map(); // ticket -> { userId, expires }
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of tunnelTickets) if (v.expires < now) tunnelTickets.delete(t);
}, 30_000).unref();

// The error listener on the socket must attach FIRST, before any await (model: server/backend/electron/server/tunnel.js): a client
// reset during `await ensureBackend` (tab closed, dead spot, deliberate) would otherwise be an 'error' without a listener and end
// the gateway. After the wait an already destroyed socket is no longer connected.
server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => { try { socket.destroy(); } catch {} });
  upgrade(req, socket, head).catch(() => { try { socket.destroy(); } catch {} });
});

async function upgrade(req, socket, head) {
  try {
    const url = requestUrl(req.url);
    if (!url) { socket.destroy(); return; }
    // Two WebSocket paths: port tunnel and Chrome DevTools of the streamed browser. Both are treated identically — spliced raw to
    // the container; the ends settle framing.
    const isDevtools = /^\/api\/browsers\/[0-9a-f-]+\/devtools\//.test(url.pathname);
    // Plus the WebSocket wire of the streamed browser: frames binary, input on the same socket.
    const isStream = /^\/api\/browsers\/[0-9a-f-]+\/stream$/.test(url.pathname);
    if (url.pathname !== "/api/tunnel" && !isDevtools && !isStream) { socket.destroy(); return; }
    // Auth: one-time ticket from the query or (browser clients/DevTools iframe) the session cookie.
    let userId = null;
    let perTicket = false;
    const t = url.searchParams.get("ticket");
    const tk = t ? tunnelTickets.get(t) : null;
    if (tk && tk.expires > Date.now() && users.isActive(tk.userId)) { userId = tk.userId; perTicket = true; tunnelTickets.delete(t); }
    else { const sess = sessionOf(req); if (sess) userId = sess.user.id; }
    if (!userId) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }

    const { port } = await ensureBackend(userId);
    if (socket.destroyed) return; // the client left during the wait
    // Locked or deleted during the wait (with a cookie also: new password) — then no tunnel. closeStreams saw only the sockets
    // already carried in that time; this one would otherwise have stayed open after the lock.
    if (!(perTicket ? users.isActive(userId) : sessionOf(req)?.user.id === userId)) {
      try { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); } catch {}
      socket.destroy();
      return;
    }
    touch(userId);
    const done = trackStream(userId, socket); // open tunnel = active (idle reaper); closable via closeStreams

    const up = net.connect({ host: "127.0.0.1", port }, () => {
      // Reconstruct the original upgrade request; do not leak the cookie into the container.
      const h = { ...req.headers, host: `127.0.0.1:${port}` };
      delete h.cookie;
      const lines = [`GET ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(h)) for (const vv of (Array.isArray(v) ? v : [v])) lines.push(`${k}: ${vv}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length) up.write(head);
      socket.pipe(up);
      // DevTools: the response without the headers that set something on the user's side (proxy.js) — the backend already strips
      // them for a project browser, the gateway once more on this path. The port tunnel as before.
      if (isDevtools) passThroughUpgradeResponse(up, socket);
      else up.pipe(socket);
    });
    up.setNoDelay(true);
    socket.setNoDelay?.(true);
    socket.setTimeout?.(0);
    socket.setKeepAlive?.(true, 30_000);
    const teardown = () => { try { up.destroy(); } catch {} try { socket.destroy(); } catch {} done(); touch(userId); };
    up.on("error", () => { try { socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch {} teardown(); });
    up.on("close", teardown);
    socket.on("error", teardown);
    socket.on("close", teardown);
  } catch {
    try { socket.destroy(); } catch {}
  }
}

// ── Schedule wakeup ───────────────────────────────────────────────────────────────────────────────
// A scheduled job in the backend (Coding → Scheduled) fires only if the container runs. The gateway therefore asks, every minute,
// each RUNNING container for its earliest occurrence under containers.SCHEDULED_OCCURRENCE_PATH and remembers it per user; a
// SLEEPING container it starts two minutes before the remembered occurrence. The idle reaper (below) leaves containers with an
// occurrence in the next ten minutes alone. (In operation the reaper is off — GW_IDLE_STOP_MIN not set — and a container runs
// through; the wakeup is the precaution for the day that no longer holds.)
const WAKEUP_LEAD_TIME_MS = 2 * 60_000;
const REAPER_GRACE_PERIOD_MS = 10 * 60_000;
// The containers are asked CONCURRENTLY, each question with total deadline and cap (containers.nextScheduleOccurrence) — asked in
// sequence and with an idle deadline a trickling backend never triggers, a single tenant would hold the wakeup of all others. And
// a tick that is still running is not started a second time.
let wakeupRunning = false;
// Knob GW_TICK_MS (ms, integer > 0, at most the timer limit 2^31 − 1), read once here: the period of this tick, default 60 s. Only
// the tests set it — short to see the tick retry an erasure, very long to see the start do it alone.
const TICK_MS = (() => {
  const raw = process.env.GW_TICK_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 2 ** 31 - 1 ? n : 60_000;
})();
setInterval(async () => {
  retryErasures(); // self-deletions whose teardown failed (each runs on its own; one at a time per user)
  if (wakeupRunning) return;
  wakeupRunning = true;
  try {
    const now = Date.now();
    const running = new Set((await containers.listAll()).filter((c) => c.userId && c.state === "running").map((c) => c.userId));
    const termine = await Promise.all([...running].map(async (uid) => [uid, await containers.nextScheduleOccurrence(uid)]));
    for (const [uid, nextAt] of termine) if (nextAt !== null) users.setScheduleOccurrence(uid, nextAt);
    for (const t of users.listScheduleTermine()) {
      if (running.has(t.userId) || t.nextAt - now > WAKEUP_LEAD_TIME_MS) continue;
      if (!users.isActive(t.userId)) continue;
      console.log(`[gateway] Schedule wakeup: starting the container of ${t.userId} for the scheduled job at ${new Date(t.nextAt).toISOString()}`);
      ensureBackend(t.userId).catch((e) => console.error("[gateway] Schedule wakeup", t.userId, e?.message || e));
      // Until the container reports its occurrence itself, "none" applies — otherwise it would wake again every minute if the
      // start fails and the occurrence stays in the past.
      users.setScheduleOccurrence(t.userId, 0);
    }
  } catch (e) { console.error("[gateway] Schedule wakeup:", e?.message || e); }
  finally { wakeupRunning = false; }
}, TICK_MS).unref();

// ── Idle reaper: put containers without open streams and without activity to sleep ──
// Wrapped in try — a rejection (docker, DB) in the tick would end the gateway; and guarded against a second tick while the first
// still waits on `busy` (every question has a total deadline).
if (IDLE_STOP_MIN > 0) {
  let reaperRunning = false;
  setInterval(async () => {
    if (reaperRunning) return;
    reaperRunning = true;
    try {
      for (const c of await containers.listAll()) {
        if (c.state !== "running" || !c.userId) continue;
        const idleMs = Date.now() - (lastActivity.get(c.userId) || 0);
        // A scheduled occurrence soon: leave it — a stop now would mean stop and start within minutes.
        const occurrence = users.getScheduleOccurrence(c.userId);
        if (occurrence && occurrence - Date.now() < REAPER_GRACE_PERIOD_MS) continue;
        if (activeStreams(c.userId) === 0 && idleMs > IDLE_STOP_MIN * 60_000) {
          // Run-aware: NEVER put a container with an active chat/scan to sleep (otherwise the run dies). The backend reports its
          // busy status via /api/runs/active.
          if (await containers.busy(c.userId)) continue;
          console.log(`[gateway] Idle stop for ${c.userId} (inactive for ${Math.round(idleMs / 60000)} min)`);
          unwatchBackend(c.userId);
          await containers.stop(c.userId);
        }
      }
    } catch (e) { console.error("[gateway] Idle-Reaper:", e?.message || e); }
    finally { reaperRunning = false; }
  }, 60_000).unref();
}

server.listen(PORT, HOST, () => {
  console.log(`[gateway] cbase gateway v${VERSION} on http://${HOST}:${PORT}`);
  for (const line of startupWarnings(process.env)) console.warn(line);
  console.log(`[gateway] Web UI: ${WEB_DIR}${fs.existsSync(path.join(WEB_DIR, "index.html")) ? "" : "  (WARNING: no index.html — build web/ first!)"}`);
  announceSetupToken();
  retryErasures({ atStart: true }); // self-deletions a restart interrupted or whose teardown failed
  console.log(`[gateway] Data: ${DATA_DIR} · Image: ${process.env.GW_IMAGE || "cbase-backend"} · Idle stop: ${IDLE_STOP_MIN > 0 ? IDLE_STOP_MIN + " min" : "off"}`);
  const push = pushConfiguration();
  console.log(`[gateway] APNs: sandbox ${push.sandbox ? "ready" : "off"} · production ${push.production ? "ready" : "off"} · topic ${push.topic}`);
  // Measure cbase's share of the server once up front (cbase-share.js): this kicks off `docker system df` (≈ 7 s) and lays the CPU
  // base measurement — the first pill after a gateway restart gets disk and cores instead of `null` until its next tick.
  containers.cbaseMeter.measure().catch(() => {});
  // The resources per user: initial fill (once, from what the containers carry NOW) and the imprint for the deploy — written at
  // EVERY start, even if there was nothing to add (the file is the operator's status check's comparison). Then every deviating container is
  // aligned to its stored value — the line below comes only afterwards (the tests' harness waits for it), and an error in the
  // alignment does not hold it up.
  supplementMissingRows().then(async (fresh) => {
    writeDesired();
    let aligned = 0;
    try { aligned = await sameLimitsFrom({ except: fresh }); }
    catch (e) { console.error("[gateway] Limits alignment:", e?.message || e); }
    console.log(`[gateway] Resources: ${fresh.length} users taken over from the existing state, ${aligned} containers aligned to the stored value, desired state in ${path.join(DATA_DIR, "resources-desired.json")}`);
  }).catch((e) => console.error("[gateway] Resources initial fill:", e?.message || e));
  // After a gateway restart user containers keep running thanks to unless-stopped. Re-subscribe to their event streams at once, not
  // at the next app call.
  containers.listAll().then(async (list) => {
    for (const item of list) {
      if (item.state !== "running" || !item.userId) continue;
      const status = await containers.status(item.userId);
      if (status.port) watchBackend(item.userId, status.port);
    }
  }).catch(() => {});
});
