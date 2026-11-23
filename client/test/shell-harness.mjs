// The shell's main process (client/main.js) against a FAKE Electron.
//
// A harness, not a test (the gate's glob is `client/test/*.test.mjs`). No test bench covers the
// Electron side itself — windows, AppKit and notifications need the real binary. What can be
// tested without a window is the DECISION in the main process: which handler sets what on which
// window for which message. For that this harness loads the real `main.js` and redirects its
// imports — `electron` to a fake world, plus the heavy neighbors (`./browser.js`) to replacements
// the test passes in. Everything else (fs, path) is real.
//
// Why not only pure rule files like `browser-rules.js`: every new file in the client is another
// line in `build.files` AND in `client/shell-files.json`, and a file
// forgotten there silently does not ship. (`forwarding-rules.test.mjs` holds both lists against
// the shell's imports.)
//
// The redirect is `module.registerHooks` (synchronous load hooks, Node ≥ 22.15). Every load gets
// its own world via `?cbase-run=<n>` on the URL of `main.js`: this way the same file starts fresh
// several times in ONE test process, and the hooks find out from the parent URL which world is
// meant.
//
// `process.platform` is set to "darwin": the code touches the traffic lights only on macOS, and
// the gate also runs on a Linux runner. The test file is its own process — the change does not
// reach beyond it.
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

Object.defineProperty(process, "platform", { value: "darwin" });

const worlds = new Map(); // run -> world
// What the fake `app.getVersion()` answers — no real version looks like this.
export const FAKE_APP_VERSION = "9.8.7-fake";
let lastRun = 0;

const runOf = (url) => {
  try {
    const n = new URL(url).searchParams.get("cbase-run");
    return n && worlds.has(Number(n)) ? Number(n) : null;
  } catch {
    return null;
  }
};

// The names main.js imports from `electron`. If one is missing, the import fails with
// "does not provide an export named …" — loudly, not silently.
const ELECTRON_NAMES = [
  "app", "BrowserWindow", "dialog", "ipcMain", "Menu", "nativeImage", "nativeTheme", "net",
  "Notification", "screen", "session", "shell",
];

registerHooks({
  resolve(spec, ctx, next) {
    const run = ctx.parentURL ? runOf(ctx.parentURL) : null;
    if (run != null) {
      if (spec === "electron") return { url: `cbase-fake:electron?cbase-run=${run}`, shortCircuit: true };
      if (worlds.get(run).fakes[spec]) {
        return { url: `cbase-fake:fakes?cbase-run=${run}&spec=${encodeURIComponent(spec)}`, shortCircuit: true };
      }
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith("cbase-fake:")) return next(url, ctx);
    const u = new URL(url);
    const world = worlds.get(Number(u.searchParams.get("cbase-run")));
    const access = `globalThis.__cbaseShellWorlds.get(${Number(u.searchParams.get("cbase-run"))})`;
    if (u.pathname === "electron") {
      const rows = ELECTRON_NAMES.map((n) => `export const ${n} = w.electron.${n};`);
      return { format: "module", shortCircuit: true, source: `const w = ${access};\n${rows.join("\n")}\n` };
    }
    const spec = u.searchParams.get("spec");
    const names = Object.keys(world.fakes[spec]);
    // `default` is not an identifier: a replacement for a module with a default export (e.g. `node:http`) carries it as a field.
    const rows = names.map((n) => (n === "default"
      ? `export default w.fakes[${JSON.stringify(spec)}].default;`
      : `export const ${n} = w.fakes[${JSON.stringify(spec)}].${n};`));
    return { format: "module", shortCircuit: true, source: `const w = ${access};\n${rows.join("\n")}\n` };
  },
});
globalThis.__cbaseShellWorlds = worlds;

// A fake Electron world. `userData`/`home`/`appData` are throwaway folders (never the real ones
// under ~/Library/Application Support). `fakes` maps import specifiers to module objects.
export function buildWorld({ fakes = {}, isPackaged = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-shell-"));
  const paths = {
    appData: path.join(root, "appData"),
    userData: path.join(root, "appData", "cbase"),
    home: path.join(root, "home"),
  };
  for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true });

  const ipc = { handle: new Map(), on: new Map() };
  const window = [];
  const extern = []; // every URL `shell.openExternal` received
  const dialogs = []; // the options of every showOpenDialog
  const dialogResponses = []; // what the next dialog returns (otherwise: cancelled)
  const notifications = [];
  const appHandler = new Map();

  // Every assignment to `themeSource` is recorded — including one that sets the same value again.
  const nativeTheme = {
    _source: "system",
    assignments: [],
    get themeSource() { return this._source; },
    set themeSource(v) { this.assignments.push(v); this._source = v; },
  };

  class Events {
    constructor() { this.handler = new Map(); }
    on(ev, fn) {
      if (!this.handler.has(ev)) this.handler.set(ev, []);
      this.handler.get(ev).push(fn);
      return this;
    }
    emit(ev, ...args) { for (const fn of this.handler.get(ev) || []) fn(...args); }
  }

  class WebContents extends Events {
    constructor() {
      super();
      this.sent = []; // every `send(channel, …args)` to the page, in order
      this.zoom = 0;
      this.destroyed = false;
      // The main frame like Electron's `WebFrameMain`: `url` is the last loaded page (the window's loadURL/loadFile),
      // `parent` null. It is the `senderFrame` of every IPC that `send`/`calls` deliver with this sender.
      this.mainFrame = { url: "", parent: null };
      this.openWindow = null; // the handler of `setWindowOpenHandler`
    }
    setWindowOpenHandler(fn) { this.openWindow = fn; }
    send(channel, ...args) { this.sent.push([channel, ...args]); }
    getZoomLevel() { return this.zoom; }
    setZoomLevel(z) { this.zoom = z; }
    isDestroyed() { return this.destroyed; }
  }

  class BrowserWindow extends Events {
    constructor(opts) {
      super();
      this.opts = opts;
      // Which theme applied when the window was built — the promise "BEFORE the first window".
      this.themeAtBuild = nativeTheme.themeSource;
      this.trafficLight = []; // every call to the native traffic lights, in order
      this.destroyed = false;
      this.focused = true;
      this.fullscreen = false;
      this.webContents = new WebContents();
      window.push(this);
    }
    // Deliberately ONLY the two calls Electron 44 has: a fallback to `setTrafficLightPosition`
    // (removed in 28) would find nothing here, and the traffic-light list would stay without position.
    setWindowButtonVisibility(v) { this.trafficLight.push(["visible", v]); }
    setWindowButtonPosition(p) { this.trafficLight.push(["position", { ...p }]); }
    // The last reported visibility of the native buttons.
    get trafficLightVisible() {
      const s = this.trafficLight.filter(([kind]) => kind === "visible");
      return s.length ? s[s.length - 1][1] : undefined;
    }
    isDestroyed() { return this.destroyed; }
    isFullScreen() { return this.fullscreen; }
    isFocused() { return this.focused; }
    isVisible() { return true; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    loadURL(u) { this.loaded = u; this.webContents.mainFrame.url = u; }
    loadFile(f) { this.loaded = f; this.webContents.mainFrame.url = pathToFileURL(f).href; }
    show() {}
    focus() {}
    restore() {}
    minimize() {}
    maximize() {}
    unmaximize() {}
    getBounds() { return { x: 0, y: 0, width: 1440, height: 900 }; }
    setBounds() {}
    // Lose/gain focus like AppKit: state AND event.
    blur() { this.focused = false; this.emit("blur"); }
    focus() { this.focused = true; this.emit("focus"); }
    close() { this.destroyed = true; this.emit("closed"); }
    static fromWebContents(wc) { return window.find((f) => f.webContents === wc) ?? null; }
    static getAllWindows() { return window.filter((f) => !f.destroyed); }
  }

  class Notification extends Events {
    static isSupported() { return true; }
    constructor(opts) {
      super();
      this.opts = opts;
      notifications.push(this);
    }
    show() {
      this.shown = true;
      // The rare case: UNNotification fails WHILE show() is still running.
      if (world.failsImmediately) this.emit("failed", {}, "staged: failed immediately");
    }
  }

  const app = {
    isPackaged,
    dock: undefined,
    setName(n) { this.name = n; },
    // `app.getVersion()`: a visibly fake version — a test that reads it back proves the value came from HERE.
    getVersion: () => FAKE_APP_VERSION,
    getPath(n) {
      if (!(n in paths)) throw new Error(`app.getPath("${n}") is not set in the fake world`);
      return paths[n];
    },
    setPath(n, p) { paths[n] = p; },
    requestSingleInstanceLock: () => true,
    on(ev, fn) {
      if (!appHandler.has(ev)) appHandler.set(ev, []);
      appHandler.get(ev).push(fn);
    },
    emit(ev, ...args) { for (const fn of appHandler.get(ev) || []) fn(...args); },
    whenReady: () => Promise.resolve(),
    quit() { this.ended = true; },
  };

  const world = {
    root,
    paths,
    ipc,
    window,
    extern,
    permissionsHandler: null, // `session.defaultSession.setPermissionRequestHandler`
    dialogs,
    dialogResponses,
    notifications,
    nativeTheme,
    fakes,
    failsImmediately: false,
    electron: {
      app,
      BrowserWindow,
      nativeTheme,
      Notification,
      ipcMain: {
        handle(k, fn) {
          if (ipc.handle.has(k)) throw new Error(`Attempted to register a second handler for '${k}'`);
          ipc.handle.set(k, fn);
        },
        removeHandler(k) { ipc.handle.delete(k); },
        on(k, fn) { ipc.on.set(k, fn); },
        removeAllListeners(k) { ipc.on.delete(k); },
      },
      dialog: {
        async showOpenDialog(_win, opts) {
          dialogs.push(opts);
          return dialogResponses.shift() ?? { canceled: true, filePaths: [] };
        },
        showErrorBox(title, text) { world.errorBox = `${title}: ${text}`; },
      },
      // The last set application menu (the template itself, `buildFromTemplate` passes it through).
      Menu: { buildFromTemplate: (t) => t, setApplicationMenu(m) { world.menu = m; } },
      nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
      screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 5000, height: 5000 } }) },
      session: {
        defaultSession: {
          // The callback on `onCompleted` (client: Codex login detected → OAuth relay) — the test calls it as `welt.requestFinished`.
          webRequest: { onCompleted(_filter, fn) { world.requestFinished = fn; } },
          setPermissionRequestHandler(fn) { world.permissionsHandler = fn; },
        },
      },
      shell: { openExternal: async (u) => { extern.push(u); } },
      net: {
        fetch: async () => { throw new Error("no network in the fake world"); },
        request() { throw new Error("no network in the fake world"); },
      },
    },
    // Deliver an IPC message the way Electron would: with the sender's webContents and its frame (`senderFrame`). The
    // sender is a window (its main frame speaks) or `{ webContents, frame }` — that is how a foreign frame in the cbase
    // window speaks (`frame: { url, parent }`), `frame: null` one that already navigated away.
    event(sender) {
      const wc = sender?.webContents ?? sender ?? {};
      const frame = sender && typeof sender === "object" && "frame" in sender ? sender.frame : (wc.mainFrame ?? null);
      return { sender: wc, senderFrame: frame, returnValue: undefined };
    },
    send(channel, sender, ...args) {
      const fn = ipc.on.get(channel);
      if (!fn) throw new Error(`no ipcMain.on registered for "${channel}"`);
      return fn(world.event(sender), ...args);
    },
    // `ipcRenderer.sendSync`: the answer is the `returnValue` the handler sets.
    sendSync(channel, sender, ...args) {
      const fn = ipc.on.get(channel);
      if (!fn) throw new Error(`no ipcMain.on registered for "${channel}"`);
      const ev = world.event(sender);
      fn(ev, ...args);
      return ev.returnValue;
    },
    // `ipcRenderer.invoke`: the answer of the `ipcMain.handle`.
    calls(channel, sender, ...args) {
      const fn = ipc.handle.get(channel);
      if (!fn) throw new Error(`no ipcMain.handle registered for "${channel}"`);
      return fn(world.event(sender), ...args);
    },
    cleanUp() {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn(`cleaning up ${root}: ${e.message}`); }
    },
  };
  return world;
}

// Loads a main.js fresh into its world. `whenReady` is fulfilled at once; `untilWindow` catches up
// with what runs asynchronously afterwards.
export async function loadMainProcess(file, world) {
  const run = ++lastRun;
  worlds.set(run, world);
  await import(`${pathToFileURL(file).href}?cbase-run=${run}`);
  return world;
}

// Waits until the world has `n` windows — counted in turns of the event loop, not milliseconds:
// the way there is a few microtasks, not a clock. If the count is not reached, it throws with the
// condition in plain text.
export async function untilWindow(world, n = 1) {
  for (let round = 0; round < 1000; round++) {
    if (world.window.length >= n) return world.window[n - 1];
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`after 1000 turns of the event loop the world has ${world.window.length} instead of ${n} windows`);
}

// The modes the web UI can choose — `ThemeMode` in web/src/lib/theme.ts, read by path. Exactly
// these values are sent via `cbaseShell.setTheme`; a mode the shell does not know would silently
// fall through there. The anchor THROWS instead of returning an empty set — an empty set would
// leave every loop over it green.
export function webThemeModes() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "src", "lib", "theme.ts");
  const m = fs.readFileSync(file, "utf8").match(/^export type ThemeMode = ((?:"[a-z]+"(?: \| )?)+);$/m);
  if (!m) throw new Error(`${file}: no line 'export type ThemeMode = "…" | …;' — the anchor no longer matches`);
  return [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
}

// Run a preload (CommonJS, `require("electron")`, `location`) with a fake bridge. Returned is what
// it exposes on `window` and what it sends via IPC.
export function loadPreload(file, { location = { protocol: "http:", origin: "http://127.0.0.1:7718" }, serverUrl = "" } = {}) {
  const exposed = {};
  const sent = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      send: (...a) => sent.push(["send", ...a]),
      invoke: async (...a) => { sent.push(["invoke", ...a]); },
      sendSync: (k) => (k === "cbase:get-server-sync" ? serverUrl : undefined),
      on() {},
      removeListener() {},
    },
  };
  const source = fs.readFileSync(file, "utf8");
  const req = (m) => {
    if (m !== "electron") throw new Error(`the preload requires "${m}" — only "electron" is faked`);
    return electron;
  };
  new Function("require", "location", source)(req, location);
  return { exposed, sent };
}

// ── The shell's tables ───────────────────────────────────────────────────────────────────────────────────────────
// What the shell may hand outward — `externalTarget` from client/shell-rules.js (window open, will-navigate, the
// "openExternal" permission). Allowed: [input, what gets opened] — the parsed form.
export const EXTERN_ALLOWED = [
  ["https://example.com/pfad?x=1", "https://example.com/pfad?x=1"],
  ["http://localhost:3000/", "http://localhost:3000/"],
  ["mailto:maintainer@example.com?subject=Hallo", "mailto:maintainer@example.com?subject=Hallo"],
  // The desktop link of the VS Code pill (web/src/lib/vscode-tunnel.ts): tunnel and container behind the tunnel.
  ["vscode://vscode-remote/tunnel+cbase-k/home/agent/workspaces/Mein%20WS", "vscode://vscode-remote/tunnel+cbase-k/home/agent/workspaces/Mein%20WS"],
  ["vscode://vscode-remote/attached-container+7b22636f6e7461696e65724e616d65223a222f702d61227d@tunnel+cbase-k/home/agent/p",
    "vscode://vscode-remote/attached-container+7b22636f6e7461696e65724e616d65223a222f702d61227d@tunnel+cbase-k/home/agent/p"],
  // The parser drops a control character before the scheme — opened is what was checked.
  ["\u0001https://example.com/", "https://example.com/"],
];
// Rejected: every other scheme, also in upper case or behind a control character, and anything that is not a URL.
export const EXTERN_DISMISSED = [
  "smb://angreifer/freigabe", "SMB://angreifer/freigabe", "\u0001smb://attacker/x", " smb://angreifer/x",
  "file:///System/Applications/Calculator.app", "ssh://angreifer.example", "afp://angreifer/x",
  "vscode://file/etc/passwd", "vscode://ms-vscode-remote.remote-ssh/connect", "vscode-insiders://vscode-remote/tunnel+x/",
  // Under `vscode-remote` only the pill's two authorities — any other selects a resolver in VS Code that connects
  // elsewhere (Remote SSH to a foreign host, local Docker, WSL, Codespaces).
  "vscode://vscode-remote/ssh-remote+angreifer.example/home/x", "vscode://vscode-remote/dev-container+2f746d70/tmp",
  "vscode://vscode-remote/attached-container+7b7d/x", "vscode://vscode-remote/wsl+Ubuntu/x", "vscode://vscode-remote/codespaces+x/",
  "vscode://vscode-remote/attached-container+7b7d@ssh-remote+angreifer.example/x", "vscode://vscode-remote/tunnel+x@ssh-remote+angreifer/x",
  "vscode://vscode-remote/tunnel+x/../ssh-remote+angreifer.example/x", "vscode://vscode-remote/tunnel%2Bx/home", "vscode://vscode-remote/",
  "javascript:alert(1)", "data:text/html,<b>x</b>", "about:blank", "blob:https://example.com/x",
  "x-apple.systempreferences:com.apple.preference.security", "tel:+491234", "", "not a url", null, undefined, 42,
];

// Senders NO channel of the shell accepts, for a window `win` whose main frame shows the UI: an embedded frame of the
// own page, a frame that already navigated away (`senderFrame` null), a sender without a window and ANOTHER window of
// the same origin (a child window). The foreign origin in the main frame is separate (`foreignOrigin`): it may ask the
// one question of the client preload (`cbase:get-server-sync`).
export function foreignSender(world, win) {
  const url = win.webContents.mainFrame.url;
  const child = new world.electron.BrowserWindow({});
  child.loadURL(url);
  return [
    ["subframe of the own page", { webContents: win.webContents, frame: { url, parent: { url } } }],
    ["frame already navigated away", { webContents: win.webContents, frame: null }],
    ["without a window", { webContents: {}, frame: { url, parent: null } }],
    ["other window of the same origin", child],
  ];
}
export const foreignOrigin = (win) => ({ webContents: win.webContents, frame: { url: "https://foreign.example/page", parent: null } });
