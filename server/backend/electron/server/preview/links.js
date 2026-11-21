// Preview links: a public ngrok link to a registered service of an instance.
//
// TWO MODES, computed from the access, never stored:
//   off    no authtoken — no link
//   dev    authtoken only (Free plan): the account's dev address, one link at a time, without `domain`
//   names  authtoken + API key (Hobbyist): a reserved random name per link, released at the end
//
// CREATING, no half state without a trace: check (access 412, SDK 501, limit 409, project/service 404, port 400, target)
// → row `start` → (names) reserve a name, id into the row → open → `online` with `url`. If reserving or opening fails, a
// reserved name is released and the row is `ended` (reason `error`) — 502 `NGROK` with the link.
// REVOKE/EXPIRY: the row is ended EXACTLY ONCE (condition in the UPDATE), then listener closed, name released, session
// closed when no link is active any more. A failed release stays as `approved_at IS NULL`; `checkProcedure` retries it.
// TARGET REMOVED: every delete path of the data layer — instance, project, workspace, service — SYNCHRONOUSLY calls
// `targetRemoved` (setter `store.setTargetRemovedObserver`, wired in server.js): the affected links are ended (reason
// `error`) BEFORE the delete path returns, their listeners close at once (the post-work runs in the background,
// `previewPostWork()` waits for it). Why at once: `selectSubnet` (projectbox/creation.js) hands the first free /24
// including .2 to the NEXT instance — possibly of another project — and an open listener would silently and publicly
// point at it.
// SAFETY NET on the tick (`checkProcedure`): `targetGone` ends what the observer would have missed (project, service,
// instance gone, a project without an instance has been converted meanwhile); `checkTarget` compares the target the
// listener was OPENED on (in memory at the listener, see `handles`) with today's — if it differs (the same instance
// recreated, new IP) it is reopened; if the instance currently has no IP, the listener closes and the link is in `error`
// until it has one again.
// RESTART: every active link is reopened on its target — `names` with the SAME domain (from `url`), WITHOUT a new
// reservation. Then the tick (`checkProcedure` every minute).
//
// ACCESS VALUES never leave: neither in a response nor via SSE nor into the log (`redact` over every error text that
// comes from the SDK or the API). Outward only booleans.
//
// STOPPED: a link to a stopped (or currently stopping) instance stays — the listener stays open, the rewrite proxy
// answers 502 "instance stopped" per request (`stoppedTextOf`, read live from the row); when the instance starts again,
// the same address works again without any action. No ending: stopping is reversible.
//
// The ONE ngrok session is in ngrok-session.js, the API in ngrok-api.js, the names in names.js; the routes in routes.js.
import { randomUUID } from "node:crypto";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { broadcast } from "../runtime/sse.js";
import { hostPort } from "../projectbox/address.js";
import { instanceTarget } from "../projectbox/network-targets.js";
import * as session from "./ngrok-session.js";
import * as api from "./ngrok-api.js";
import { NAMES_ATTEMPTS, domainFor } from "./names.js";
// The contract of the seam (limit per mode, history, SSE type, fields) is stated ONCE in contract.js — no second list here.
import { LIMIT, LINK_FIELDS, SSE_TYPE, HISTORY } from "./contract.js";

export const TICK_MS = 60_000;
const DAY_MS = 86_400_000;
const SERVER_END_MS = 5_000;
// The sentences below are stored as the error of a link and shown by the views, which translate them for display (web/src/lib/preview-links.ts
// linkErrorShown, Shell/PreviewLinks.swift); old German rows are rewritten by the private migration tool.
export const OCCUPIED_SENTENCE = "The address is already taken by another ngrok tunnel (e.g. the one of the writing assistant).";

/** An error with a response: `status`, sentence, `code` and extra fields (e.g. `link`). */
export class PreviewError extends Error {
  constructor(status, text, code = "", extra = {}) {
    super(text);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// The open listeners per link id (process state — empty after a restart, the restart fills it). Every entry carries
// `target`: the target it was OPENED on. In memory, not a column: it describes exactly this listener and lives as long
// as it does — a column would be stale after every restart and would have to be recomputed anyway.
const handles = new Map();
// The running post-work of the observer (targetRemoved) — `previewPostWork()` waits for it.
const postWork = new Set();

export const modeFrom = (z) => (!z.authtoken ? "off" : z.apiKey ? "names" : "dev");

/** Remove access values from a text — the stored ones and those being checked (also routes.js for unexpected errors). */
export function redact(text, extra = []) {
  let t = String(text ?? "");
  let z = { authtoken: "", apiKey: "" };
  try { z = store.ngrokAccessRaw(); } catch { /* without a database only the extra values */ }
  for (const w of [z.authtoken, z.apiKey, ...extra]) if (w && w.length >= 4) t = t.split(w).join("•••");
  return t;
}

const log = (what, e) => console.error(`[preview] ${what}: ${redact(e?.message || e)}`);

/** The error text of an ngrok error, with code; ERR_NGROK_334 (address taken) gets its own sentence. */
export function ngrokErrorText(e, extra = []) {
  const raw = String(e?.message || e || "unknown error");
  const code = (typeof e?.errorCode === "string" && e.errorCode)
    || /ERR_NGROK_\d+/.exec(raw)?.[0]
    || (typeof e?.code === "string" && /^ERR_NGROK_\d+$/.test(e.code) ? e.code : "");
  const text = code === "ERR_NGROK_334" ? `${OCCUPIED_SENTENCE} (${code})` : code && !raw.includes(code) ? `${raw} (${code})` : raw;
  return redact(text, extra).slice(0, 500);
}

function linkFrom(l) {
  if (!l) return null;
  let project = null, service = null;
  try { project = store.getProject(l.projectId); } catch { /* the name is display only */ }
  try { service = store.getProjectService(l.serviceId); } catch { /* ditto */ }
  const values = {
    ...l, projectName: project?.name || "", serviceName: service?.name || "",
  };
  // Exactly the fields of the contract, in its order — never `ngrokDomainId` or `approvedAt` (internal columns).
  return Object.fromEntries(LINK_FIELDS.map((k) => [k, values[k] ?? null]));
}

function report(l) {
  if (l) broadcast({ type: SSE_TYPE, link: linkFrom(l) });
}

async function sessionToIfEmpty() {
  if (!store.previewLinksActive().length) await session.sessionClosed();
}

const countSet = (n) => (n === 1 ? T("1 active link depends on it") : T`${n} active links depend on it`);

function limitText(mode, n) {
  return mode === "dev"
    ? T("Free plan: one link at a time — revoke the active one first")
    : T`${n} of ${LIMIT.names} links active (ngrok Hobbyist)`;
}

/**
 * The rewrite proxy's question per request (header "STOPPED") — the text of the 502 if the link's instance is stopped or
 * currently stopping, else null. Never without an instance (project without a container).
 */
export function stoppedTextOf({ projectId, instance }) {
  return () => {
    if (instance == null) return null;
    const z = store.projectInstance(String(projectId), String(instance));
    if (z?.state === "stopped") return T`Instance stopped — “${instance}” was stopped in cbase. The link works again as soon as it is started.`;
    if (z?.state === "stop") return T`Instance stopped — “${instance}” is being stopped.`;
    return null;
  };
}

/**
 * The target of a link: `http://<host>:<port>`. With `instance` the IP of that instance (projectbox/network-targets.js);
 * without an instance (`null`) 127.0.0.1 — but only if the project is NOT converted (otherwise a service of the backend
 * would be there, not of the project). `target` is the test seam for instanceTarget.
 */
export function targetFor({ projectId, instance, port }, { target = instanceTarget } = {}) {
  if (instance == null) {
    if (target(`${projectId}/main`)) {
      throw new PreviewError(400, T("The project runs in a project container — “instance” must name the instance (e.g. “main”)."), "INSTANCE");
    }
    return `http://${hostPort("127.0.0.1", port)}`;
  }
  const z = target(`${projectId}/${instance}`);
  if (!z) throw new PreviewError(404, T`Instance “${instance}” of this project is unknown.`, "INSTANCE");
  if (!z.ip) throw new PreviewError(409, T`Instance “${instance}” has no address in the project network — it is not running or not ready yet.`, "WITHOUT_IP");
  return `http://${hostPort(z.ip, port)}`;
}

/**
 * Reserve a name — on a collision (4xx except 401/403: a rejected key is no collision) roll again. Without a response
 * or with 5xx the reservation may exist anyway (timeout AFTER creation): then the name is searched via
 * `GET /reserved_domains` and, if present, released at once — otherwise it would stay at ngrok forever. If that fails
 * too, it stays (residual risk, preview/README.md); the original error is passed on.
 */
async function reserveName(apiKey, projectName) {
  let last = null;
  for (let i = 0; i < NAMES_ATTEMPTS; i++) {
    const domain = domainFor(projectName);
    try {
      return await api.reserve(apiKey, domain);
    } catch (e) {
      last = e;
      const clientError = e?.status >= 400 && e?.status < 500;
      if (clientError && e.status !== 401 && e.status !== 403) continue; // collision: roll again
      if (!clientError) await cleanLostReservation(apiKey, domain);
      throw e;
    }
  }
  throw last;
}

/** After a reservation without a (valid) response: if the name exists at ngrok after all, release it at once. Never throws. */
async function cleanLostReservation(apiKey, domain) {
  try {
    const r = await api.searchReservation(apiKey, domain);
    if (r) await api.gibFree(apiKey, r.id);
  } catch (e) {
    log(`reservation ${domain} not cleaned up after a lost response (may remain at ngrok)`, e);
  }
}

/** Try an outstanding release — true if nothing is outstanding afterwards. */
async function approve(l, z = store.ngrokAccessRaw()) {
  if (!l?.ngrokDomainId || l.approvedAt) return true;
  if (!z.apiKey) {
    // Without a key it can never happen again: loud, not silent — the reservation stays at ngrok until the user deletes it there.
    log(`release ${l.ngrokDomainId} (link ${l.id})`, "no API key stored — the reservation stays at ngrok (delete it there by hand)");
    return false;
  }
  try {
    await api.gibFree(z.apiKey, l.ngrokDomainId);
    store.changePreviewLink(l.id, { approvedAt: Date.now() });
    return true;
  } catch (e) {
    log(`release ${l.ngrokDomainId} (link ${l.id})`, e);
    return false;
  }
}

/**
 * The SYNCHRONOUS part of ending: end the row exactly once (condition in the UPDATE) and take the listener out of the
 * table. Returns `null` if someone else was faster, else `{ h }` (the listener or undefined) for `cleanAfter`.
 */
function endRow(id, reason, { now = Date.now(), error = null } = {}) {
  if (!store.endPreviewLink(id, { reason, error, now })) return null;
  const h = handles.get(id);
  handles.delete(id);
  return { h };
}

/** The rest: close the listener, report, release the name, close the session when no link is active any more. */
async function cleanAfter(id, h) {
  if (h) await h.close();
  report(store.previewLink(id));
  await approve(store.previewLink(id));
  await sessionToIfEmpty();
}

/** End an active link — exactly once; returns the row afterwards. */
async function end(l, reason, opts = {}) {
  const b = endRow(l.id, reason, opts);
  if (b) await cleanAfter(l.id, b.h);
  return store.previewLink(l.id);
}

// ── Access ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function readAccess() {
  const z = store.ngrokAccessRaw();
  const mode = modeFrom(z);
  return {
    authtoken: Boolean(z.authtoken), apiKey: Boolean(z.apiKey), mode, limit: LIMIT[mode],
    active: store.previewLinksActive().length, checkedAt: z.checkedAt, error: z.error, sdk: session.sdkExisting(),
  };
}

/**
 * Retry outstanding releases with the OLD key before it is deleted — afterwards it would never work again, and the
 * reservation would stay at ngrok forever (Hobbyist: 10 names). If one stays open, 409 `APPROVAL_OPEN` with the count
 * (`open`), and NOTHING is deleted. Without a stored key there is nothing to protect — no 409.
 */
async function approvalsBeforeTheDelete(z) {
  if (!z.apiKey) return;
  for (const l of store.previewLinksWithoutApproval()) await approve(l, z);
  const open = store.previewLinksWithoutApproval().length;
  if (open) {
    const set = open === 1 ? T("1 reserved name is") : T`${open} reserved names are`;
    throw new PreviewError(409, T`The API key cannot be removed — ${set} still not released at ngrok (the release failed). Try again later.`, "APPROVAL_OPEN", { open });
  }
}

function deleteLock({ authtoken, apiKey }) {
  const active = store.previewLinksActive();
  if (authtoken === "" && active.length) {
    throw new PreviewError(409, T`The authtoken cannot be removed — ${countSet(active.length)}. Revoke first.`, "ACTIVE");
  }
  const names = active.filter((l) => l.mode === "names");
  if (apiKey === "" && names.length) {
    throw new PreviewError(409, T`The API key cannot be removed — ${countSet(names.length)} (reserved names). Revoke first.`, "ACTIVE");
  }
}

/**
 * `{ authtoken, apiKey }` each a string (set; "" deletes) or null (unchanged) — routes.js checks the shape. Saving
 * happens only after the CHANGED values passed their check; if it fails: 400 CHECK, nothing saved.
 */
export async function setAccess({ authtoken, apiKey }) {
  const z = store.ngrokAccessRaw();
  const fresh = { authtoken: z.authtoken, apiKey: z.apiKey };
  const checked = { authtoken: false, apiKey: false };
  if (authtoken !== null) {
    if (authtoken !== "" && !authtoken.trim()) throw new PreviewError(400, T("The authtoken consists only of whitespace."), "FORM");
    if (authtoken !== z.authtoken) { fresh.authtoken = authtoken.trim(); checked.authtoken = fresh.authtoken !== ""; }
  }
  if (apiKey !== null) {
    if (apiKey !== "" && !apiKey.trim()) throw new PreviewError(400, T("The API key consists only of whitespace."), "FORM");
    if (apiKey !== z.apiKey) { fresh.apiKey = apiKey.trim(); checked.apiKey = fresh.apiKey !== ""; }
  }
  deleteLock({ authtoken: authtoken === "" ? "" : null, apiKey: apiKey === "" ? "" : null });
  const candidates = [fresh.authtoken, fresh.apiKey];
  if (checked.authtoken) {
    if (!session.sdkExisting()) throw new PreviewError(501, session.sdkReason(), "WITHOUT_SDK");
    try { await session.checkAuthtoken(fresh.authtoken); }
    catch (e) { throw new PreviewError(400, T`Authtoken rejected: ${ngrokErrorText(e, candidates)}`, "CHECK"); }
  }
  if (checked.apiKey) {
    try { await api.checkApiKey(fresh.apiKey); }
    catch (e) { throw new PreviewError(400, T`API key rejected: ${ngrokErrorText(e, candidates)}`, "CHECK"); }
  }
  // Once more after the checks: a link may have been created while they ran.
  deleteLock({ authtoken: authtoken === "" ? "" : null, apiKey: apiKey === "" ? "" : null });
  // If the key is deleted: release first; if something stays open, 409 APPROVAL_OPEN and nothing saved.
  if (apiKey === "" && z.apiKey) await approvalsBeforeTheDelete(z);
  if (!fresh.authtoken && !fresh.apiKey) {
    store.removeNgrokAccess();
  } else {
    const now = Date.now();
    store.writeNgrokAccess({ ...fresh, checkedAt: checked.authtoken || checked.apiKey ? now : z.checkedAt, error: "" }, now);
  }
  // A session with the old authtoken and without listeners has no purpose any more.
  if (fresh.authtoken !== z.authtoken) await sessionToIfEmpty();
  return readAccess();
}

export async function deleteAccess() {
  const n = store.previewLinksActive().length;
  if (n) throw new PreviewError(409, T`The ngrok access cannot be removed — ${countSet(n)}. Revoke first.`, "ACTIVE");
  await approvalsBeforeTheDelete(store.ngrokAccessRaw()); // 409 APPROVAL_OPEN if a reservation would stay open
  if (store.previewLinksActive().length) throw new PreviewError(409, T("A link was created during removal — revoke it first."), "ACTIVE");
  store.removeNgrokAccess();
  await session.sessionClosed();
  return { ok: true };
}

// ── Links ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function list() {
  const mode = modeFrom(store.ngrokAccessRaw());
  return {
    active: store.previewLinksActive().map(linkFrom),
    history: store.previewLinksHistory(HISTORY).map(linkFrom),
    mode, limit: LIMIT[mode], sdk: session.sdkExisting(),
  };
}

/** `{ projectId, instance, serviceId, validDays }` — routes.js checks the shape. Returns the link (`online`). */
export async function createOne({ projectId, instance, serviceId, validDays }, { now = Date.now() } = {}) {
  const z = store.ngrokAccessRaw();
  const mode = modeFrom(z);
  if (mode === "off") throw new PreviewError(412, T("No ngrok access stored — Settings → Integrations → ngrok."), "WITHOUT_ACCESS");
  if (!session.sdkExisting()) throw new PreviewError(501, session.sdkReason(), "WITHOUT_SDK");
  const active = store.previewLinksActive().length;
  if (active >= LIMIT[mode]) throw new PreviewError(409, limitText(mode, active), "LIMIT");
  const project = store.getProject(projectId);
  if (!project) throw new PreviewError(404, T("Unknown project."), "PROJECT");
  const service = store.getProjectService(serviceId);
  if (!service || service.projectId !== project.id) throw new PreviewError(404, T("Unknown service (in this project)."), "SERVICE");
  const port = Number(service.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new PreviewError(400, T`The service “${service.name}” has no port — only a service with a port can be shared.`, "WITHOUT_PORT");
  }
  const target = targetFor({ projectId: project.id, instance, port });
  // From here to the row no await: limit and row are ONE step (two concurrent requests do not overtake each other).
  const id = randomUUID();
  store.createPreviewLink({
    id, projectId: project.id, instance, serviceId: service.id, port, mode,
    createdAt: now, runningSinceAt: validDays ? now + validDays * DAY_MS : null,
  });
  report(store.previewLink(id));
  try {
    let domain = null;
    if (mode === "names") {
      const r = await reserveName(z.apiKey, project.name);
      store.changePreviewLink(id, { ngrokDomainId: r.id });
      domain = r.domain;
    }
    const h = await session.open({ authtoken: z.authtoken, target, domain, metadata: `cbase-preview:${id}`, stoppedText: stoppedTextOf({ projectId: project.id, instance }) });
    if (!store.changePreviewLink(id, { url: h.url, state: "online", error: "" }, { onlyActive: true })) {
      // Ended while it was being created (revoke or a delete path, targetRemoved): the row is ended — this path cleans up listener and name.
      await h.close();
      await approve(store.previewLink(id));
      await sessionToIfEmpty();
      const b = store.previewLink(id);
      const text = b?.endedReason === "error" && b.error ? T`The link was ended while it was being created: ${b.error}` : T("The link was revoked while it was being created.");
      throw new PreviewError(409, text, "REVOKE", { link: linkFrom(b) });
    }
    handles.set(id, { ...h, target });
    store.setNgrokAccessError("");
    const l = store.previewLink(id);
    report(l);
    return linkFrom(l);
  } catch (e) {
    if (e instanceof PreviewError) throw e;
    const text = ngrokErrorText(e);
    log(`create ${id}`, text);
    store.setNgrokAccessError(text);
    const l = await end({ id }, "error", { error: text });
    throw new PreviewError(502, text, "NGROK", { link: linkFrom(l) });
  }
}

/** Revoke by the user. `null` = unknown id; a second revoke returns the ended link. */
export async function revoke(id) {
  const l = store.previewLink(id);
  if (!l) return null;
  return linkFrom(l.endedAt ? l : await end(l, "revoke"));
}

const hostOf = (u) => { try { return new URL(u).hostname || null; } catch { return null; } };

/** Reopen an active link (after a restart or an error) — true on success; otherwise it is in `error`. */
async function reopen(l) {
  const z = store.ngrokAccessRaw();
  try {
    if (!z.authtoken) throw new PreviewError(412, "No ngrok authtoken stored.", "WITHOUT_ACCESS");
    const target = targetFor({ projectId: l.projectId, instance: l.instance, port: l.port });
    const domain = l.mode === "names" ? hostOf(l.url) : null;
    if (l.mode === "names" && !domain) throw new PreviewError(409, "Link without an address — its name is unknown.", "WITHOUT_URL");
    const h = await session.open({ authtoken: z.authtoken, target, domain, metadata: `cbase-preview:${l.id}`, stoppedText: stoppedTextOf(l) });
    if (!store.changePreviewLink(l.id, { url: h.url, state: "online", error: "" }, { onlyActive: true })) {
      await h.close();
      return false;
    }
    handles.set(l.id, { ...h, target });
    report(store.previewLink(l.id));
    return true;
  } catch (e) {
    placeOnError(l, e instanceof PreviewError ? e.message : ngrokErrorText(e));
    return false;
  }
}

/** Put an active link into `error` (without a listener) — logs and reports only a NEW text (the tick asks every minute). */
function placeOnError(l, text) {
  const fresh = l.state !== "error" || l.error !== text;
  if (fresh) log(`link ${l.id}`, text);
  if (store.changePreviewLink(l.id, { state: "error", error: text }, { onlyActive: true }) && fresh) report(store.previewLink(l.id));
}

export const PROJECT_GONE_SENTENCE = "Project deleted — the link has ended.";
export const SERVICE_GONE_SENTENCE = "Service deleted — the link has ended.";
export const INSTANCE_GONE_SENTENCE = "Instance removed — the link has ended.";
export const RELOCATED_SET = "The project now runs in a project container — the link (on B) has ended.";

/**
 * Hook of the data layer (store.setTargetRemovedObserver, wired in server.js): a delete path removed a target.
 * SYNCHRONOUS — the affected links are ended (reason `error`) before the delete path returns; the post-work (listener
 * closed, SSE, name released, session closed) starts at once and runs in the background (`previewPostWork()`). Returns
 * the ended link ids.
 * `{ kind: "instance", projectId, instances }` · `{ kind: "project", projectId }` · `{ kind: "service", projectId, serviceIds }`.
 */
export function targetRemoved(event) {
  const { kind, projectId } = event || {};
  let hits, set;
  if (kind === "instance") {
    const names = new Set((event.instances || []).map(String));
    hits = (l) => l.projectId === String(projectId) && l.instance != null && names.has(l.instance);
    set = INSTANCE_GONE_SENTENCE;
  } else if (kind === "project") {
    hits = (l) => l.projectId === String(projectId);
    set = PROJECT_GONE_SENTENCE;
  } else if (kind === "service") {
    const ids = new Set((event.serviceIds || []).map(Number));
    hits = (l) => ids.has(Number(l.serviceId));
    set = SERVICE_GONE_SENTENCE;
  } else return [];
  const ended = [];
  for (const l of store.previewLinksActive().filter(hits)) {
    const b = endRow(l.id, "error", { error: set });
    if (!b) continue;
    ended.push(l.id);
    const p = cleanAfter(l.id, b.h).catch((e) => log(`post-work ${l.id}`, e)).finally(() => postWork.delete(p));
    postWork.add(p);
  }
  return ended;
}

/** Waits until the post-work of `targetRemoved` is done (tests, server end). */
export async function previewPostWork() {
  while (postWork.size) await Promise.all([...postWork]);
}

/**
 * The safety net on the tick: why an active link has no target any more, or `""`. Project gone, service gone, instance
 * gone (it is no longer in the database), or a link WITHOUT an instance (127.0.0.1 in the backend) whose project has been
 * converted meanwhile — the project's service is no longer there then. If the instance cannot be read (instanceTarget
 * throws), that is "unknown", not "gone" (empty is not unknown): `""`, the next tick asks again.
 */
function targetGone(l) {
  if (!store.getProject(l.projectId)) return PROJECT_GONE_SENTENCE;
  const d = store.getProjectService(l.serviceId);
  if (!d || d.projectId !== l.projectId) return SERVICE_GONE_SENTENCE;
  try {
    if (l.instance != null && !instanceTarget(`${l.projectId}/${l.instance}`)) return INSTANCE_GONE_SENTENCE;
    if (l.instance == null && instanceTarget(`${l.projectId}/main`)) return RELOCATED_SET;
  } catch (e) {
    log(`target of link ${l.id} not readable`, e);
  }
  return "";
}

/**
 * The safety net for the ADDRESS: hold the target of an open listener against the one computed today. Same ⇒ `""`.
 * Different (the same instance recreated, new IP) ⇒ close the listener and reopen on the new target (`"redirected"`).
 * Without an IP (instance not running right now) ⇒ listener closed, link in `error` — the tick reopens as soon as it has
 * one again (`"withoutTarget"`).
 */
async function checkTarget(l) {
  const h = handles.get(l.id);
  if (!h) return "";
  let target;
  try {
    target = targetFor({ projectId: l.projectId, instance: l.instance, port: l.port });
  } catch (e) {
    if (!(e instanceof PreviewError)) { log(`target of link ${l.id} not readable`, e); return ""; }
    handles.delete(l.id);
    await h.close();
    placeOnError(store.previewLink(l.id) || l, e.message);
    return "withoutTarget";
  }
  if (target === h.target) return "";
  handles.delete(l.id);
  await h.close();
  log(`link ${l.id}`, `target changed (${h.target} → ${target}) — reopening`);
  await reopen(store.previewLink(l.id) || l);
  return "redirected";
}

let procedure = null;

/**
 * The tick (and the test, with a time): ends exactly the expired active links (expiry time <= now; unlimited never) and
 * those without a target (targetGone), holds the target of every open listener against today's (checkTarget), retries
 * failed releases and reopens links in `error`. If one is already running, the call waits for it. Returns `{ expired,
 * orphaned, redirected, withoutTarget, approved, reopened }` (link ids).
 */
export function checkProcedure(now = Date.now(), { reopen: reopen2 = true } = {}) {
  if (procedure) return procedure;
  procedure = (async () => {
    const r = { expired: [], orphaned: [], redirected: [], withoutTarget: [], approved: [], reopened: [] };
    for (const l of store.previewLinksActive()) {
      if (l.runningSinceAt != null && l.runningSinceAt <= now) { await end(l, "expired", { now }); r.expired.push(l.id); continue; }
      const gone = targetGone(l);
      if (gone) { await end(l, "error", { now, error: gone }); r.orphaned.push(l.id); continue; }
      const changeover = await checkTarget(l);
      if (changeover) r[changeover].push(l.id);
    }
    const z = store.ngrokAccessRaw();
    for (const l of store.previewLinksWithoutApproval()) if (await approve(l, z)) r.approved.push(l.id);
    if (reopen2) {
      for (const l of store.previewLinksActive()) {
        if (l.state === "error" && !handles.has(l.id) && (await reopen(l))) r.reopened.push(l.id);
      }
    }
    return r;
  })().finally(() => { procedure = null; });
  return procedure;
}

/**
 * After a restart: reopen every active, not expired link (names: the same domain, NO new reservation); a row without
 * `url` was an aborted creation and becomes `ended` (`error`). Then `checkProcedure(now)` once.
 */
export async function reinstate({ now = Date.now() } = {}) {
  for (const l of store.previewLinksActive()) {
    if (handles.has(l.id)) continue;
    if (!l.url) { await end(l, "error", { now, error: "Creation aborted (server restart)." }); continue; }
    if (l.runningSinceAt != null && l.runningSinceAt <= now) continue; // checkProcedure ends it right after
    if (targetGone(l)) continue; // ditto
    await reopen(l);
  }
  return checkProcedure(now, { reopen: false });
}

let tick = null;

export function startTick() {
  if (tick) return;
  tick = setInterval(() => { checkProcedure(Date.now()).catch((e) => log("tick", e)); }, TICK_MS);
  tick.unref();
}

export function stopTick() {
  if (tick) clearInterval(tick);
  tick = null;
}

/** Hook for the restart grace (server.js, AFTER the project restore): in the background — holds neither start nor quiet. */
export function previewRestartGrace() {
  reinstate()
    .catch((e) => log("restart grace", e))
    .finally(() => startTick());
}

/** Hook for the server end (awaited): close the session, at most 5 s. Rows and reservations stay for the restart. */
export async function previewServerEnd() {
  stopTick();
  try { await previewPostWork(); } catch { /* every post-work logs by itself */ }
  handles.clear();
  let clock;
  const deadline = new Promise((r) => { clock = setTimeout(r, SERVER_END_MS); clock.unref?.(); });
  try { await Promise.race([session.sessionClosed().catch((e) => log("server end", e)), deadline]); }
  finally { clearTimeout(clock); }
}
