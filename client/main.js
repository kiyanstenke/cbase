// cbase client — Electron main process (remote mode).
// No embedded backend: the app connects to a cbase gateway and loads the shared web UI from
// there. Only the connect page (connect.html) and the stored server URL live locally.
// Login/sessions are cookies in the Electron session.
import { app, BrowserWindow, Menu, ipcMain, nativeTheme, screen, session, shell, net } from "electron";
import fs from "node:fs";
import http from "node:http";
import nodeNet from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installBrowser } from "./browser.js";
import { externalTarget, ipcSenderAllowed, oauthRelayTarget, schemaOf } from "./shell-rules.js";
import {
  activeFromSettings, forwardKey, instanceFromIpc, remember, without, sourceTo, fallbackInstance, startState, tunnelSearch,
  tunnelTargetWithoutInstance, switchoverPlan, selectOptions,
} from "./forwarding-rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.setName("cbase");
// Own data directory ("cbase Client"), deliberately not "cbase": an app of that name would
// otherwise share userData (settings, cookies, cache).
app.setPath("userData", path.join(app.getPath("appData"), "cbase Client"));

const settingsFile = () => path.join(app.getPath("userData"), "client-settings.json");
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), "utf8")); } catch { return {}; }
}
function writeSettings(s) {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); } catch {}
}

let mainWindow = null;
// The bridge of the native browser (client/browser.js) — set only after createWindow.
let browserBridge = null;
const serverUrl = () => readSettings().serverUrl || "";
const sameOrigin = (u) => { try { return new URL(u).origin === new URL(serverUrl()).origin; } catch { return false; } };

// ── Opening externally ───────────────────────────────────────────────────────
// The ONE way of this shell to `shell.openExternal` — window open, `will-navigate` and the native browser's button
// (browser.js receives it as `openExternally`); the UI's "openExternal" permission asks the same rule. Whatever the rule
// does not know (shell-rules.js externalTarget: http, https, mailto and the VS Code link) is rejected; only the scheme is
// logged, never the URL. Opened is the parsed form — the one that was checked.
function openExternally(url, cause) {
  const target = externalTarget(url);
  if (!target) {
    console.warn(`cbase: ${cause} — not opened, scheme "${schemaOf(url)}" is not allowed`);
    return false;
  }
  shell.openExternal(target).catch(() => {});
  return true;
}

// ── Who may address the shell ────────────────────────────────────────────────
// EVERY channel of this file and of the native browser (browser.js receives the check as `senderMay`) goes through
// `pageMay`: the cbase window, its main frame, the surface's origin (rule and rationale: shell-rules.js
// ipcSenderAllowed). `onlyOf` puts it in front of a handler; a rejected call answers in the shape its channel promises
// (`rejected`) instead of throwing or hanging — the preload's `sendSync` would hang without a `returnValue`. Once per
// surface and origin the console says who was rejected: a rule that locks out the own UI should be seen, not guessed.
const IPC_REJECTED = "foreign sender";
const reportedSender = new Set();
function originOf(frame) {
  try { const u = new URL(String(frame?.url ?? "")); return u.protocol === "file:" ? "file:" : u.origin; } catch { return "unknown"; }
}
function pageMay(ev, surface) {
  let fromTheWindow = false;
  let frame = null;
  try {
    fromTheWindow = Boolean(mainWindow) && !mainWindow.isDestroyed() && Boolean(ev?.sender) && BrowserWindow.fromWebContents(ev.sender) === mainWindow;
    frame = ev?.senderFrame ?? null;
  } catch { /* sender being torn down — then no */ }
  if (ipcSenderAllowed({ fromTheWindow, frame }, surface, serverUrl())) return true;
  const location = frame ? `${frame.parent != null ? "subframe " : ""}${originOf(frame)}` : "no frame";
  const who = `${surface} ← ${fromTheWindow ? "" : "foreign window, "}${location}`;
  if (!reportedSender.has(who) && reportedSender.size < 50) {
    reportedSender.add(who);
    console.warn(`cbase: IPC call rejected (${who})`);
  }
  return false;
}
const onlyOf = (surface, fn, rejected) => (ev, ...args) => (pageMay(ev, surface) ? fn(ev, ...args) : rejected?.(ev));
const rejectedError = () => ({ error: IPC_REJECTED });

// Checks an entered URL: reachable AND really a cbase gateway (/gw/info).
async function probeGateway(raw) {
  let u = String(raw || "").trim();
  if (!u) return { error: "URL missing" };
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  u = u.replace(/\/+$/, "");
  try {
    const r = await net.fetch(`${u}/gw/info`, { signal: AbortSignal.timeout(6000), headers: { accept: "application/json" } });
    if (!r.ok) return { error: `Server responded with ${r.status}` };
    const j = await r.json().catch(() => null);
    if (!j?.gateway) return { error: "No cbase gateway at this address" };
    return { url: u };
  } catch {
    return { error: "Server unreachable" };
  }
}

function loadTarget(win) {
  const u = serverUrl();
  if (u) win.loadURL(u);
  else win.loadFile(path.join(__dirname, "connect.html"));
}

// The browser views hang on the server origin: their scopes are projects and workspaces of THIS
// server, and they lie as layers ABOVE the page. When the page changes origin (switching server,
// connect page), they are not just invisible but wrong — so they go. A mere reload of the same
// origin is different: there browser.js hides the views and the pane reports its area again.
function leaveServerOrigin() {
  browserBridge?.destroyAll();
}

// The traffic lights sit CENTERED in the header, level with tabs and buttons. In desktop mode the
// header is 48 pt high (36 pt button + 2×6 pt padding), so its center is at 24. AppKit (Electron
// 44, SDK 26) draws the buttons Ø 14 pt in 14×14 frames; their center is `y + 7`, hence y = 17.
// (Under Electron 37 / SDK 15 the center was `y + 8`.) Whoever changes the header height changes
// this too (guard: client/test/shell-client.test.mjs).
const TRAFFIC_LIGHT_POSITION = { x: 16, y: 17 };

// ── Clamping the window size to the screen ───────────────────────────────────
// For the double-click/green-button zoom macOS remembers a "user frame" that is NOT bound to a
// display and restores it verbatim on un-zoom: a frame stored on a large display comes back on a
// smaller one wider than the screen. macOS clamps only the HEIGHT on a display change, never the
// width. So after every un-zoom we clamp to the work area of the display the window is on. If
// the frame fits, the function changes nothing.
function clampToWorkArea(win) {
  if (!win || win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const width = Math.min(b.width, wa.width);
  const height = Math.min(b.height, wa.height);
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width);
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height);
  if (width === b.width && height === b.height && x === b.x && y === b.y) return;
  win.setBounds({ x, y, width, height });
}

// macOS: the traffic lights in an unfocused window.
//
// AppKit draws them in the fill of the app's appearance. Without `nativeTheme.themeSource` that
// is the system appearance — on a light page with a dark system the contrast is ~1.0: invisible.
// With `themeSource` matching the page, AppKit draws them as in any other app, and a change of
// `themeSource` redraws them even in the INACTIVE window.
//
// Consequence: the page reports its chosen theme (`cbase:theme`, below), and from the first
// report on the native buttons of THIS window stay registered without focus. Only a window whose
// page never reports (an older web bundle — the client loads the web from the gateway, which may
// be older than the client) keeps the old behavior: the header draws the grey state itself, and
// so the two do not overlap, the native ones are hidden on blur and shown again on focus —
// including the position, which falls back to the default when the layer is rebuilt.
// In full screen Apple's behavior stays (buttons only when pointing at the top edge).
const themeWindow = new WeakSet(); // windows whose page has reported its theme

function setTrafficLight(win, visible) {
  if (process.platform !== "darwin" || !win || win.isDestroyed() || win.isFullScreen()) return;
  try {
    win.setWindowButtonVisibility(visible);
    if (visible) win.setWindowButtonPosition(TRAFFIC_LIGHT_POSITION);
  } catch { /* a throw in the main process would take the whole app down — better misplaced traffic lights */ }
}

function manageTrafficLights(win) {
  if (process.platform !== "darwin" || !win) return;
  for (const ev of ["focus", "show", "leave-full-screen", "restore", "unmaximize"]) win.on(ev, () => setTrafficLight(win, true));
  win.on("blur", () => { if (!themeWindow.has(win)) setTrafficLight(win, false); });
  setTrafficLight(win, true);
}

// The page reports its CHOSEN mode (preload.cjs → cbaseShell.setTheme) — at start and on every
// switch. 1:1, not the resolved theme: `themeSource` also shifts `prefers-color-scheme` in the
// renderer, and setting the currently resolved theme for "system" would freeze "system" at that
// value. Anything but the three modes is rejected. The mode is stored in the settings file so the
// next start sets it BEFORE the first window — otherwise `system` would apply until the first
// report and the traffic lights would be invisible again. `themeSource` applies to the whole app,
// including the pages of the native browser (their `prefers-color-scheme` follows the cbase theme).
// Guard: client/test/shell-client.test.mjs.
const THEME_MODES = new Set(["light", "dark", "system"]);

function setThemeSource(mode) {
  if (nativeTheme.themeSource !== mode) nativeTheme.themeSource = mode;
}

ipcMain.on("cbase:theme", onlyOf("server", (ev, mode) => {
  if (!THEME_MODES.has(mode)) return;
  setThemeSource(mode);
  const s = readSettings();
  if (s.theme !== mode) writeSettings({ ...s, theme: mode });
  const win = BrowserWindow.fromWebContents(ev.sender);
  if (!win || win.isDestroyed() || themeWindow.has(win)) return;
  themeWindow.add(win);
  // If the first report arrived while the window had no focus, the native buttons are hidden right now.
  setTrafficLight(win, true);
}));

// ── Text size of the whole app ──────────────────────────────────────────────────────────────────
// The page reports its chosen level (preload.cjs → cbaseShell.setTextSize, channel `cbase:textSize`)
// at start and on every change; that sets the check mark under "View → Text size". ONLY from that
// report on are ⌘+ / ⌘− / ⌘0 the text size: the menu then sends "+1", "-1", "0" or a level to the
// page (`cbase:text-size-command`), and the page computes itself (web/src/lib/appearance.ts). A
// page that never reports — an older web bundle, the connect page — keeps the zoom on the same
// keys. The zoom of the whole interface stays reachable under ⌥⌘+ / ⌥⌘− / ⌥⌘0.
// What has reported is a page, not a window: a navigation (reload, switching server) forgets the
// report, and the new page reports again by itself. Anything but the five levels is rejected.
const TEXT_LEVELS = ["compact", "small", "normal", "large", "veryLarge"];
const TEXT_NAMES = { compact: "Compact", small: "Small", normal: "Normal", large: "Large", veryLarge: "Extra large" };
const textLevels = new WeakMap(); // webContents → last reported level
const textListeners = new WeakSet(); // webContents that already carry the navigation listener (one per webContents)

ipcMain.on("cbase:textSize", onlyOf("server", (ev, stage) => {
  if (!TEXT_LEVELS.includes(stage) || !ev.sender) return;
  if (textLevels.get(ev.sender) === stage) return;
  textLevels.set(ev.sender, stage);
  if (!textListeners.has(ev.sender) && typeof ev.sender.on === "function") {
    textListeners.add(ev.sender);
    // Only a REAL page change forgets the report — the app's own routes (pushState) do not.
    ev.sender.on("did-navigate", () => { textLevels.delete(ev.sender); buildMenu(); });
  }
  buildMenu();
}));

// A command from the menu: to the page if it has reported — otherwise the zoom as before.
function textCommand(win, command) {
  const wc = (win && !win.isDestroyed() ? win : mainWindow)?.webContents;
  if (!wc || (typeof wc.isDestroyed === "function" && wc.isDestroyed())) return;
  if (textLevels.has(wc)) { wc.send("cbase:text-size-command", command); return; }
  if (command === "+1") wc.setZoomLevel(wc.getZoomLevel() + 0.5);
  else if (command === "-1") wc.setZoomLevel(wc.getZoomLevel() - 0.5);
  else if (command === "0") wc.setZoomLevel(0);
}

// The drawn buttons need a real effect — the header calls this through the bridge in preload.cjs.
// They always act on the window that sent the request. A current web bundle no longer draws
// buttons; the channel stays for a bundle that still does.
ipcMain.handle("cbase:window-button", onlyOf("server", (ev, action) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  if (!win || win.isDestroyed()) return false;
  if (action === "close") win.close();
  else if (action === "minimize") win.minimize();
  // Green = zoom: the same toggle as the native button.
  else if (action === "zoom") win.isMaximized() ? win.unmaximize() : win.maximize();
  else return false;
  return true;
}, () => false));

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 600,
    title: "cbase",
    backgroundColor: "#eeece6",
    // Traffic-light buttons inside the app header.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    webPreferences: {
      // Bridge: connect page, port forwarding, the chosen theme AND the header's window buttons.
      preload: path.join(__dirname, "preload.cjs"),
      backgroundThrottling: false,
    },
  });

  manageTrafficLights(mainWindow);
  // Popups: same origin (e.g. /gw/admin) as a child window; everything foreign goes to the browser — allowed schemes only.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) return { action: "allow" };
    openExternally(url, "window open");
    return { action: "deny" };
  });
  // Navigation away from the server (e.g. OAuth links from login consoles, the pill's VS Code link) → external browser or
  // the link's app. The navigation itself is always prevented, even if the scheme is rejected.
  mainWindow.webContents.on("will-navigate", (ev, url) => {
    if (url.startsWith("file://") || sameOrigin(url)) return;
    ev.preventDefault();
    openExternally(url, "Navigation");
  });
  // Un-zooming can bring back a frame stored on a LARGER display.
  mainWindow.on("unmaximize", () => clampToWorkArea(mainWindow));
  // On close the bridge must be UNREGISTERED, not just forgotten: Electron does not destroy the
  // browser views with the window (they would keep surfing invisibly), and their IPC channels are
  // global — a second `createWindow` (Dock click on macOS) would otherwise run into "Attempted to
  // register a second handler" and the new window would never load its page.
  mainWindow.on("closed", () => { browserBridge?.unregister(); mainWindow = null; browserBridge = null; });

  // The native browser. It receives the tunnel (startForward/forwards), the gateway session
  // (sessionRequest) and the settings file — everything that already exists here, so there are
  // no two versions of it.
  browserBridge = installBrowser({
    win: mainWindow,
    startForward,
    forwards,
    serverUrl,
    sessionRequest,
    readSettings,
    writeSettings,
    // The same sender check as every channel here and the same way out.
    senderMay: (ev) => pageMay(ev, "server"),
    openExternally,
    // The choice: if the active instance holds a port, the browser takes it (forwarding-rules.js instanceForScope).
    activeInstance,
  });

  loadTarget(mainWindow);
}

// ── Codex OAuth relay ────────────────────────────────────────────────────────
// `codex login` runs INSIDE the user's container and expects the OAuth callback on
// localhost:1455 — but the browser runs HERE on the user's device. So the client binds
// 127.0.0.1:1455 and passes callbacks through the gateway (with the session cookie) to the
// container. The relay starts automatically as soon as the UI triggers a Codex login
// (webRequest observation); after 10 min it removes itself.
const oauthRelay = { server: null, timer: null };

function stopOAuthRelay() {
  try { oauthRelay.server?.close(); } catch {}
  clearTimeout(oauthRelay.timer);
  oauthRelay.server = null;
  oauthRelay.timer = null;
}

function startOAuthRelay() {
  clearTimeout(oauthRelay.timer);
  oauthRelay.timer = setTimeout(stopOAuthRelay, 10 * 60_000);
  if (oauthRelay.server) return; // already running — only extend the timer

  const srv = http.createServer((req, res) => {
    // Only paths under /api/codex-oauth, checked before AND after normalization (shell-rules.js oauthRelayTarget) —
    // otherwise any process on this machine could pass `/../../api/…` through with the gateway session and read the answer.
    const target = oauthRelayTarget(serverUrl(), req.url);
    if (!target) {
      console.warn("cbase: OAuth relay — request outside /api/codex-oauth rejected");
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("cbase: invalid path.");
      return;
    }
    const fwd = net.request({
      url: target,
      method: "GET",
      useSessionCookies: true, // gateway session of the signed-in user
      redirect: "manual",
    });
    // Pass redirects (e.g. to the OpenAI success page) 1:1 to the browser.
    fwd.on("redirect", (status, _method, redirectUrl) => {
      res.writeHead(status || 302, { location: redirectUrl });
      res.end();
      fwd.abort();
    });
    fwd.on("response", (r) => {
      const headers = {};
      for (const [k, v] of Object.entries(r.headers)) {
        if (["content-type", "location", "cache-control"].includes(k.toLowerCase())) headers[k] = v;
      }
      res.writeHead(r.statusCode || 502, headers);
      r.on("data", (c) => res.write(c));
      r.on("end", () => res.end());
      r.on("error", () => { try { res.end(); } catch {} });
    });
    fwd.on("error", () => { res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }); res.end("cbase: server unreachable."); });
    fwd.end();
  });
  srv.on("error", () => { stopOAuthRelay(); }); // port 1455 taken (e.g. a local codex login) → no relay
  srv.listen(1455, "127.0.0.1");
  oauthRelay.server = srv;
}

// ── Port forwarding ──────────────────────────────────────────────────────────
// Makes services from the isolated server environment reachable on THIS device: we bind
// 127.0.0.1:<local> and tunnel every TCP connection as a WebSocket through the gateway
// (/api/tunnel) into the container to 127.0.0.1:<port>. Raw TCP piping — so WebSockets/HMR of the
// forwarded apps work too. Any local browser can then simply open http://localhost:<local>.
// `source`: "manual" is a click in the ports pill, "browser" a forward the native browser created
// itself because a page addressed a localhost port only the container has, "selection" the ports
// of the ONE active instance (`activeInstance` in client-settings.json). Browser forwards are
// never persisted: they reappear on the next call of the same page, and a client that binds
// twenty ports nobody asked for at start takes them away from other programs.
// The key is "<instance>:<port>" (forwarding-rules.js forwardKey) — two projects both listening on 3000 in their
// containers are two forwards, and the second moves aside locally. Without an instance (`null`) the tunnel carries no
// parameter and the server decides as for an old client. The rules are in the header of forwarding-rules.js; this file
// only executes them.
const forwards = new Map(); // "<instance>:<port>" -> { server, port, instance, localPort, conns:Set, source }

// One-time ticket from the gateway (with the Electron app's session) — WebSocket clients send no
// cookies, so the auth travels as a short-lived ticket in the URL.
function tunnelTicket() {
  return new Promise((resolve, reject) => {
    const r = net.request({ url: `${serverUrl()}/gw/tunnel-ticket`, method: "POST", useSessionCookies: true });
    let buf = "";
    r.on("response", (res) => {
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(buf);
          j.ticket ? resolve(j.ticket) : reject(new Error(j.error || "no ticket (signed in?)"));
        } catch { reject(new Error("Gateway response unreadable")); }
      });
      res.on("error", reject);
    });
    r.on("error", () => reject(new Error("Server unreachable")));
    r.end();
  });
}

// A GET to the gateway WITH the signed-in user's session — same shape as `tunnelTicket()`, read-only and without a
// ticket. The native browser uses it for `/api/ports/running?ports=<P>&registered=1` and passes its OWN deadline
// (browser-rules.js CONTAINER_DEADLINE_MS, above the server's docker cap); the 4 s default applies to lifting and
// fallback (checkFallback, liftForwarding), where no main frame waits.
// The error says WHY: `deadline: true` for an expired deadline, `status` for an answer ≥ 400 — browser-rules.js
// containerMeasurement turns that into the reason the pane names.
// `net.request` instead of `fetch`, because only that sends the Electron session's cookies.
function sessionRequest(url, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const r = net.request({ url, method: "GET", useSessionCookies: true });
    const deadline = setTimeout(() => { try { r.abort(); } catch {} reject(Object.assign(new Error("timed out"), { deadline: true })); }, timeoutMs);
    deadline.unref?.();
    let buf = "";
    r.on("response", (res) => {
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        clearTimeout(deadline);
        if ((res.statusCode || 0) >= 400) reject(Object.assign(new Error(`Server responded with ${res.statusCode}`), { status: res.statusCode, body: buf }));
        else resolve(buf);
      });
      res.on("error", (e) => { clearTimeout(deadline); reject(e); });
    });
    r.on("error", (e) => { clearTimeout(deadline); reject(e); });
    r.end();
  });
}

function tunnelWsUrl(containerPort, ticket, instance) {
  const u = new URL(serverUrl());
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/api/tunnel";
  u.search = tunnelSearch(containerPort, ticket, instance);
  return u.toString();
}

// `instance` is in every entry (null without one) — an older UI does not read it and sees the list as before.
const portsList = () =>
  [...forwards.values()].map((f) => ({ port: f.port, instance: f.instance, localPort: f.localPort, connections: f.conns.size, source: f.source || "manual" }));
// Only the list upward. The native browser's port MEASUREMENTS are NOT cleared here: portsChanged
// also fires on every single tunneled TCP connection (open and close), and a cache cleared twice
// per request by our own traffic is none. Only what really changes the port invalidates a
// measurement — start- and stopForward say so themselves.
const portsChanged = () => {
  try { mainWindow?.webContents.send("cbase:ports-changed", portsList()); } catch {}
};

function rememberForward(instance, containerPort, localPort, source = "manual") {
  const s = readSettings();
  writeSettings({ ...s, forwards: remember(s.forwards, { instance, port: containerPort, localPort, source }) });
}

// ── The exclusive selection ──────────────────────────────────────────────────
// Which instance forwards the ports is stored in client-settings.json (`activeInstance`, identifier or null = none) —
// the file is the truth, read on every access (like the server URL). A change goes to the UI (`cbase:ports-active`) and
// invalidates the native browser's measurements: its rule asks the active instance first.
// BRING-ALONG is driven by the UI, not from here: the services pill is on every page of the app, polls
// `/api/project-services` every 30 s anyway and owns the ONE computation "which ports does this instance have"
// (`instancePorts` in web/src/lib/services-status.ts). A poller of our own would be a second version of the same list;
// instead the start binds the stored ports of the choice before any page loads.
const activeInstance = () => activeFromSettings(readSettings());
function setActive(instance) {
  const fresh = instance ?? null;
  const s = readSettings();
  if (activeFromSettings(s) === fresh && "activeInstance" in s) return;
  writeSettings({ ...s, activeInstance: fresh });
  browserBridge?.forgetMeasurements();
  try { mainWindow?.webContents.send("cbase:ports-active", fresh); } catch {}
}
// Every select and bring-along runs in sequence: two clicks in quick succession (or a bring-along of the old choice still
// under way) would otherwise interleave their stops and binds, leaving ports of both instances bound.
let selectChain = Promise.resolve();
function inChain(fn) {
  const p = selectChain.then(fn, fn);
  selectChain = p.catch(() => {});
  return p;
}

// Is a bind attempt running for this container port? Without this map N concurrent requests would
// create N forwards: the entry check `forwards.has` is synchronous, but the map is filled only
// AFTER binding. The surplus ones would be in no list, unreachable for "stop forwarding", and
// would take exactly the ports the user needs. A dev page makes several requests to the same port
// while loading — that is the normal case, not a corner.
const starting = new Map(); // "<instance>:<port>" -> Promise

async function startForward(containerPort, wantLocal, source = "manual", instance = null) {
  const key = forwardKey(instance, containerPort);
  // A click in the pill on a port the browser already forwarded automatically is a REQUEST: the
  // source becomes "manual", and the port then survives a restart. The choice takes over every forward of its instance
  // on its port (forwarding-rules.js sourceTo).
  const takeOver = (localPort) => {
    const f = forwards.get(key);
    const fresh = f ? sourceTo(f.source, source) : null;
    if (f && fresh !== (f.source || "manual")) {
      f.source = fresh;
      if (fresh !== "browser") rememberForward(instance, containerPort, f.localPort, fresh);
      portsChanged();
    }
    return { ok: true, localPort };
  };
  const existing = forwards.get(key);
  if (existing) return takeOver(existing.localPort);
  const running = starting.get(key);
  if (running) {
    const r = await running;
    return r?.localPort ? takeOver(r.localPort) : r;
  }
  const p = bindForward(containerPort, wantLocal, source, instance).finally(() => starting.delete(key));
  starting.set(key, p);
  return p;
}

async function bindForward(containerPort, wantLocal, source, instance) {
  if (typeof WebSocket === "undefined") return { error: "WebSocket client missing (Electron/Node too old)" };

  const conns = new Set();
  // The entry exists BEFORE the listener: every new connection reads the instance from it, not from the argument — so
  // `liftForwarding` can lift a forward without instance to its instance without letting go of the local port.
  const entry = { server: null, port: containerPort, instance, localPort: 0, conns, source };
  const srv = nodeNet.createServer((sock) => {
    sock.setNoDelay(true);
    sock.pause(); // build the tunnel first, then let bytes flow
    conns.add(sock);
    sock.on("close", () => { conns.delete(sock); portsChanged(); });
    (async () => {
      const ticket = await tunnelTicket();
      const ws = new WebSocket(tunnelWsUrl(containerPort, ticket, entry.instance));
      ws.binaryType = "arraybuffer";
      let pauseTimer = null;
      let openBeen = false;
      const teardown = () => {
        // A tunnel that never opened may have failed on a removed copy (404 "unknown instance") — check.
        if (!openBeen) checkFallback(entry); clearInterval(pauseTimer); try { ws.close(); } catch {} sock.destroy(); };
      ws.onopen = () => {
        openBeen = true;
        sock.on("data", (chunk) => {
          try { ws.send(chunk); } catch { teardown(); return; }
          // Backpressure toward the server: pause TCP while the WS buffer is full.
          if (ws.bufferedAmount > 4 * 1024 * 1024 && !pauseTimer) {
            sock.pause();
            pauseTimer = setInterval(() => {
              if (ws.bufferedAmount < 512 * 1024) { clearInterval(pauseTimer); pauseTimer = null; sock.resume(); }
            }, 20);
          }
        });
        sock.on("end", () => { try { ws.close(1000); } catch {} });
        sock.resume();
        portsChanged();
      };
      ws.onmessage = (ev) => { sock.write(Buffer.from(ev.data)); };
      ws.onerror = () => teardown();
      ws.onclose = () => teardown();
      sock.on("error", teardown);
    })().catch(() => { conns.delete(sock); sock.destroy(); });
  });

  // Bind the wished local port; if it is taken, try the next 20.
  const tryListen = (p) => new Promise((resolve) => {
    const onErr = () => resolve(false);
    srv.once("error", onErr);
    srv.listen(p, "127.0.0.1", () => { srv.removeListener("error", onErr); resolve(true); });
  });
  let localPort = 0;
  for (let p = wantLocal || containerPort; p < (wantLocal || containerPort) + 20; p++) {
    if (await tryListen(p)) { localPort = p; break; }
  }
  if (!localPort) return { error: "no free local port found" };

  entry.server = srv;
  entry.localPort = localPort;
  forwards.set(forwardKey(instance, containerPort), entry);
  // Only manual forwards and those of the choice survive a restart (see the comment at `forwards`).
  if (source !== "browser") rememberForward(instance, containerPort, localPort, source);
  // Both numbers: the native browser measures the LOCAL port of a URL, stored is the container's
  // — after "other port" these are two different ones.
  browserBridge?.forgetMeasurements(containerPort, localPort);
  portsChanged();
  return { ok: true, localPort };
}

// `closed` resolves once the local port is really free: `server.close()` releases it only on the next turn of the event
// loop, and switchover rebinds the same port right after — without waiting it would move aside to the next one.
function stopForward(containerPort, instance = null) {
  const f = forwards.get(forwardKey(instance, containerPort));
  if (!f) return { ok: false, closed: Promise.resolve() };
  const closed = new Promise((resolve) => {
    try { f.server.close(() => resolve()); } catch { resolve(); }
  });
  for (const c of f.conns) { try { c.destroy(); } catch {} }
  forwards.delete(forwardKey(instance, containerPort));
  const s = readSettings();
  writeSettings({ ...s, forwards: without(s.forwards, { instance, port: containerPort }) });
  browserBridge?.forgetMeasurements(containerPort, f.localPort);
  portsChanged();
  return { ok: true, closed };
}

// Switchover: the chosen instance gets all its ports on the local ports of the same number; forwards of other instances
// on exactly these local ports end (forwarding-rules.js switchoverPlan). First all stops including freed ports, then the
// binds — the order is why the port does not move aside.
// `mode`: "exclusive" sets the choice and applies it, "bringAlong" binds the missing ports of the ACTIVE instance and
// does nothing for any other (a call that was under way when someone re-selected). Without a mode the plain switchover.
// `ifActive` (forwarding-rules.js selectOptions): the selection only happens if this choice still holds NOW — in the
// chain link, not when queued. A fallback is computed from one choice; had a user's selection been waiting behind the
// running link, the fallback would reset the old choice afterwards. `undefined` means: no condition.
async function selectInstance(instance, ports, mode, ifActive) {
  const selection = mode === "exclusive" || mode === "bringAlong";
  if (ifActive !== undefined && activeInstance() !== ifActive) return { ok: false, error: "the selection has changed in the meantime", active: activeInstance() };
  if (mode === "bringAlong" && (instance ?? null) !== activeInstance()) return { ok: false, error: "not the active instance" };
  if (mode === "exclusive") setActive(instance);
  const plan = switchoverPlan({ forwards: [...forwards.values()], instance, ports, mode });
  const stops = plan.stop.map((f) => stopForward(f.port, f.instance));
  await Promise.all(stops.map((r) => r.closed));
  const source = selection ? "selection" : "manual";
  for (const port of plan.takeOver || []) await startForward(port, port, source, instance).catch(() => {});
  const bound = [];
  for (const port of plan.bind) {
    const r = await startForward(port, port, source, instance).catch((e) => ({ error: String(e?.message || e) }));
    bound.push({ port, ...r });
  }
  const ok = bound.every((g) => !g.error);
  if (!selection) return { ok, stopped: plan.stop, bound };
  return { ok, active: activeInstance(), stopped: plan.stop, bound, takenOver: plan.takeOver, occupied: plan.occupied };
}

// Fallback to main: a tunnel to an instance that no longer exists (removed copy) failed before opening. A WebSocket does
// not expose the status — so this asks `/api/ports/running` with the same instance: the server answers an unknown
// instance with 404, and the rule (`fallbackInstance`) says where to go. The forward moves with its listener to main (the
// local port stays); if main already holds the port, it ends. At most one check at a time per forward, no timed retry.
async function checkFallback(f) {
  if (!f.instance || f.checks) return;
  f.checks = true;
  const old = f.instance;
  try {
    let status = 0;
    let body;
    try { await sessionRequest(`${serverUrl()}/api/ports/running?ports=${f.port}&instance=${encodeURIComponent(old)}`); }
    catch (e) { status = e?.status || 0; body = e?.body; }
    const fresh = fallbackInstance(old, status, body);
    // Between the measurement and here it may have been stopped or lifted — then do nothing.
    if (!fresh || f.instance !== old || forwards.get(forwardKey(old, f.port)) !== f) return;
    if (forwards.has(forwardKey(fresh, f.port)) || starting.has(forwardKey(fresh, f.port))) stopForward(f.port, old);
    else {
      forwards.delete(forwardKey(old, f.port));
      f.instance = fresh;
      forwards.set(forwardKey(fresh, f.port), f);
      if (f.source !== "browser") {
        const s = readSettings();
        writeSettings({ ...s, forwards: remember(without(s.forwards, { instance: old, port: f.port }), { instance: fresh, port: f.port, localPort: f.localPort, source: f.source }) });
      }
      browserBridge?.forgetMeasurements(f.port, f.localPort);
      portsChanged();
    }
    // If the removed copy was the active instance, the CHOICE falls to its project's main too: exclusive, so the copy's
    // remaining forwards end with it; the UI brings main's services along. Whether it IS active is decided by the chain
    // link (`ifActive: alt`), not at this moment: a user's selection already waiting behind the running link would not
    // apply here yet and would otherwise be replaced right away.
    await inChain(() => selectInstance(fresh, [], "exclusive", old));
  } finally { f.checks = false; }
}

// Lift a forward WITHOUT an instance to its instance. A stored forward with `instance: null` tunnels via the old-client
// rule (B if B holds the port, otherwise the ONE instance that holds it) and silently dies once a second project opens the
// same port. The UI knows the project and asks here; but it is lifted only to where the tunnel leads TODAY — measured
// by the same rule via `/api/ports/running` (`tunnelTargetWithoutInstance`), never on request alone. The listener stays
// (the local port is kept, open connections continue); only the key, the instance of new connections and the stored
// entry change.
async function liftForwarding(port, instance) {
  const f = forwards.get(forwardKey(null, port));
  if (!f) return { error: "no forwarding without an instance on this port" };
  if (forwards.has(forwardKey(instance, port)) || starting.has(forwardKey(instance, port))) {
    return { error: "the instance already has a forwarding on this port" };
  }
  let open;
  try { open = JSON.parse(await sessionRequest(`${serverUrl()}/api/ports/running?ports=${port}`))?.open; } catch { open = null; }
  if (!Array.isArray(open)) return { error: "not measurable" };
  if (tunnelTargetWithoutInstance(open, port) !== instance) return { error: "the forwarding does not currently lead to this instance" };
  // Between the measurement and here it may have been stopped or already lifted — then do nothing.
  if (forwards.get(forwardKey(null, port)) !== f || forwards.has(forwardKey(instance, port))) return { error: "changed in the meantime" };
  forwards.delete(forwardKey(null, port));
  f.instance = instance;
  forwards.set(forwardKey(instance, port), f);
  if (f.source === "manual") {
    const s = readSettings();
    writeSettings({ ...s, forwards: remember(without(s.forwards, { instance: null, port }), { instance, port, localPort: f.localPort }) });
  }
  browserBridge?.forgetMeasurements(port, f.localPort);
  portsChanged();
  return { ok: true, localPort: f.localPort };
}

const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;
// Every channel here belongs to the server's UI (`onlyOf("server", …)`); rejected, it answers like an error.
ipcMain.handle("cbase:ports:list", onlyOf("server", () => portsList(), () => []));
// `instance` is optional: an older UI calls forward(port, localPort) and gets the forward without an instance as
// before. An instance that is not an identifier is an error — never silently "none".
ipcMain.handle("cbase:ports:forward", onlyOf("server", async (_ev, port, localPort, instanceRaw) => {
  if (!validPort(port) || (localPort != null && !validPort(localPort))) return { error: "invalid port" };
  const i = instanceFromIpc(instanceRaw);
  if (i.error) return { error: i.error };
  try { return await startForward(port, localPort || undefined, "manual", i.instance); }
  catch (e) { return { error: String(e?.message || e) }; }
}, rejectedError));
ipcMain.handle("cbase:ports:stop", onlyOf("server", (_ev, port, instanceRaw) => {
  if (!validPort(port)) return { error: "invalid port" };
  const i = instanceFromIpc(instanceRaw);
  if (i.error) return { error: i.error };
  return { ok: stopForward(port, i.instance).ok };
}, rejectedError));
// `options`: `{ mode: "exclusive" | "bringAlong", ifActive? }` — the selection, `ifActive` being the condition of a
// fallback by the pill; without options the plain switchover (an older UI keeps calling `select(instance, ports)`).
ipcMain.handle("cbase:ports:select", onlyOf("server", async (_ev, instanceRaw, ports, optionsRaw) => {
  const i = instanceFromIpc(instanceRaw);
  if (i.error) return { error: i.error };
  if (ports != null && (!Array.isArray(ports) || ports.length > 100 || !ports.every(validPort))) return { error: "invalid port" };
  const o = selectOptions(optionsRaw);
  if (o.error) return { error: o.error };
  try { return await inChain(() => selectInstance(i.instance, ports || [], o.mode, o.ifActive)); }
  catch (e) { return { error: String(e?.message || e) }; }
}, rejectedError));
// Read the choice (the pill on load; afterwards `cbase:ports-active`). Its PRESENCE is the version switch of the selection.
ipcMain.handle("cbase:ports:active", onlyOf("server", () => activeInstance(), () => null));
// The instance is REQUIRED here: there is no "lift" without a target.
ipcMain.handle("cbase:ports:lift", onlyOf("server", async (_ev, port, instanceRaw) => {
  if (!validPort(port)) return { error: "invalid port" };
  const i = instanceFromIpc(instanceRaw);
  if (i.error || !i.instance) return { error: i.error || "instance missing" };
  try { return await liftForwarding(port, i.instance); }
  catch (e) { return { error: String(e?.message || e) }; }
}, rejectedError));
// The preload asks synchronously for the server URL to bind the bridge to the origin. It asks BEFORE it knows whether
// its page is the server origin — hence the surface "window" (main frame of the cbase window, any origin); it exposes
// the bridge only if `location.origin` matches. Rejected, the answer is empty: without `returnValue` the preload would hang.
ipcMain.on("cbase:get-server-sync", onlyOf("window", (ev) => { ev.returnValue = serverUrl(); }, (ev) => { ev.returnValue = ""; }));

// Rebind stored forwards at start (listeners are passive — the tunnel itself is created on the
// first connection, then with a fresh ticket). What is bound and what drops out of the file is
// computed by `startState` (forwarding-rules.js).
function restoreForwards() {
  const st = startState(readSettings());
  if (st.changed) writeSettings(st.settings);
  for (const f of st.bind) startForward(f.port, f.localPort, f.source, f.instance).catch(() => {});
}

// Connect page: check the URL, store it, load the app. Both channels belong to connect.html alone (surface "connect").
ipcMain.handle("cbase:connect", onlyOf("connect", async (_ev, raw) => {
  const r = await probeGateway(raw);
  if (r.error) return r;
  writeSettings({ ...readSettings(), serverUrl: r.url });
  // The old server's views do not belong to the new one — its project and workspace ids are
  // different. Before loading, not after: otherwise they would briefly lie above the foreign page.
  leaveServerOrigin();
  if (mainWindow) mainWindow.loadURL(r.url);
  return { ok: true, url: r.url };
}, rejectedError));
ipcMain.handle("cbase:get-server", onlyOf("connect", () => serverUrl(), () => ""));

// "View" instead of `role: "viewMenu"`: ⌘+ / ⌘− / ⌘0 are the app's text size here (once the page
// has reported, see above), the zoom of the whole interface moves to ⌥⌘. Reload, developer tools
// and full screen stay as the role had them. ⌘= is there hidden: on a keyboard without a
// dedicated "+" key it is the same key.
function viewMenu() {
  const current = mainWindow && !mainWindow.isDestroyed() ? textLevels.get(mainWindow.webContents) : undefined;
  const command = (b) => (_item, win) => textCommand(win, b);
  return {
    label: "View",
    submenu: [
      { label: "Larger text", accelerator: "CmdOrCtrl+Plus", click: command("+1") },
      { label: "Larger text", accelerator: "CmdOrCtrl+=", visible: false, acceleratorWorksWhenHidden: true, click: command("+1") },
      { label: "Smaller text", accelerator: "CmdOrCtrl+-", click: command("-1") },
      { label: "Default size", accelerator: "CmdOrCtrl+0", click: command("0") },
      {
        label: "Text size",
        submenu: TEXT_LEVELS.map((s) => ({
          label: TEXT_NAMES[s],
          type: "radio",
          checked: current === s,
          // Without a report the shell does not know which level applies — and the page could not set it.
          enabled: current !== undefined,
          click: command(s),
        })),
      },
      { type: "separator" },
      {
        label: "Whole interface",
        submenu: [
          { role: "zoomIn", accelerator: "Alt+CmdOrCtrl+Plus" },
          { role: "zoomIn", accelerator: "Alt+CmdOrCtrl+=", visible: false, acceleratorWorksWhenHidden: true },
          { role: "zoomOut", accelerator: "Alt+CmdOrCtrl+-" },
          { role: "resetZoom", accelerator: "Alt+CmdOrCtrl+0" },
        ],
      },
      { type: "separator" },
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
}

function buildMenu() {
  const template = [
    { role: "appMenu" },
    {
      label: "Server",
      submenu: [
        {
          label: "Switch server…",
          accelerator: "CmdOrCtrl+Shift+K",
          click: () => {
            leaveServerOrigin();
            mainWindow?.loadFile(path.join(__dirname, "connect.html"));
          },
        },
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow && loadTarget(mainWindow),
        },
      ],
    },
    { role: "editMenu" },
    viewMenu(),
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
  app.whenReady().then(() => {
    // The last reported theme already applies to the first window (see "cbase:theme").
    const remembered = readSettings().theme;
    if (THEME_MODES.has(remembered)) setThemeSource(remembered);
    buildMenu();
    // The UI's "openExternal" permission: Chromium starts the program of a foreign scheme even without us — from an
    // embedded frame, bypassing `will-navigate` — and asks this permission for it, which is silently granted without a
    // handler. It follows the same rule as `openExternally`; every other permission stays granted as before (the native
    // browser's pages have their own sessions and their own handler, browser.js).
    session.defaultSession.setPermissionRequestHandler((_wc, permission, done, details) => {
      if (permission !== "openExternal") return done(true);
      const target = externalTarget(details?.externalURL);
      if (!target) console.warn(`cbase: program launch from the UI — scheme "${schemaOf(details?.externalURL)}" is not allowed`);
      done(Boolean(target));
    });
    // Codex login detected in the UI → arm the OAuth relay on localhost:1455.
    session.defaultSession.webRequest.onCompleted({ urls: ["*://*/api/account/codex/connect"] }, (d) => {
      if (d.method === "POST" && d.statusCode >= 200 && d.statusCode < 300) startOAuthRelay();
    });
    createWindow();
    restoreForwards();
    app.on("activate", () => { if (!mainWindow) createWindow(); });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
