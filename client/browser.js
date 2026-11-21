// The native browser in the cbase client.
//
// Why it exists: the streamed user browser ran through several network hops and delivered a few
// frames per second with noticeable input latency. Here Chromium runs on THIS machine — one
// `WebContentsView` per tab, bound to the rectangle of the pane in the web UI. The agent browser
// stays streamed (it runs in the container and belongs to the agent).
//
// The division of labor is deliberate: this file holds what Electron NEEDS (views, sessions,
// bounds, IPC) and what must be measured (is someone listening locally? does the container have
// the port?). Every DECISION derived from that lives in `browser-rules.js` — pure functions,
// tested (client/test/browser-rules.test.mjs).
//
// No fallback: if a view fails, the reason is in the state as `error` and the pane shows it. A
// client without this module has no `window.cbaseClient.browser` — the web then uses the stream.
// A version switch, not an error path.
import { app, WebContentsView, ipcMain, session } from "electron";
import nodeNet from "node:net";

import { containerMeasurement, allowedPermission, forwardDecision, rememberedTabs, originIsLocal, clampRect, liveScopes, measurementCache, measurementForRequest, notMeasurableText, portFromUrl, scopeProfile, tabsToRemember, keyCommand, urlWithPort } from "./browser-rules.js";
import { localPortsForScope, forwardingNeedsMeasurement } from "./forwarding-rules.js";

// Chrome match patterns know NO port — `http://localhost/*` matches every port on that host.
// Hence four patterns each for three hosts; `[::1]` cannot be expressed in match patterns and so
// drops out of auto-forward (typing that address by hand gets the forward via the pill).
// `0.0.0.0` is included because the address bar normalizes it as local (nav-url.ts).
const FILTER = {
  urls: [
    "http://localhost/*", "http://127.0.0.1/*", "http://0.0.0.0/*",
    "https://localhost/*", "https://127.0.0.1/*", "https://0.0.0.0/*",
    "ws://localhost/*", "ws://127.0.0.1/*", "ws://0.0.0.0/*",
    "wss://localhost/*", "wss://127.0.0.1/*", "wss://0.0.0.0/*",
  ],
};

// How long a measurement per port is valid. Without a cache every subrequest of an HMR page would
// ask again — dozens per second, each with a TCP attempt and a gateway request. This also holds
// for "not measurable"; only the main frame ignores a remembered null (browser-rules.js measurementCache).
const MEASUREMENT_APPLIES_MS = 5000;
// Deadline of the local connection attempt. A listening process on 127.0.0.1 answers within
// microseconds; the deadline is an emergency brake against a hanging firewall, not a measurement.
const LOCAL_PROBE_MS = 300;
// Tabs are saved in batches: one navigation fires `did-navigate`, `page-title-updated` and
// `did-stop-loading` in quick succession, and every write is a file access.
const SAVE_TICK_MS = 500;
const MAX_URL = 4096;

const isText = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;

// `startForward(containerPort, wantLocal, source, instance)` and `forwards` belong to main.js — a second tunnel
// management next to the ports pill's would be two truths about the same local port.
// `sessionRequest(url, { timeoutMs })` is a GET with the gateway session (the browser's deadline is
// browser-rules.js CONTAINER_DEADLINE_MS, not the default of main.js); `readSettings`/`writeSettings` are main.js's
// client-settings.json: the remembered tabs live next to the remembered forwards.
// `activeInstance()` is the pill's choice (main.js): if it holds the port, the browser takes it — before the scope's
// project (forwarding-rules.js instanceForScope). When the choice changes, main.js clears the measurements.
// `senderMay(ev)` and `openExternally(url, cause)` are the shell's ONE sender check and ONE way out (main.js, rules in
// shell-rules.js). If one is missing, every channel is closed or nothing opens: a dead button beats an unchecked one.
export function installBrowser({ win, startForward, forwards, serverUrl, sessionRequest, readSettings, writeSettings, senderMay, openExternally, activeInstance }) {
  // A window without `contentView` is a too-old Electron. No throw: the module stays installed
  // and answers with a state that carries the reason — the pane shows it.
  const canViews = Boolean(win?.contentView && typeof WebContentsView === "function");

  const scopes = new Map(); // scope -> Scope
  let queue = [];           // scope keys, current first (browser-rules.liveScopes)
  let tabCounter = 0;
  let hintCounter = 0;
  const openHints = new Map(); // id -> { scope, port, url, instance, candidates? }
  // Measurements are per (scope, port): WHICH instance has a port depends on the scope — two projects both listen on
  // 3000 in their containers, and a project's page means its own (forwarding-rules.js instanceForScope). The cache
  // itself is a rule (browser-rules.js measurementCache). A measurement:
  // { localForeign, containerHas, reason, instance, nullTarget, candidates, port, since }.
  let saveTimer = null;

  // A window that no longer exists has no layers: EVERY access to `win` goes through this guard.
  // `getContentSize()` throws on a destroyed window, and a throw in the main process takes the
  // whole app down.
  const windowAlive = () => { try { return Boolean(win) && !win.isDestroyed(); } catch { return false; } };

  // ── State upward ───────────────────────────────────────────────────────────
  const send = (channel, payload) => {
    try { if (windowAlive()) win.webContents.send(channel, payload); } catch { /* window gone */ }
  };

  function stateOf(s) {
    return {
      scope: s.scope,
      tabs: s.tabs.map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        active: t.id === s.activeId,
        loading: t.loading,
        canBack: t.canBack,
        canForward: t.canForward,
      })),
      devtools: s.devtools,
      error: s.error,
      bounds: s.bounds,
      visible: s.visible,
    };
  }

  const report = (s) => { if (s) send("cbase:browser-state", stateOf(s)); };

  // ── Remembering tabs ───────────────────────────────────────────────────────
  function saveTabsSoon() {
    if (!writeSettings || saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveTabs(); }, SAVE_TICK_MS);
    saveTimer.unref?.();
  }

  function saveTabs() {
    if (!writeSettings || !readSettings) return;
    const st = readSettings();
    const browserTabs = { ...(st.browserTabs || {}) };
    for (const s of scopes.values()) {
      const remembered = tabsToRemember(s.tabs, s.activeId);
      if (remembered) browserTabs[s.scope] = remembered;
      else delete browserTabs[s.scope];
    }
    try { writeSettings({ ...st, browserTabs }); } catch { /* disk full or similar — no reason to stop the browser */ }
  }

  // ── Measuring: is someone listening locally? does the container have the port? ──
  // Both loopback families, because a service may listen on only one of them and Chromium resolves
  // "localhost" to BOTH: a process on [::1]:3000 would be invisible via 127.0.0.1, we would create
  // a forward, and the page would still talk to that process.
  function attempt(host, port) {
    return new Promise((resolve) => {
      let finished = false;
      const end = (v) => {
        if (finished) return;
        finished = true;
        clearTimeout(t);
        try { sock.destroy(); } catch {}
        resolve(v);
      };
      const t = setTimeout(() => end(false), LOCAL_PROBE_MS);
      t.unref?.();
      let sock;
      try { sock = nodeNet.connect({ host, port }); } catch { return end(false); }
      sock.once("connect", () => end(true));
      sock.once("error", () => end(false));
    });
  }

  async function localOccupied(port) {
    const [v4, v6] = await Promise.all([attempt("127.0.0.1", port), attempt("::1", port)]);
    return v4 || v6;
  }

  // `has: null` means "not measurable" (`reason` says why), not "does not have it" (browser-rules.js). The scope picks,
  // among several namespaces with this port, the one of its own project; the answer names the instance the forward
  // goes to. Deadline, query and evaluation live in browser-rules.js containerMeasurement.
  const containerHasPort = (port, scope) =>
    containerMeasurement({ question: sessionRequest, base: serverUrl?.(), port, scope, activeInstance });

  const cache = measurementCache({
    appliesMs: MEASUREMENT_APPLIES_MS,
    measure: async (port, scope) => {
      const [localForeign, container] = await Promise.all([localOccupied(port), containerHasPort(port, scope)]);
      return {
        localForeign, containerHas: container.has, reason: container.reason, instance: container.instance, nullTarget: container.nullTarget,
        candidates: container.candidates || [],
      };
    },
  });
  // The measurement per (scope, port), cached and guarded against concurrency; `opts.withoutNull` for the main frame.
  const measurement = (port, scope, opts) => cache.measurement(port, scope, opts);
  // All measurements of one port, across scopes.
  const forgetPort = (port) => cache.forgetPort(port);

  // Which LOCAL ports we serve ourselves. `forwards` is keyed by (instance, CONTAINER port), and
  // after choosing "other port" the two numbers differ — using the key here would mistake our own
  // listener for a foreign process. Per scope and measurement: the local port of a forward that
  // does NOT lead to the scope's project, although that project holds the port, does not count as
  // ours (forwarding-rules.js localPortsForScope).
  const ourLocalPorts = (scope, m) => localPortsForScope([...forwards.values()], scope, m);
  const forwardingTo = (local) => [...forwards.values()].find((f) => f.localPort === local);

  // ── Auto-forward on a scope's session ──────────────────────────────────────
  function autoForward(s) {
    s.session.webRequest.onBeforeRequest(FILTER, (details, callback) => {
      const target = portFromUrl(details.url);
      if (!target) return callback({});
      const port = target.port;
      const mainFrame = details.resourceType === "mainFrame";
      // The origin is the address of the TAB, not of the request: only a local page may trigger a
      // tunnel with its subrequests (browser-rules, rule 0).
      let originLocal = false;
      try { originLocal = originIsLocal(details.webContents?.getURL?.() || ""); } catch { originLocal = false; }
      // Rule 1 without measuring: a port we already serve is not asked about — never for a subrequest (HMR, API), for a
      // main frame only while the forward there matches the scope (`ws:` or the own project's instance). If the forward
      // of ANOTHER project sits there, the main frame measures: if the own project holds the port, the hint asks
      // instead of silently showing the other project's app.
      const onPort = forwardingTo(port);
      if (onPort && (!mainFrame || !forwardingNeedsMeasurement(onPort, s.scope))) return callback({});
      if (!mainFrame && !originLocal) return callback({});
      // Not measurable is not "does not have it": the main frame takes no remembered null and re-measures once after an
      // expired deadline (browser-rules.js measurementForRequest).
      measurementForRequest((opts) => measurement(port, s.scope, opts), mainFrame).then(async (m) => {
        // Asked fresh, not the set from above: between measurement and decision another request
        // (or a click in the pill) may have forwarded the port already.
        const choice = forwardDecision({
          port, ourLocalPorts: ourLocalPorts(s.scope, m), localForeign: m.localForeign || Boolean(forwardingTo(port)),
          containerHas: m.containerHas, mainFrame, originLocal,
        });
        if (choice === "letThrough") return callback({});
        if (choice === "not-measurable") {
          // The server did not say whether a project container holds the port. Letting the request through would end
          // in "connection refused", like a port nobody has. So it is cancelled (-20, for which the pane shows no
          // second error), and the pane says why, per cause; a reload measures again.
          s.error = notMeasurableText(port, m.reason);
          report(s);
          return callback({ cancel: true });
        }
        if (choice === "hint") {
          // No silent redirect: the request is cancelled, the user chooses.
          const id = `h${++hintCounter}`;
          openHints.set(id, { scope: s.scope, port, url: details.url, instance: m.instance });
          send("cbase:browser-hint", { id, scope: s.scope, kind: "port-occupied", port, url: details.url });
          return callback({ cancel: true });
        }
        if (choice === "choice") {
          // Several project containers hold the port and none belongs to the scope: no guessing — the card names the
          // candidates, the user picks an instance, and ONLY one of those gets forwarded (hintResponse "instance:<k>").
          const id = `h${++hintCounter}`;
          openHints.set(id, { scope: s.scope, port, url: details.url, instance: null, candidates: m.candidates });
          send("cbase:browser-hint", { id, scope: s.scope, kind: "ambiguous", port, url: details.url, candidates: m.candidates });
          return callback({ cancel: true });
        }
        // "forward": the request is HELD until the listener is up — otherwise it would run into the
        // very connection error it is meant to fix.
        const r = await startForward(port, port, "browser", m.instance).catch((e) => ({ error: String(e?.message || e) }));
        // The forward makes the measurement stale; the next request asks rule 1.
        forgetPort(port);
        if (r?.error || !r?.localPort) return callback({});
        // A race for the local port (someone took it between measurement and binding): the forward
        // then sits elsewhere. The main frame is redirected there, a subrequest is left alone — a
        // rewritten API call would be a foreign origin.
        if (r.localPort !== port) {
          const fresh = mainFrame ? urlWithPort(details.url, r.localPort) : null;
          return callback(fresh ? { redirectURL: fresh } : {});
        }
        callback({});
      }).catch(() => callback({}));
    });
  }

  // ── Views ──────────────────────────────────────────────────────────────────
  function newView(s, url) {
    const view = new WebContentsView({
      webPreferences: {
        session: s.session,
        // NO preload, no Node integration: foreign web content loads here. The bridge belongs to
        // the cbase UI, not to the pages it displays.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const tab = { id: `t${++tabCounter}`, view, title: "", url: url || "about:blank", loading: false, canBack: false, canForward: false };
    const wc = view.webContents;

    // `navigationHistory` exists since Electron 32; the two calls directly on webContents are the
    // older, now deprecated way. Both forms, no version guessing.
    const afterHistory = () => {
      const h = wc.navigationHistory;
      tab.canBack = h ? h.canGoBack() : wc.canGoBack();
      tab.canForward = h ? h.canGoForward() : wc.canGoForward();
    };
    const refresh = ({ save = false } = {}) => {
      tab.url = wc.getURL() || tab.url;
      afterHistory();
      report(s);
      if (save) saveTabsSoon();
    };

    wc.on("page-title-updated", (_e, title) => { tab.title = String(title || "").slice(0, 300); report(s); });
    wc.on("did-start-loading", () => { tab.loading = true; report(s); });
    wc.on("did-stop-loading", () => { tab.loading = false; refresh({ save: true }); });
    wc.on("did-navigate", () => { s.error = null; refresh({ save: true }); });
    wc.on("did-navigate-in-page", (_e, _url, isMainFrame) => { if (isMainFrame) refresh({ save: true }); });
    wc.on("did-fail-load", (_e, code, description, _url, isMainFrame) => {
      // -3 is ERR_ABORTED: every click that replaces a running navigation produces it. -20 is
      // ERR_BLOCKED_BY_CLIENT, and in this view WE are the only blocker: it is always our own
      // hint, which is already shown as a card.
      if (!isMainFrame || code === -3 || code === -20) return;
      s.error = `${description || "Load failed"} (${code})`;
      tab.loading = false;
      report(s);
    });
    wc.on("render-process-gone", (_e, details) => {
      s.error = `The page crashed (${details?.reason || "unknown"})`;
      report(s);
    });
    // `target=_blank` / window.open → a new tab in the pane, not a foreign window.
    wc.setWindowOpenHandler(({ url: target }) => {
      if (isText(target, MAX_URL)) openTab(s, target);
      return { action: "deny" };
    });
    // Keyboard of a focused view. ⌘W is why this block exists: without preventDefault it would
    // close the cbase window, because the page does not consume the key.
    wc.on("before-input-event", (ev, input) => {
      const command = keyCommand(input);
      if (!command) return;
      ev.preventDefault();
      if (command === "address-bar") send("cbase:browser-address-bar", s.scope);
      else if (command === "reload") wc.reload();
      else if (command === "newTab") openTab(s, "about:blank");
      else if (command === "tabClose") closeTab(s, tab.id);
      else if (command === "back") wc.navigationHistory?.goBack?.() ?? wc.goBack?.();
      else if (command === "before") wc.navigationHistory?.goForward?.() ?? wc.goForward?.();
    });

    // A page may close itself (`window.close()`). Then the webContents is gone but the view stays —
    // a tab that can be clicked but no longer used. So it is removed like a closed tab (including
    // the "never zero tabs" promise). `tab.way` tells this apart from our own destroying,
    // otherwise closeTab would run into itself.
    wc.on("destroyed", () => { if (!tab.gone) closeTab(s, tab.id); });

    view.setVisible(false);
    try { win.contentView.addChildView(view); } catch { /* window being torn down */ }
    if (url && url !== "about:blank") wc.loadURL(url).catch(() => {});
    return tab;
  }

  // The webContents of a tab, as long as it exists. After the page's `window.close()`,
  // `view.webContents` is undefined, and `tab.view.webContents.loadURL(…)` then throws
  // SYNCHRONOUSLY, before there is a promise that could catch it.
  function wcOf(tab) {
    try {
      const wc = tab?.view?.webContents;
      return wc && !wc.isDestroyed() ? wc : null;
    } catch { return null; }
  }

  function destroyTab(tab) {
    tab.gone = true;
    try { if (windowAlive()) win.contentView.removeChildView(tab.view); } catch {}
    try { wcOf(tab)?.close(); } catch {}
  }

  function activeTab(s) {
    return s.tabs.find((t) => t.id === s.activeId) || null;
  }

  // Where the active view sits: the last reported non-null rectangle of ANY host. There are two
  // hosts (browser page and chat rail); if one reports `null` because its tab is hidden, the other
  // takes over. If neither reports anything, the view is invisible.
  function visibleRect(s) {
    for (const hostId of s.hostRow) {
      const r = s.hosts.get(hostId);
      if (r) return r;
    }
    return null;
  }

  function create(s) {
    const tab = activeTab(s);
    if (!tab || !windowAlive()) return;
    const content = win.getContentSize?.() || [];
    // The window's page zoom converts the pane's CSS pixels to DIPs (clampRect); without it the
    // page would sit too small and offset after a ⌘+.
    let zoom = 1;
    try { zoom = win.webContents.getZoomFactor() || 1; } catch { zoom = 1; }
    const rect = clampRect(visibleRect(s), { width: content[0] ?? 0, height: content[1] ?? 0 }, zoom);
    // Obscured = an overlay covers the pane in the web and we show a still frame. The view then
    // stays invisible even while the host keeps reporting bounds (dragging the window, scrolling).
    const show = Boolean(rect) && !s.obscured;
    for (const t of s.tabs) if (t !== tab) t.view.setVisible(false);
    if (rect) tab.view.setBounds(rect);
    tab.view.setVisible(show);
    s.bounds = rect;
    s.visible = show;
  }

  function allHide() {
    for (const s of scopes.values()) {
      s.hosts.clear();
      s.hostRow = [];
      s.bounds = null;
      s.visible = false;
      // The obscuring falls too: it is a state ONLY the renderer takes back, and the renderer is
      // gone right now. Without this line a view that had a modal above it on reload would stay
      // invisible forever.
      s.obscured = false;
      for (const t of s.tabs) t.view.setVisible(false);
      // And it must be reported: the pane only reports CHANGES of its rectangle. If it does not
      // learn that its host was forgotten, it stays silent with the same rectangle.
      report(s);
    }
  }

  // ── Scopes ─────────────────────────────────────────────────────────────────
  // The session of a scope, with its permissions. Electron's default without a handler is "allow
  // everything" — notifications, geolocation, camera, microphone, clipboard read, without a single
  // dialog. Here that would be the user's own camera.
  function scopeSession(scope) {
    const ses = session.fromPartition(scopeProfile(scope));
    try {
      ses.setPermissionRequestHandler((_wc, permission, done) => done(allowedPermission(permission)));
      ses.setPermissionCheckHandler((_wc, permission) => allowedPermission(permission));
      ses.setDevicePermissionHandler?.(() => false); // HID, serial, USB: nothing on this machine
    } catch { /* older version without the handlers — Electron's default stays */ }
    return ses;
  }

  function fetchScope(scope) {
    let s = scopes.get(scope);
    if (s) return s;
    s = {
      scope,
      session: scopeSession(scope),
      tabs: [],
      activeId: null,
      devtools: false,
      error: null,
      bounds: null,
      visible: false,
      obscured: false,
      hosts: new Map(),
      hostRow: [],
      // Counter of still-frame requests: "on" takes time (capturePage), "off" answers at once.
      // Without it an "off" would overtake a still running "on", and the late writer would leave
      // the view obscured although no overlay is open anymore.
      stillFrameStatus: 0,
    };
    scopes.set(scope, s);
    autoForward(s);
    const remembered = rememberedTabs(readSettings?.().browserTabs?.[scope]);
    for (const u of remembered.urls) s.tabs.push(newView(s, u));
    s.activeId = s.tabs[remembered.active]?.id || s.tabs[0]?.id || null;
    return s;
  }

  function destroyScope(scope) {
    const s = scopes.get(scope);
    if (!s) return;
    // Remember first, then destroy: after `webContents.close()` getURL() returns nothing.
    const remembered = tabsToRemember(s.tabs, s.activeId);
    if (writeSettings && readSettings) {
      const st = readSettings();
      const browserTabs = { ...(st.browserTabs || {}) };
      if (remembered) browserTabs[scope] = remembered; else delete browserTabs[scope];
      try { writeSettings({ ...st, browserTabs }); } catch {}
    }
    for (const t of s.tabs) destroyTab(t);
    scopes.delete(scope);
    queue = queue.filter((x) => x !== scope);
    // Open hints of this scope belong to it: their answer would load into a view that no longer
    // exists, and unanswered they would stay in the map until quit.
    for (const [id, h] of openHints) if (h.scope === scope) openHints.delete(id);
  }

  function openTab(s, url) {
    const tab = newView(s, url && url !== "about:blank" ? url : "about:blank");
    s.tabs.push(tab);
    s.activeId = tab.id;
    s.error = null;
    create(s);
    report(s);
    saveTabsSoon();
    return tab;
  }

  // A living browser never has zero tabs — the same promise as in the streamed user browser:
  // otherwise the pane would have no address bar and no way back. So the last close creates an
  // empty replacement.
  function closeTab(s, tabId) {
    const idx = s.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    const [removed] = s.tabs.splice(idx, 1);
    destroyTab(removed);
    if (!s.tabs.length) s.tabs.push(newView(s, "about:blank"));
    // The DevTools were attached to THIS view and are gone with it; if the flag stayed, the button
    // would show "open" and the next click would fizzle as closeDevTools on a view without them.
    if (s.activeId === tabId) { s.activeId = (s.tabs[idx] || s.tabs[s.tabs.length - 1]).id; s.devtools = false; }
    s.error = null;
    create(s);
    report(s);
    saveTabsSoon();
  }

  // ── IPC ────────────────────────────────────────────────────────────────────
  // Every call comes from the renderer and is checked before it reaches Electron: sender, types,
  // lengths. The renderer loads from the gateway — not hostile code, but not local code either.
  // The sender goes through main.js's check: the cbase window, its main frame, the server origin.
  const fromWindow = (ev) => typeof senderMay === "function" && senderMay(ev) === true;

  // Registering with an unregister. `ipcMain.handle` THROWS the second time on the same channel,
  // and `ipcMain.on` silently stacks. Both happen here: on macOS closing the window does not quit
  // the app, and the next click in the Dock calls `createWindow` a second time — without this
  // guard the call would die on the throw and the new window would never load its page.
  const channels = { handle: [], on: [] };
  const handle = (channel, fn) => {
    try { ipcMain.removeHandler(channel); } catch {}
    ipcMain.handle(channel, fn);
    channels.handle.push(channel);
  };
  const on = (channel, fn) => {
    ipcMain.removeAllListeners(channel);
    ipcMain.on(channel, fn);
    channels.on.push(channel);
  };

  // A state that only carries the reason: this is how every call we cannot execute answers. The
  // pane shows `error` — no fallback to the stream, no silent nothing.
  const emptyState = (scope, error) => ({ scope: String(scope || ""), tabs: [], devtools: false, error, bounds: null, visible: false });
  const TOO_OLD = "This client cannot create native browser views (Electron too old).";

  // For everything except `open`: an unknown scope is not an error but a message from a pane
  // whose scope was just destroyed — then nothing happens.
  function withScope(ev, scope, fn) {
    if (!fromWindow(ev) || !isText(scope, 200) || !canViews) return null;
    const s = scopes.get(scope);
    return s ? fn(s) : null;
  }

  function openScope(scope) {
    const s = fetchScope(scope);
    // Lifetime: the current and the previously current scope stay in memory, older ones are
    // destroyed. Their tabs are remembered and return on the next open.
    const { stays, falls } = liveScopes(queue, scope);
    queue = stays;
    for (const old of falls) destroyScope(old);
    create(s);
    return s;
  }

  // The three handlers that return a state by contract must never answer with nothing: the pane
  // builds its tab row from it. If the scope has fallen meanwhile (the pane was away too long), it
  // is restored instead of returning an empty row.
  function withState(ev, scope, fn) {
    if (!fromWindow(ev) || !isText(scope, 200)) return emptyState(scope, "invalid scope");
    if (!canViews) return emptyState(scope, TOO_OLD);
    const s = openScope(scope);
    fn(s);
    return stateOf(s);
  }

  handle("cbase:browser:open", (ev, scope) => withState(ev, scope, () => {}));

  on("cbase:browser:bounds", (ev, scope, hostId, rect) => {
    withScope(ev, scope, (s) => {
      if (!isText(hostId, 100)) return null;
      if (rect === null || rect === undefined) {
        s.hosts.delete(hostId);
        s.hostRow = s.hostRow.filter((h) => h !== hostId);
      } else {
        const values = [rect.x, rect.y, rect.width, rect.height];
        if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
        s.hosts.set(hostId, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
        s.hostRow = [hostId, ...s.hostRow.filter((h) => h !== hostId)];
      }
      const prior = JSON.stringify(s.bounds);
      create(s);
      // Only report if something really changed: the host reports on every resize tick.
      if (JSON.stringify(s.bounds) !== prior) report(s);
      return null;
    });
  });

  handle("cbase:browser:stillFrame", async (ev, scope, enabled) => {
    const s = fromWindow(ev) && isText(scope, 200) ? scopes.get(scope) : null;
    if (!s) return null;
    // The state of this request. "off" answers at once, "on" only after capturePage — without the
    // counter an overtaken "on" would write the obscuring back after the "off", and the area would
    // stay empty until some overlay opened and closed again.
    const state = ++s.stillFrameStatus;
    if (!enabled) {
      s.obscured = false;
      create(s);
      report(s);
      return null;
    }
    const tab = activeTab(s);
    let image = null;
    // Capture first, then hide — the other way round the still frame would be empty.
    if (tab && s.visible) {
      try {
        const img = await wcOf(tab)?.capturePage();
        if (img && !img.isEmpty()) image = `data:image/jpeg;base64,${img.toJPEG(70).toString("base64")}`;
      } catch { /* view being torn down — no still frame then, the view is hidden anyway */ }
    }
    if (state !== s.stillFrameStatus) return null; // a newer request has decided meanwhile
    s.obscured = true;
    create(s);
    report(s);
    return image;
  });

  handle("cbase:browser:navigate", (ev, scope, url) => {
    // The URL arrives FULLY normalized from the web (`web/src/lib/nav-url.ts`, bound to
    // `normalizeNavUrl` in the backend). The client loads what it gets — a second normalization
    // here would be a second truth.
    withScope(ev, scope, (s) => {
      if (!isText(url, MAX_URL)) return null;
      const wc = wcOf(activeTab(s));
      if (!wc) return null;
      s.error = null;
      wc.loadURL(url).catch(() => {});
      return null;
    });
  });

  const control = {
    back: (wc) => (wc.navigationHistory?.goBack ? wc.navigationHistory.goBack() : wc.goBack?.()),
    forward: (wc) => (wc.navigationHistory?.goForward ? wc.navigationHistory.goForward() : wc.goForward?.()),
    reload: (wc) => wc.reload(),
    stop: (wc) => wc.stop(),
  };
  for (const [name, fn] of Object.entries(control)) {
    handle(`cbase:browser:${name}`, (ev, scope) => {
      withScope(ev, scope, (s) => {
        const wc = wcOf(activeTab(s));
        if (wc) try { fn(wc); } catch {}
        return null;
      });
    });
  }

  handle("cbase:browser:newTab", (ev, scope, url) => withState(ev, scope, (s) => {
    openTab(s, isText(url, MAX_URL) ? url : "about:blank");
  }));

  handle("cbase:browser:tabClose", (ev, scope, tabId) => withState(ev, scope, (s) => {
    if (isText(tabId, 50)) closeTab(s, tabId);
  }));

  handle("cbase:browser:selectTab", (ev, scope, tabId) => withState(ev, scope, (s) => {
    if (!isText(tabId, 50) || !s.tabs.some((t) => t.id === tabId)) return;
    // The DevTools are attached to ONE view; on a switch they close, otherwise they would show the
    // page of a tab nobody sees. Clearing the flag alone is not enough — the panel would stay
    // open, and the next click would open a second one.
    if (s.devtools) try { wcOf(activeTab(s))?.closeDevTools(); } catch {}
    s.activeId = tabId;
    s.error = null;
    s.devtools = false;
    create(s);
    saveTabsSoon();
  }));

  handle("cbase:browser:devtools", (ev, scope, open) => withScope(ev, scope, (s) => {
    const wc = wcOf(activeTab(s));
    if (!wc) return null;
    try {
      if (open) wc.openDevTools({ mode: "bottom" });
      else wc.closeDevTools();
      s.devtools = Boolean(open);
    } catch { s.error = "DevTools could not be opened."; }
    report(s);
    return null;
  }));

  on("cbase:browser:extern", (ev, url) => {
    if (!fromWindow(ev) || !isText(url, MAX_URL)) return;
    // Only via the one way out (main.js openExternally, rule shell-rules.js externalTarget) — no file:, no scheme of
    // other programs.
    if (typeof openExternally === "function") openExternally(url, "Browser-Pane");
  });

  handle("cbase:browser:hintResponse", async (ev, id, choice) => {
    if (!fromWindow(ev) || !isText(id, 50)) return;
    const h = openHints.get(id);
    openHints.delete(id);
    // "other-port" answers the port-occupied hint; "instance:<identifier>" the choice among several projects — only one
    // of the candidates the client measured itself (the UI cannot smuggle in an instance). Anything else: load nothing.
    const selected = typeof choice === "string" && choice.startsWith("instance:") ? choice.slice("instance:".length) : null;
    if (!h) return;
    let instance;
    if (choice === "other-port" && !h.candidates) instance = h.instance ?? null;
    else if (selected && h.candidates?.includes(selected)) instance = selected;
    else return; // cancel: nothing is loaded
    const r = await startForward(h.port, undefined, "browser", instance).catch((e) => ({ error: String(e?.message || e) }));
    const s = scopes.get(h.scope);
    if (!s) return;
    if (r?.error || !r?.localPort) { s.error = r?.error || "Forwarding failed"; report(s); return; }
    const fresh = urlWithPort(h.url, r.localPort);
    const wc = wcOf(activeTab(s));
    if (fresh && wc) { s.error = null; wc.loadURL(fresh).catch(() => {}); }
    report(s);
  });

  // If the window itself reloads or changes page (⌘R, switching server), the hosts become invalid:
  // the old bounds point at areas that no longer exist. The views stay — when the pane reports
  // again, the tabs are still there.
  // A `history.replaceState` of the UI fires the same event WITH `inPlace` — there the renderer
  // stays, and taking its hosts away would mean an empty area until the rectangle happens to change.
  win.webContents.on("did-start-navigation", (_ev, _url, inPlace, isMainFrame) => {
    if (isMainFrame !== false && inPlace !== true) allHide();
  });
  win.on("resize", () => { for (const s of scopes.values()) create(s); });
  const beforeTheQuit = () => { if (saveTimer) clearTimeout(saveTimer); saveTimer = null; saveTabs(); };
  app.on("before-quit", beforeTheQuit);

  const destroyAll = () => {
    for (const scope of [...scopes.keys()]) destroyScope(scope);
    queue = [];
    openHints.clear();
    cache.clear();
  };

  return {
    // The views belong to the server origin. When the window leaves it (switching server,
    // connect.html), they are not just invisible but wrong — the next server has other scopes.
    // main.js calls this at the three places that change the page.
    destroyAll,
    // The end of this installation: views gone, IPC channels unregistered, listeners removed.
    // Electron does NOT destroy a `WebContentsView` with its window — without this, every tab of
    // every scope would keep running invisibly after the window closes (timers, network, sound).
    // main.js calls this in the window's `closed`.
    unregister() {
      beforeTheQuit();
      destroyAll();
      for (const k of channels.handle) { try { ipcMain.removeHandler(k); } catch {} }
      for (const k of channels.on) { try { ipcMain.removeAllListeners(k); } catch {} }
      channels.handle = [];
      channels.on = [];
      try { app.off?.("before-quit", beforeTheQuit); } catch {}
    },
    // A forward stopped or created by hand invalidates the measurement of ITS port: the next call
    // of the same address must measure again instead of repeating an earlier answer for five
    // seconds. Only these ports — the cache exists against the constant asking of an HMR page,
    // which flows through the same forwards.
    forgetMeasurements(...ports) {
      if (!ports.length) return cache.clear();
      for (const p of ports) if (Number.isInteger(p)) forgetPort(p);
    },
  };
}
