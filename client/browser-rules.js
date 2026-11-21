// Pure rules of the native browser in the cbase client.
//
// Everything here runs without Electron and is therefore testable (client/test). The Electron
// side (browser.js) makes none of these decisions itself: it measures (is someone listening
// locally? does the container have the port?) and then asks here.
import { instanceForScope } from "./forwarding-rules.js";

// ── Profile per scope ────────────────────────────────────────────────────────
// The web's scope key is `proj:<id>` / `ws:<id>`; an Electron partition must not contain colons
// (it becomes a folder name under userData). Lowercase first, then replace everything outside
// [a-z0-9] with "-": without lowercasing, `proj:ABC` and `proj:XYZ` would both collapse to
// `proj----`. Ids are UUIDs, so the mapping is unique for them.
export function scopeProfile(scope) {
  const s = String(scope || "").toLowerCase().replace(/[^a-z0-9]/g, "-");
  return `persist:browser-${s || "empty"}`;
}

// ── Auto-forward: the one decision per request ───────────────────────────────
// Inputs are measurements, the output is one word. Rules in order:
//  (0) Subrequests only count when they come from a LOCAL page. `onBeforeRequest` sees only the
//      target URL, not who asks — without this rule an `<img src="http://localhost:5432/">` on
//      ANY visited page would make the client bind a tunnel into the container that every
//      program on this machine can then reach. A main-frame navigation is exempt: a human
//      triggered it.
//  (1) We already serve the local port → let through. Compared is the LOCAL port (the one in the
//      URL), not the container port: after choosing "other port" the two differ, and we would
//      otherwise mistake our own listener for a foreign process.
//  (2) A FOREIGN process listens locally: only for a main-frame navigation AND when the container
//      has the port is the user asked ("hint") — no silent redirect. A subrequest (API, HMR), or
//      a port the container does not have, goes through to the local process.
//  (3) Nobody listens locally: if the container has the port → forward (same number); otherwise
//      let through, and the page shows its connection error.
// `containerHas` is three-valued. `null` means "not measurable" (gateway unreachable, no answer
// within the deadline, unreadable) — which is not "does not have it": a main frame without a
// local listener gets "not-measurable", the request is cancelled and the pane says why
// (notMeasurableText). Subrequests and anything with a local listener still go through.
// `"ambiguous"` means several project containers hold the port and none belongs to the scope
// (forwarding-rules.js instanceForScope): the main frame gets a choice, a subrequest goes through.
export function forwardDecision({ port, ourLocalPorts, localForeign, containerHas, mainFrame, originLocal }) {
  if (ourLocalPorts && ourLocalPorts.has(port)) return "letThrough";
  if (!mainFrame && originLocal !== true) return "letThrough";
  if (containerHas === "ambiguous") return mainFrame ? "choice" : "letThrough";
  if (localForeign) return mainFrame && containerHas === true ? "hint" : "letThrough";
  if (containerHas === null && mainFrame) return "not-measurable";
  return containerHas === true ? "forward" : "letThrough";
}

// ── Measuring: does the container have the port? ─────────────────────────────
// Deadline for the question to the server. The server caps each `docker exec` at 10 s
// (server/backend/electron/server/ports.js INSTANCE_CAP_MS); the deadline must exceed that cap,
// or the client would take a slow but correct answer for "not measurable". The main frame is HELD
// during the measurement (onBeforeRequest) — it waits rather than failing silently.
// Guard: client/test/browser-rules.test.mjs reads the cap from ports.js.
export const CONTAINER_DEADLINE_MS = 12_000;

// Why a measurement is `has: null`. Only an expired deadline is worth re-measuring
// (measurementForRequest). `deadline`: no answer within CONTAINER_DEADLINE_MS (main.js
// sessionRequest marks the abort with `deadline: true`); `status:<n>`: the server answered with
// n ≥ 400 (401 = expired session, 502 = container restarting); `network`: any other throw;
// `unreadable`: not JSON or no `open`; `no-server`: no server address.
function errorReason(e) {
  if (e?.deadline === true) return "deadline";
  if (Number.isInteger(e?.status)) return `status:${e.status}`;
  return "network";
}

/**
 * Does the container have the port a page of the scope addressed? `question(url, { timeoutMs })`
 * is the GET with the session (main.js sessionRequest), `base` the server URL, `activeInstance()`
 * the pill's choice (read when the answer arrives — it can change meanwhile). The question is
 * LIGHT (`&registered=1`): open/closed per namespace only, without process resolution. Output as
 * forwarding-rules.js instanceForScope; `has: null` means "not measurable", never "does not have
 * it", and then carries `reason` (see errorReason).
 */
export async function containerMeasurement({ question, base, port, scope, activeInstance }) {
  const not = (reason) => ({ has: null, instance: null, nullTarget: undefined, reason });
  if (typeof question !== "function" || !base) return not("no-server");
  let body;
  try {
    body = await question(`${base}/api/ports/running?ports=${port}&registered=1`, { timeoutMs: CONTAINER_DEADLINE_MS });
  } catch (e) {
    return not(errorReason(e));
  }
  try {
    const j = JSON.parse(body);
    if (!Array.isArray(j?.open)) return not("unreadable");
    return instanceForScope(j.open, scope, port, activeInstance?.() ?? null);
  } catch {
    return not("unreadable");
  }
}

/**
 * Cache of measurements per (scope, port). An HMR page fires dozens of subrequests at the same
 * port before the first measurement returns: many requests, ONE measurement. A result is valid for
 * `appliesMs` — including "not measurable" (`containerHas: null`), otherwise every wave of
 * subrequests would start a new measurement while the gateway is failing. For the MAIN FRAME a
 * remembered null does not count (`measurement(port, scope, { withoutNull: true })`): it measures
 * again, so "reload to measure again" stays true. Whatever is forgotten during a measurement
 * (`forgetPort`, `clear`) keeps its result out of the cache: it was measured against the old state.
 */
export function measurementCache({ measure, appliesMs, now = () => Date.now() }) {
  const measurements = new Map(); // "<scope>|<port>" -> measurement plus { port, since }
  const running = new Map();   // "<scope>|<port>" -> Promise
  let state = 0;               // counts every `clear`
  const portState = new Map(); // port -> counts every `forgetPort`
  const statusOf = (port) => `${state}:${portState.get(port) || 0}`;
  return {
    measurement(port, scope, { withoutNull = false } = {}) {
      const k = `${scope}|${port}`;
      const old = measurements.get(k);
      if (old && now() - old.since < appliesMs && !(withoutNull && old.containerHas === null)) return Promise.resolve(old);
      const open = running.get(k);
      if (open) return open;
      const prior = statusOf(port);
      const p = (async () => {
        const m = { ...(await measure(port, scope)), port, since: now() };
        if (statusOf(port) === prior) measurements.set(k, m);
        return m;
      })().finally(() => { if (running.get(k) === p) running.delete(k); });
      running.set(k, p);
      return p;
    },
    // All measurements of one port, across scopes — including running ones.
    forgetPort(port) {
      portState.set(port, (portState.get(port) || 0) + 1);
      for (const [k, m] of measurements) if (m.port === port) measurements.delete(k);
      for (const k of [...running.keys()]) if (k.endsWith(`|${port}`)) running.delete(k);
    },
    clear() {
      state++;
      measurements.clear();
      running.clear();
    },
  };
}

/**
 * The measurement for ONE request. `measure(opts)` is the measurement through the cache. A
 * subrequest takes whatever the cache knows, including a remembered null (it goes through anyway).
 * A main frame takes no remembered null (`withoutNull`) and re-measures once, but only if the
 * DEADLINE expired and nobody listens locally: after an expired deadline the server usually
 * finishes the first question and the second shares its result, whereas a 401 or an unreadable
 * answer does not change by asking again. With a local listener, re-measuring would only hold the
 * page for up to twice CONTAINER_DEADLINE_MS instead of letting it talk to the local process.
 */
export async function measurementForRequest(measure, mainFrame) {
  if (!mainFrame) return measure({});
  const m = await measure({ withoutNull: true });
  return m?.containerHas === null && !m.localForeign && m.reason === "deadline" ? measure({ withoutNull: true }) : m;
}

/** The sentence in the pane when the main frame cannot tell whether the container has the port — one per cause. */
export function notMeasurableText(port, reason) {
  const question = "whether a project container holds it";
  const status = /^status:(\d+)$/.exec(String(reason ?? ""));
  if (status) {
    const n = Number(status[1]);
    if (n === 401 || n === 403) {
      return `Port ${port}: cbase rejected the question ${question} (${n}) — the sign-in has expired, the page was not loaded. Sign in again, then reload.`;
    }
    return `Port ${port}: cbase answered ${n} to the question ${question} — the page was not loaded. Reload to measure again.`;
  }
  if (reason === "network") return `Port ${port}: cbase was unreachable, so it is unknown ${question} — the page was not loaded. Reload to measure again.`;
  if (reason === "unreadable") return `Port ${port}: the answer from cbase on ${question} was unreadable — the page was not loaded. Reload to measure again.`;
  if (reason === "no-server") return `Port ${port}: no cbase server address is set — cannot measure ${question}; the page was not loaded.`;
  return `Port ${port}: cbase did not say in time ${question} — the page was not loaded. Reload to measure again.`;
}

// ── Port from a URL ──────────────────────────────────────────────────────────
// Only spellings of this machine count; everything else is no candidate for forwarding. Without a
// port the scheme's default applies. `0.0.0.0` is included because the address bar treats it as
// local (nav-url.ts) and every connection to it ends on this machine.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);
const DEFAULT_PORT = { "http:": 80, "ws:": 80, "https:": 443, "wss:": 443 };

export function portFromUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!LOCAL_HOSTS.has(u.hostname)) return null;
  const preset = DEFAULT_PORT[u.protocol];
  if (!preset) return null;
  const port = u.port ? Number(u.port) : preset;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: u.hostname, port };
}

// Does the request come from a page of this machine? Meant is the address of the TAB (main frame),
// not of the request. `about:blank` and an empty tab do not count: they have no origin.
export function originIsLocal(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (!/^(https?|wss?):$/.test(u.protocol)) return false;
  return LOCAL_HOSTS.has(u.hostname);
}

// ── Permissions of pages in the native browser ───────────────────────────────
// Electron's default without a handler is "allow everything". This browser runs on the user's
// machine, with their camera, microphone and location, and the pane has neither a permission
// dialog nor a way to revoke a grant. So: nothing beyond what a page needs for viewing. Whoever
// adds a permission here builds the UI for it first.
const PERMISSIONS_ALLOWED = new Set(["fullscreen", "clipboard-sanitized-write"]);

export function allowedPermission(name) {
  return PERMISSIONS_ALLOWED.has(String(name || ""));
}

// The same URL with a different port (the "other port" choice in the hint). An unreadable URL
// yields null rather than a guess.
export function urlWithPort(url, newPort) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!Number.isInteger(newPort) || newPort < 1 || newPort > 65535) return null;
  u.port = String(newPort);
  return u.toString();
}

// ── Lifetime of scopes ───────────────────────────────────────────────────────
// `queue` is the list of scopes in memory, current first. Opening a scope moves it to the front;
// it and the previously current one stay, everything older falls (views are destroyed, the
// remembered tabs stay in the settings).
export function liveScopes(queue, fresh) {
  const rest = (queue || []).filter((s) => s !== fresh);
  const stays = [fresh, ...rest.slice(0, 1)];
  const falls = rest.slice(1);
  return { stays, falls };
}

// ── Bounds of the view ───────────────────────────────────────────────────────
// The renderer reports the rectangle of its host area in CSS pixels relative to the window content
// (getBoundingClientRect); Electron wants whole DIPs. The DEVICE pixel ratio plays no part, the
// PAGE zoom does: at zoom level z one CSS pixel is z DIPs, and without the factor the page would
// sit too small and offset in its area. Overhang is clipped; what has no area left is null (not a
// 0×0 rectangle: setBounds with width 0 leaves an invisible but focusable view).
export function clampRect(rect, content, zoom = 1) {
  if (!rect || !content) return null;
  const values = [rect.x, rect.y, rect.width, rect.height, content.width, content.height];
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const z = typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const left = Math.max(0, Math.round(rect.x * z));
  const top = Math.max(0, Math.round(rect.y * z));
  const right = Math.min(Math.round(content.width), Math.round((rect.x + rect.width) * z));
  const bottom = Math.min(Math.round(content.height), Math.round((rect.y + rect.height) * z));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { x: left, y: top, width, height };
}

// ── Keyboard in a focused view ───────────────────────────────────────────────
// Only with ⌘ (macOS) or Ctrl, only these six; everything else stays with the page. `w` matters
// most: without it "Close Window" would close the whole app, because the view does not consume
// the key itself. Shift or Alt on top means "not our shortcut" and is passed through.
const KEYS = { l: "address-bar", r: "reload", t: "newTab", w: "tabClose", "[": "back", "]": "before" };

export function keyCommand(input) {
  if (!input || input.type !== "keyDown") return null;
  if (!(input.meta || input.control)) return null;
  if (input.shift || input.alt) return null;
  return KEYS[String(input.key || "").toLowerCase()] || null;
}

// ── Remembered tabs ──────────────────────────────────────────────────────────
// Stored in client-settings.json under `browserTabs[scope]`: only URLs and the index of the active
// tab. Titles are not stored (they return on load), nor are about:blank tabs. If nothing remains
// the result is null, and opening creates exactly one about:blank tab.
export function tabsToRemember(tabs, activeId) {
  const including = (tabs || []).filter((t) => typeof t.url === "string" && t.url && t.url !== "about:blank");
  if (!including.length) return null;
  const idx = including.findIndex((t) => t.id === activeId);
  return { urls: including.map((t) => t.url), active: idx >= 0 ? idx : 0 };
}

// The way back: a stored entry becomes a list of URLs plus active index, tolerating what a
// settings file may carry after months (foreign types, index out of range).
export function rememberedTabs(entry) {
  const urls = Array.isArray(entry?.urls) ? entry.urls.filter((u) => typeof u === "string" && u) : [];
  if (!urls.length) return { urls: ["about:blank"], active: 0 };
  const active = Number.isInteger(entry.active) && entry.active >= 0 && entry.active < urls.length ? entry.active : 0;
  return { urls, active };
}
