// Theme and traffic lights in the client's main process (client/main.js, client/preload.cjs).
//
// The real main.js runs against a fake Electron (shell-harness.mjs): tested is what the main
// process DOES on a report from the page — which `themeSource`, what is in the settings file,
// which calls a window's native traffic lights receive. Whether AppKit then really draws the
// buttons visibly is not covered here; that is checked in the built client.
//
// Plus the binding to the web: `TRAFFIC_LIGHT_POSITION` — the web computes the header's
// placeholder from it.
//
// Run:  node --test client/test/shell-client.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import nodeNet from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorld, untilWindow, EXTERN_ALLOWED, EXTERN_DISMISSED, foreignSender, foreignOrigin, loadMainProcess, loadPreload, webThemeModes } from "./shell-harness.mjs";
import { DECODE_STAGES, externalTarget, ipcSenderAllowed, OAUTH_PREFIX, oauthRelayTarget } from "../shell-rules.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_MAIN = path.join(here, "..", "main.js");
const CLIENT_PRELOAD = path.join(here, "..", "preload.cjs");
const GATEWAY = "http://gateway.test:7719";

// The neighbor `./browser.js` stays out: it builds WebContentsViews and needs a real window.
// `main.js` only calls `installBrowser` from it and its three return values.
const fakeBrowser = () => ({
  installBrowser: () => ({ unregister() {}, destroyAll() {}, forgetMeasurements() {} }),
});

// A client with a stored server URL (without forwards — they would bind real ports). `browser` replaces the neighbor
// `./browser.js` (the selection tests read what main.js hands it); `fakes` further modules (the OAuth relay: `node:http`).
async function startClient(settings = {}, { browser = fakeBrowser(), fakes = {} } = {}) {
  const world = buildWorld({ fakes: { "./browser.js": browser, ...fakes } });
  // client/main.js itself puts userData at appData/"cbase Client".
  const file = path.join(world.paths.appData, "cbase Client", "client-settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ serverUrl: GATEWAY, forwards: [], ...settings }));
  await loadMainProcess(CLIENT_MAIN, world);
  const win = await untilWindow(world);
  const former = () => JSON.parse(fs.readFileSync(file, "utf8"));
  return { world, win, former };
}

test("cbase:theme rejects everything but light · dark · system — and a rejected report does not count as a report", async () => {
  const { world, win, former } = await startClient();
  try {
    assert.equal(win.loaded, GATEWAY, "the client does not load the stored server URL — the world is wrong");
    for (const wrong of ["sepia", "Dark", "LIGHT", "", " dark", "system ", null, undefined, 1, true, {}, ["dark"], { mode: "dark" }]) {
      world.send("cbase:theme", win, wrong);
    }
    assert.deepEqual(world.nativeTheme.assignments, [], "an unknown mode set themeSource");
    assert.equal(world.nativeTheme.themeSource, "system");
    assert.equal("theme" in former(), false, "an unknown mode was stored — the next start would set it");
    // Without a valid report the old behavior still applies to the window: hide on blur.
    win.blur();
    assert.equal(win.trafficLightVisible, false, "a rejected report switched off the hiding on blur");
  } finally {
    world.cleanUp();
  }
});

test("cbase:theme sets themeSource 1:1 to the CHOSEN mode and stores it next to the other settings", async () => {
  const { world, win, former } = await startClient();
  try {
    world.send("cbase:theme", win, "dark");
    assert.equal(world.nativeTheme.themeSource, "dark");
    assert.equal(former().theme, "dark");
    // "system" stays "system" — not the currently resolved theme (otherwise the mode would freeze).
    world.send("cbase:theme", win, "system");
    assert.equal(world.nativeTheme.themeSource, "system");
    assert.equal(former().theme, "system");
    world.send("cbase:theme", win, "light");
    assert.equal(world.nativeTheme.themeSource, "light");
    assert.deepEqual(world.nativeTheme.assignments, ["dark", "system", "light"]);
    // The settings file also holds the server URL and the forwards — none of that is lost. It also carries the marker
    // of the one-time migration (the first start sets it, see "migration" below).
    assert.deepEqual(former(), { serverUrl: GATEWAY, forwards: [], forwardingsWithoutInstanceRemoved: true, theme: "light" });
  } finally {
    world.cleanUp();
  }
});

test("every mode the web UI can choose (ThemeMode) is set by the client — the seam web ↔ shell", async (t) => {
  const modes = webThemeModes();
  t.diagnostic(`ThemeMode (web/src/lib/theme.ts): ${modes.join(", ")}`);
  assert.ok(modes.includes("system"), "ThemeMode without \"system\" — the anchor reads the wrong line");
  const { world, win } = await startClient();
  try {
    for (const mode of modes) {
      world.send("cbase:theme", win, mode);
      assert.equal(world.nativeTheme.themeSource, mode, `the web UI can choose "${mode}", the client rejects it`);
    }
  } finally {
    world.cleanUp();
  }
});

test("start: the stored mode applies BEFORE the first window; a broken stored value does not apply at all", async () => {
  const light = await startClient({ theme: "light" });
  try {
    assert.equal(light.win.themeAtBuild, "light",
      "the first window was created with `system` — until the page's first report the traffic lights would be invisible on a light page");
  } finally {
    light.world.cleanUp();
  }
  const broken = await startClient({ theme: "sepia" });
  try {
    assert.equal(broken.win.themeAtBuild, "system");
    assert.deepEqual(broken.world.nativeTheme.assignments, [], "a stored unknown mode was set at start");
  } finally {
    broken.world.cleanUp();
  }
});

test("without a report (old web bundle): traffic lights hidden on blur, shown on focus — including the position", async () => {
  const { world, win } = await startClient();
  try {
    assert.deepEqual(win.trafficLight, [["visible", true], ["position", { x: 16, y: 17 }]], "the traffic lights are not shown at creation");
    win.blur();
    assert.equal(win.trafficLightVisible, false, "a window whose page never reports leaves the native buttons under the drawn ones");
    win.focus();
    assert.equal(win.trafficLightVisible, true);
    assert.deepEqual(win.trafficLight.at(-1), ["position", { x: 16, y: 17 }], "the position is missing on re-show — the layer would fall back to the default place");
  } finally {
    world.cleanUp();
  }
});

test("from the first report on the traffic lights of THIS window stay shown — even if they were hidden just then", async () => {
  const { world, win } = await startClient();
  try {
    win.blur();
    assert.equal(win.trafficLightVisible, false);
    // The first report arrives in the hidden state (e.g. the page loads while another app is in front).
    world.send("cbase:theme", win, "light");
    assert.equal(win.trafficLightVisible, true, "the report came without focus, and the native buttons stayed hidden");
    assert.deepEqual(win.trafficLight.at(-1), ["position", { x: 16, y: 17 }]);
    const prior = win.trafficLight.length;
    win.focus();
    win.blur();
    assert.equal(win.trafficLightVisible, true, "after the report, losing focus still hides the native buttons");
    assert.equal(win.trafficLight.slice(prior).some(([kind, v]) => kind === "visible" && v === false), false);
  } finally {
    world.cleanUp();
  }
});

test("only the reporting window: a new window and a sender without a window keep the hiding", async () => {
  const { world, win: a } = await startClient();
  try {
    world.send("cbase:theme", a, "dark");
    // macOS: window closed, app lives on, the Dock click builds a new one — its page has not reported yet.
    a.close();
    world.electron.app.emit("activate");
    const b = await untilWindow(world, 2);
    assert.notEqual(a, b);
    b.blur();
    assert.equal(b.trafficLightVisible, false, "the old window's report applies to the new one — with an old bundle there, both sets of buttons would overlap");
    // A report whose sender belongs to no window sets nothing — it goes through the same sender check as every channel.
    world.send("cbase:theme", { webContents: {} }, "light");
    assert.equal(world.nativeTheme.themeSource, "dark", "a sender without a window set the app's theme");
    b.focus();
    b.blur();
    assert.equal(b.trafficLightVisible, false);
  } finally {
    world.cleanUp();
  }
});

test("the button actions stay: a web bundle that still draws needs cbase:window-button", async () => {
  const { world } = await startClient();
  try {
    assert.equal(typeof world.ipc.handle.get("cbase:window-button"), "function",
      "the channel of the drawn buttons is gone — an old web bundle on the new client would have dead buttons");
  } finally {
    world.cleanUp();
  }
});

test("preload: setTheme only for the server origin, in the same branch as the window buttons", () => {
  const server = loadPreload(CLIENT_PRELOAD, { location: { protocol: "http:", origin: GATEWAY }, serverUrl: GATEWAY });
  const shell = server.exposed.cbaseShell;
  assert.ok(shell, "the server origin gets no cbaseShell");
  // Plus the app's text size (`setTextSize`/`onTextSize`, client only).
  assert.deepEqual(Object.keys(shell).sort(), ["onTextSize", "setTextSize", "setTheme", "windowClose", "windowMinimize", "windowZoom"]);
  shell.setTheme("dark");
  assert.deepEqual(server.sent.at(-1), ["send", "cbase:theme", "dark"], "setTheme does not send via \"cbase:theme\"");
  // The connect page (file://) and a foreign origin do not see the bridge.
  const connect = loadPreload(CLIENT_PRELOAD, { location: { protocol: "file:", origin: "null" }, serverUrl: GATEWAY });
  assert.equal(connect.exposed.cbaseShell, undefined);
  const foreignPage = loadPreload(CLIENT_PRELOAD, { location: { protocol: "https:", origin: "https://foreign.example" }, serverUrl: GATEWAY });
  assert.deepEqual(foreignPage.exposed, {}, "a foreign page gets a bridge");
});

// The app's text size in the "View" menu (client/main.js): ⌘+ / ⌘− / ⌘0 are the text size ONCE the page has reported
// its level — before that (a web bundle without text size, the connect page) the zoom as always. A rejected report does
// not count, a real page change forgets the report.
test("View → Text size: zoom until the page reports, then commands to the page — a page change forgets the report", async () => {
  const { world, win } = await startClient();
  try {
    const view = () => world.menu?.find((m) => m.label === "View");
    const point = (label) => view()?.submenu.find((p) => p.label === label && p.visible !== false);
    const stages = () => view()?.submenu.find((p) => p.label === "Text size")?.submenu ?? [];
    const wc = win.webContents;
    const commands = () => wc.sent.filter(([k]) => k === "cbase:text-size-command").map(([, b]) => b);
    assert.ok(view(), "no \"View\" menu set — the switch is unreachable");
    assert.deepEqual(
      view().submenu.filter((p) => p.accelerator?.startsWith("CmdOrCtrl")).map((p) => [p.label, p.accelerator, p.visible !== false]),
      [["Larger text", "CmdOrCtrl+Plus", true], ["Larger text", "CmdOrCtrl+=", false], ["Smaller text", "CmdOrCtrl+-", true], ["Default size", "CmdOrCtrl+0", true]],
    );
    assert.ok(view().submenu.find((p) => p.accelerator === "CmdOrCtrl+=").acceleratorWorksWhenHidden, "⌘= does not work while hidden");

    // Before the report: zoom as before, nothing to the page, the levels disabled.
    point("Larger text").click(null, win);
    assert.equal(wc.zoom, 0.5);
    point("Smaller text").click(null, win);
    point("Smaller text").click(null, win);
    assert.equal(wc.zoom, -0.5);
    point("Default size").click(null, win);
    assert.equal(wc.zoom, 0);
    assert.deepEqual(stages().map((r) => r.enabled), [false, false, false, false, false]);
    // Nonsense is not a report.
    for (const wrong of ["huge", "Gross", "", null, 3, { stage: "large" }]) world.send("cbase:textSize", win, wrong);
    point("Larger text").click(null, win);
    assert.equal(wc.zoom, 0.5, "after a rejected report ⌘+ no longer went to the zoom");
    point("Default size").click(null, win);
    assert.deepEqual(commands(), []);

    // The page reports: check mark on its level, all levels enabled, commands go to the page, the zoom stays.
    world.send("cbase:textSize", win, "large");
    assert.deepEqual(stages().map((r) => [r.label, r.checked, r.enabled]), [
      ["Compact", false, true], ["Small", false, true], ["Normal", false, true], ["Large", true, true], ["Extra large", false, true],
    ]);
    point("Larger text").click(null, win);
    point("Smaller text").click(null, win);
    point("Default size").click(null, win);
    stages()[0].click(null, win);
    assert.deepEqual(commands(), ["+1", "-1", "0", "compact"]);
    assert.equal(wc.zoom, 0, "after the report ⌘+/⌘− still zoomed");
    // The zoom of the whole interface stays reachable — as a role on ⌥⌘.
    const whole = view().submenu.find((p) => p.label === "Whole interface").submenu.filter((p) => p.visible !== false);
    assert.deepEqual(whole.map((p) => [p.role, p.accelerator]), [["zoomIn", "Alt+CmdOrCtrl+Plus"], ["zoomOut", "Alt+CmdOrCtrl+-"], ["resetZoom", "Alt+CmdOrCtrl+0"]]);

    // A real page change (reload, switching server) forgets the report: zoom again, levels disabled.
    wc.emit("did-navigate");
    assert.deepEqual(stages().map((r) => [r.checked, r.enabled]), Array(5).fill([false, false]));
    point("Larger text").click(null, win);
    assert.equal(wc.zoom, 0.5);
    assert.deepEqual(commands(), ["+1", "-1", "0", "compact"], "after the page change ⌘+ still went to the old page");
  } finally {
    world.cleanUp();
  }
});

test("TRAFFIC_LIGHT_POSITION: centered on the header's center under SDK 26 — and no fallback to setTrafficLightPosition", async (t) => {
  const row = /const TRAFFIC_LIGHT_POSITION = \{ x: (\d+), y: (\d+) \};/;
  const q = fs.readFileSync(CLIENT_MAIN, "utf8");
  const m = q.match(row);
  assert.ok(m, "client/main.js has no TRAFFIC_LIGHT_POSITION line in the expected form");
  const value = { x: Number(m[1]), y: Number(m[2]) };
  // Removed since Electron 28 (breaking-changes.md); falling back to it is a dead branch.
  assert.equal(/setTrafficLightPosition/.test(q), false, "client/main.js still falls back to setTrafficLightPosition");
  t.diagnostic(`TRAFFIC_LIGHT_POSITION client ${JSON.stringify(value)}`);
  // Center of the 48 pt header = 24 = y + 7 under SDK 26.
  assert.deepEqual(value, { x: 16, y: 17 });
  // And at runtime exactly this value goes to the window and to every re-show.
  const { world, win } = await startClient();
  try {
    assert.deepEqual(win.opts.trafficLightPosition, { x: 16, y: 17 });
    assert.equal(win.opts.titleBarStyle, "hiddenInset");
  } finally {
    world.cleanUp();
  }
});

// ── Port forwarding per instance ─────────────────────────────────────────────────────────────────
// The real main.js binds real listeners on 127.0.0.1 — hence free ports from the system (port 0), and in `finally` every
// forward is stopped again via IPC. The tunnel itself is only created on a connection: there a fake `net.request`
// (ticket) and a fake `WebSocket` that only reports its address stand in.

async function freePort() {
  const srv = nodeNet.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}
// Every call speaks as the UI: the living cbase window, its main frame on the server origin — a sender without a window
// would get "foreign sender".
const mainWindow = (world) => world.window.filter((f) => !f.destroyed).at(-1);
const ipc = (world, channel, ...args) => world.calls(channel, mainWindow(world), ...args);
async function untilList(world, n) {
  for (let round = 0; round < 1000; round++) {
    const l = await ipc(world, "cbase:ports:list");
    if (l.length >= n) return l;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`after 1000 turns of the event loop there are not ${n} forwards in the list`);
}
async function allStop(world) {
  for (const f of await ipc(world, "cbase:ports:list")) await ipc(world, "cbase:ports:stop", f.port, f.instance);
}

// Such an entry falls on the FIRST start (migration, next test) — the transfer applies to an entry that appears without
// the field AFTER the migration (an old client after a rollback): with the marker set.
test("forwarding: a stored entry without `instance` is migrated ONCE to `instance: null` at start", async () => {
  const p = await freePort();
  const { world, former } = await startClient({ forwards: [{ port: p, localPort: p }], forwardingsWithoutInstanceRemoved: true });
  try {
    // Read BEFORE the first bind (`listen` needs a turn of the event loop, the start before it runs in microtasks):
    // afterwards binding re-stores the entry anyway and the migration would no longer be visible — but it also applies
    // to an entry whose port cannot be bound.
    assert.deepEqual(former().forwards, [{ instance: null, port: p, localPort: p }], "the old entry is in the file unmigrated");
    const list = await untilList(world, 1);
    assert.deepEqual(list.map((f) => [f.port, f.instance, f.localPort]), [[p, null, p]]);
    assert.deepEqual(former().forwards, [{ instance: null, port: p, localPort: p }]);
  } finally {
    // If the first check fails, binding is still running — wait first, or its listener would keep the test process open.
    await untilList(world, 1).catch(() => {});
    await allStop(world);
    world.cleanUp();
  }
});

test("forwarding: two instances with the same port do not overwrite each other — the second moves aside locally", async () => {
  const p = await freePort();
  const { world, former } = await startClient();
  try {
    const a = await ipc(world, "cbase:ports:forward", p, p, "p-a/main");
    const b = await ipc(world, "cbase:ports:forward", p, p, "p-b/main");
    assert.equal(a.localPort, p);
    assert.ok(b.localPort && b.localPort !== p, `the second instance got ${JSON.stringify(b)} — the same forward as the first`);
    const list = await ipc(world, "cbase:ports:list");
    assert.deepEqual(list.map((f) => [f.instance, f.port, f.localPort]).sort(), [["p-a/main", p, p], ["p-b/main", p, b.localPort]]);
    assert.deepEqual(former().forwards.map((f) => f.instance).sort(), ["p-a/main", "p-b/main"], "the file stores only one of the two");
    // Stopping hits only the named instance.
    assert.deepEqual(await ipc(world, "cbase:ports:stop", p, "p-b/main"), { ok: true });
    assert.deepEqual((await ipc(world, "cbase:ports:list")).map((f) => f.instance), ["p-a/main"]);
    // An instance that is not an identifier is an error — never silently "none".
    assert.deepEqual(await ipc(world, "cbase:ports:forward", p, undefined, 42), { error: "invalid instance" });
  } finally {
    await allStop(world);
    world.cleanUp();
  }
});

test("forwarding: switchover binds all ports of the chosen instance on their number and stops the foreign one there", async () => {
  const p = await freePort();
  const { world, former } = await startClient();
  try {
    await ipc(world, "cbase:ports:forward", p, p, "p-a/main");
    const b = await ipc(world, "cbase:ports:forward", p, p, "p-b/main");
    assert.notEqual(b.localPort, p);
    const r = await ipc(world, "cbase:ports:select", "p-b/main", [p]);
    assert.equal(r.ok, true, JSON.stringify(r));
    const list = await ipc(world, "cbase:ports:list");
    assert.deepEqual(list.map((f) => [f.instance, f.port, f.localPort]), [["p-b/main", p, p]],
      "after the switchover it is not exactly the chosen instance on its port");
    assert.deepEqual(former().forwards, [{ instance: "p-b/main", port: p, localPort: p }]);
    assert.deepEqual(await ipc(world, "cbase:ports:select", "p-b/main", [0]), { error: "invalid port" });
  } finally {
    await allStop(world);
    world.cleanUp();
  }
});

test("forwarding: the tunnel carries the instance as `instance=<identifier>`, without instance no parameter", async () => {
  const { world } = await startClient();
  const realWs = globalThis.WebSocket;
  const addresses = [];
  let reported = null;
  globalThis.WebSocket = class {
    constructor(url) {
      addresses.push(url);
      setImmediate(() => { this.onclose?.(); reported?.(); });
    }
    close() {}
  };
  // The ticket: a fake `net.request` that answers `{ ticket }` at once.
  world.electron.net.request = () => {
    const h = {};
    const r = {
      on(ev, fn) { h[ev] = fn; return r; },
      end() {
        setImmediate(() => {
          const response = new EventEmitter();
          h.response(response);
          response.emit("data", JSON.stringify({ ticket: "T1" }));
          response.emit("end");
        });
      },
      abort() {},
    };
    return r;
  };
  const connect = (port) => new Promise((resolve) => {
    reported = resolve;
    const s = nodeNet.connect(port, "127.0.0.1");
    s.on("error", () => {});
    // If no tunnel comes up the client closes the connection — then the address is missing and the test is red, not silent.
    s.on("close", () => resolve());
  });
  try {
    const including = await ipc(world, "cbase:ports:forward", await freePort(), undefined, "p-a/main");
    await connect(including.localPort);
    const withoutInstance = await ipc(world, "cbase:ports:forward", await freePort(), undefined);
    await connect(withoutInstance.localPort);
    const [u1, u2] = addresses.map((a) => new URL(a));
    assert.equal(u1.pathname, "/api/tunnel");
    assert.equal(u1.searchParams.get("instance"), "p-a/main");
    assert.equal(u1.searchParams.get("ticket"), "T1");
    assert.equal(u2.searchParams.has("instance"), false, "without an instance the tunnel carries an `instance` parameter");
  } finally {
    globalThis.WebSocket = realWs;
    await allStop(world);
    world.cleanUp();
  }
});

// A stored forward without instance is lifted to the instance its tunnel leads to TODAY — measured via
// `/api/ports/running` with the tunnel's rule, never on request alone; the local port stays, the stored entry and every
// new connection carry the instance afterwards.
test("forwarding: lifting a forward without instance — only to the ONE instance that holds the port, on the same local port", async () => {
  const p = await freePort();
  const { world, former } = await startClient();
  const realWs = globalThis.WebSocket;
  const addresses = [];
  let reported = null;
  globalThis.WebSocket = class {
    constructor(url) {
      addresses.push(url);
      setImmediate(() => { this.onclose?.(); reported?.(); });
    }
    close() {}
  };
  // The server: the ticket and the port measurement; `open` is what `/api/ports/running` reports for the port.
  let open = [];
  const requests = [];
  world.electron.net.request = ({ url }) => {
    requests.push(url);
    const h = {};
    const r = {
      on(ev, fn) { h[ev] = fn; return r; },
      end() {
        setImmediate(() => {
          const response = new EventEmitter();
          h.response(response);
          response.emit("data", JSON.stringify(url.includes("/api/ports/running") ? { open: open } : { ticket: "T1" }));
          response.emit("end");
        });
      },
      abort() {},
    };
    return r;
  };
  try {
    const old = await ipc(world, "cbase:ports:forward", p, undefined);
    assert.ok(old.localPort, JSON.stringify(old));
    // Two instances hold the port: the tunnel without instance leads nowhere — do not lift (that is a conflict for the pill).
    open = [{ port: p, instance: "p-a/main" }, { port: p, instance: "p-b/main" }];
    assert.ok((await ipc(world, "cbase:ports:lift", p, "p-a/main")).error);
    // B holds the port: the forward is B's.
    open = [{ port: p, instance: null }, { port: p, instance: "p-a/main" }];
    assert.ok((await ipc(world, "cbase:ports:lift", p, "p-a/main")).error);
    // Only beta holds it: do not lift to alpha, even if the UI asks for it.
    open = [{ port: p, instance: "p-b/main" }];
    assert.ok((await ipc(world, "cbase:ports:lift", p, "p-a/main")).error);
    assert.deepEqual((await ipc(world, "cbase:ports:list")).map((f) => f.instance), [null], "a rejected lift changed something anyway");
    assert.ok(requests.every((u) => u === `${GATEWAY}/api/ports/running?ports=${p}`), requests.join(", "));
    // Only alpha holds it: lift — same local port, the stored entry and new connections carry the instance.
    open = [{ port: p, instance: "p-a/main" }];
    assert.deepEqual(await ipc(world, "cbase:ports:lift", p, "p-a/main"), { ok: true, localPort: old.localPort });
    assert.deepEqual((await ipc(world, "cbase:ports:list")).map((f) => [f.instance, f.port, f.localPort]), [["p-a/main", p, old.localPort]]);
    assert.deepEqual(former().forwards, [{ instance: "p-a/main", port: p, localPort: old.localPort }]);
    await new Promise((resolve) => {
      reported = resolve;
      const s = nodeNet.connect(old.localPort, "127.0.0.1");
      s.on("error", () => {});
      s.on("close", () => resolve());
    });
    assert.equal(new URL(addresses.at(-1)).searchParams.get("instance"), "p-a/main", "after lifting a new connection still goes without instance");
    // Without a forward without instance, and without an identifier, there is nothing to lift.
    assert.ok((await ipc(world, "cbase:ports:lift", p, "p-a/main")).error);
    assert.deepEqual(await ipc(world, "cbase:ports:lift", p, null), { error: "instance missing" });
  } finally {
    globalThis.WebSocket = realWs;
    await allStop(world);
    world.cleanUp();
  }
});

test("preload: forward/stop pass the instance through, select is exposed", async () => {
  const server = loadPreload(CLIENT_PRELOAD, { location: { protocol: "http:", origin: GATEWAY }, serverUrl: GATEWAY });
  const ports = server.exposed.cbaseClient.ports;
  assert.deepEqual(Object.keys(ports).sort(), ["active", "forward", "lift", "list", "onActive", "onChanged", "select", "stop"]);
  // The exclusive selection: `select` passes the options through, `active` asks for the choice.
  await ports.select("p-a/main", [3000], { mode: "exclusive" });
  assert.deepEqual(server.sent.at(-1), ["invoke", "cbase:ports:select", "p-a/main", [3000], { mode: "exclusive" }]);
  await ports.active();
  assert.deepEqual(server.sent.at(-1), ["invoke", "cbase:ports:active"]);
  await ports.lift(3000, "p-a/main");
  assert.deepEqual(server.sent.at(-1), ["invoke", "cbase:ports:lift", 3000, "p-a/main"]);
  await ports.forward(3000, undefined, "p-a/main");
  assert.deepEqual(server.sent.at(-1), ["invoke", "cbase:ports:forward", 3000, undefined, "p-a/main"]);
  await ports.stop(3000, "p-a/main");
  assert.deepEqual(server.sent.at(-1), ["invoke", "cbase:ports:stop", 3000, "p-a/main"]);
  // An older UI calls with two arguments — the options are missing (undefined), main.js then does the plain switchover.
  await ports.select("p-a/main", [3000, 8000]);
  assert.deepEqual(server.sent.at(-1), ["invoke", "cbase:ports:select", "p-a/main", [3000, 8000], undefined]);
});

// ── Exclusive selection ───────────────────────────────────────────────────────────────────────────────────────────────────────
// The real main.js: the choice in client-settings.json (`activeInstance`), the forwards of the choice with
// `source: "selection"`, the report `cbase:ports-active`, the native browser's getter, the restart, the one-time
// migration and the fallback of a removed active copy to main. The rules themselves (which forward ends) are held by
// forwarding-rules.test.mjs; these tests hold that main.js executes and stores them. Each has been shown red once by
// removing its line in main.js: `if (mode === "exclusive") setActive(instance);`, `if (st.changed) writeSettings(…)`,
// `f.source` passed to startForward in restoreForwards, the `ifActive` check in selectInstance, and the
// `inChain(() => selectInstance(fresh, [], "exclusive", alt))` call in checkFallback.
const linesOfThe = async (world) => (await ipc(world, "cbase:ports:list"))
  .map((f) => [f.instance, f.port, f.localPort, f.source])
  .sort((x, y) => String(x[0]).localeCompare(String(y[0])) || x[1] - y[1]);
async function untilCondition(fn, what) {
  for (let round = 0; round < 2000; round++) {
    if (await fn()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`after 2000 turns of the event loop: ${what}`);
}

test("selection: select exclusively, bring along, none — stored, reported, handed to the browser; manual stays", async () => {
  // Ascending: linesOfThe sorts the rows of one instance by port, and the expected rows below list p1 before p2. macOS hands out
  // ephemeral ports in rising order, Linux at random — there p2 < p1 turned the list round (CI red on Linux).
  const [p1, p2, p3] = [await freePort(), await freePort(), await freePort()].sort((x, y) => x - y);
  const browserArgs = {};
  const browser = { installBrowser: (a) => { Object.assign(browserArgs, a); return { unregister() {}, destroyAll() {}, forgetMeasurements() {} }; } };
  const { world, win, former } = await startClient({ forwardingsWithoutInstanceRemoved: true }, { browser });
  const sent = [];
  win.webContents.send = (k, v) => sent.push([k, v]);
  const reported = () => sent.filter(([k]) => k === "cbase:ports-active").map(([, v]) => v);
  try {
    assert.equal(await ipc(world, "cbase:ports:active"), null, "without a choice none is active");
    assert.equal(typeof browserArgs.activeInstance, "function", "main.js does not hand the choice to the native browser");
    // By hand, without instance.
    assert.equal((await ipc(world, "cbase:ports:forward", p3, p3)).localPort, p3);
    // Select A: both ports on their number, stored as forwards of the choice.
    const a = await ipc(world, "cbase:ports:select", "p-a/main", [p1, p2], { mode: "exclusive" });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.active, "p-a/main");
    assert.deepEqual(await linesOfThe(world), [[null, p3, p3, "manual"], ["p-a/main", p1, p1, "selection"], ["p-a/main", p2, p2, "selection"]]);
    assert.equal(former().activeInstance, "p-a/main", "the choice is not in client-settings.json — it would not survive a restart");
    assert.deepEqual(former().forwards.filter((f) => f.source === "selection").map((f) => f.port).sort((x, y) => x - y), [p1, p2].sort((x, y) => x - y));
    assert.equal(browserArgs.activeInstance(), "p-a/main", "the native browser asks a different choice than the pill");
    // Select B, with p1 only: A ends on BOTH ports (exclusive — p2 had no conflict), B gets p1 on its number.
    const b = await ipc(world, "cbase:ports:select", "p-b/main", [p1], { mode: "exclusive" });
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.deepEqual(await linesOfThe(world), [[null, p3, p3, "manual"], ["p-b/main", p1, p1, "selection"]], "a forward of the old choice stayed");
    // Bring-along for the old choice does nothing; for the active one it binds p2 and leaves the manual forward on p3.
    assert.deepEqual(await ipc(world, "cbase:ports:select", "p-a/main", [p2], { mode: "bringAlong" }), { ok: false, error: "not the active instance" });
    const n = await ipc(world, "cbase:ports:select", "p-b/main", [p1, p2, p3], { mode: "bringAlong" });
    assert.deepEqual(n.occupied, [p3]);
    assert.deepEqual(n.bound.map((g) => [g.port, g.localPort]), [[p2, p2]]);
    assert.deepEqual(await linesOfThe(world), [[null, p3, p3, "manual"], ["p-b/main", p1, p1, "selection"], ["p-b/main", p2, p2, "selection"]],
      "bring-along ended a manual forward");
    // None: every forward of the choice ends, the manual one stays — in the file too.
    const k = await ipc(world, "cbase:ports:select", null, [], { mode: "exclusive" });
    assert.equal(k.active, null);
    assert.deepEqual(await linesOfThe(world), [[null, p3, p3, "manual"]]);
    assert.equal(former().activeInstance, null);
    assert.deepEqual(former().forwards, [{ instance: null, port: p3, localPort: p3 }]);
    assert.deepEqual(reported(), ["p-a/main", "p-b/main", null], "the UI did not learn of every change of the choice");
    assert.deepEqual(await ipc(world, "cbase:ports:select", "p-a/main", [p1], { mode: "everything" }), { error: "invalid mode" });
  } finally {
    await allStop(world);
    world.cleanUp();
  }
});

test("selection: restart and migration — once the stored ones without instance fall; the choice binds only its own", async () => {
  const p1 = await freePort();
  const p2 = await freePort();
  const p3 = await freePort();
  // First start (no marker): entries without the field and with `instance: null` fall; the one with an instance (the
  // format before the selection existed) becomes the choice — and "none" ends it afterwards.
  const first = await startClient({ forwards: [{ port: p1, localPort: p1 }, { instance: null, port: p2, localPort: p2 }, { instance: "p-a/main", port: p3, localPort: p3 }] });
  try {
    // Read BEFORE the first bind (see "migrated" above): the file is already migrated.
    assert.deepEqual(first.former().forwards, [{ instance: "p-a/main", port: p3, localPort: p3, source: "selection" }], "the migration did not rewrite the old forwards correctly");
    assert.equal(first.former().forwardingsWithoutInstanceRemoved, true);
    assert.equal(first.former().activeInstance, "p-a/main");
    await untilList(first.world, 1);
    assert.deepEqual(await linesOfThe(first.world), [["p-a/main", p3, p3, "selection"]]);
    assert.equal(await ipc(first.world, "cbase:ports:active"), "p-a/main", "the radio would say \"none\" while p-a forwards");
    const k = await ipc(first.world, "cbase:ports:select", null, [], { mode: "exclusive" });
    assert.equal(k.ok, true, JSON.stringify(k));
    assert.deepEqual(await linesOfThe(first.world), [], "\"none\" does not end the old project forward");
    assert.deepEqual(first.former().forwards, []);
  } finally {
    await untilList(first.world, 1).catch(() => {});
    await allStop(first.world);
    first.world.cleanUp();
  }
  // Restart with a stored choice: its forward returns as one of the choice, that of another choice falls, manual stays.
  const fresh = await startClient({
    forwardingsWithoutInstanceRemoved: true, activeInstance: "p-a/main",
    forwards: [
      { instance: "p-a/main", port: p1, localPort: p1, source: "selection" },
      { instance: "p-b/main", port: p2, localPort: p2, source: "selection" },
      { instance: null, port: p3, localPort: p3 },
    ],
  });
  try {
    assert.equal(await ipc(fresh.world, "cbase:ports:active"), "p-a/main", "the choice did not survive the restart");
    await untilList(fresh.world, 2);
    assert.deepEqual(await linesOfThe(fresh.world), [[null, p3, p3, "manual"], ["p-a/main", p1, p1, "selection"]]);
    assert.deepEqual(fresh.former().forwards.map((f) => f.instance).sort(), [null, "p-a/main"].sort(), "the forward of another choice stayed in the file");
  } finally {
    await untilList(fresh.world, 2).catch(() => {});
    await allStop(fresh.world);
    fresh.world.cleanUp();
  }
});

// A forward of the choice that had moved aside while binding stored the other port — and bound it again on every
// restart, even with its own number free (baked-in addresses like localhost:3000 would lead nowhere for good).
test("selection: restart of a moved-aside forward of the choice — its own number first; stored is what is bound", async () => {
  const p = await freePort();
  const q = await freePort();
  const { world, former } = await startClient({
    forwardingsWithoutInstanceRemoved: true, activeInstance: "p-a/main",
    forwards: [{ instance: "p-a/main", port: p, localPort: q, source: "selection" }],
  });
  try {
    await untilList(world, 1);
    assert.deepEqual(await linesOfThe(world), [["p-a/main", p, p, "selection"]], "the choice stayed on the stored other port although its number is free");
    assert.deepEqual(former().forwards, [{ instance: "p-a/main", port: p, localPort: p, source: "selection" }]);
  } finally {
    await untilList(world, 1).catch(() => {});
    await allStop(world);
    world.cleanUp();
  }
});

// The fallback of a removed active copy must not read "was it active?" BEFORE the chain and queue its select behind a
// user's selection already waiting — that selection would be set and at once replaced by the copy's main. This is that
// race, without a clock: the test holds the copy's measurement (404) until a bring-along runs in the chain and the
// user's selection waits behind it; only then does the answer arrive.
test("selection: fallback against a waiting selection — the chain link checks that the choice is still the old one (also for the pill: `ifActive`)", async () => {
  const p1 = await freePort();
  const COPY = "p-a/copy-k1";
  const { world, former } = await startClient({ forwardingsWithoutInstanceRemoved: true });
  const realWs = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor() { setImmediate(() => this.onclose?.()); }
    close() {}
  };
  // The ticket comes at once; the port query with the copy's identifier waits until the test answers it with 404.
  const held = [];
  world.electron.net.request = ({ url }) => {
    const h = {};
    const r = {
      on(ev, fn) { h[ev] = fn; return r; },
      end() {
        const respond = () => {
          const response = new EventEmitter();
          const ports = url.includes("/api/ports/running");
          response.statusCode = ports ? 404 : 200;
          h.response(response);
          response.emit("data", ports ? `unknown instance: ${COPY}` : JSON.stringify({ ticket: "T1" }));
          response.emit("end");
        };
        if (url.includes("/api/ports/running")) held.push(respond);
        else setImmediate(respond);
      },
      abort() {},
    };
    return r;
  };
  try {
    const w = await ipc(world, "cbase:ports:select", COPY, [p1], { mode: "exclusive" });
    assert.equal(w.ok, true, JSON.stringify(w));
    // A tunnel to the copy fails — the fallback asks the server and waits for the (held) answer.
    const s = nodeNet.connect(p1, "127.0.0.1");
    s.on("error", () => {});
    await untilCondition(() => held.length === 1, "the fallback does not ask the server");
    // Without interruption: a bring-along of the copy occupies the chain, the user's selection waits behind it, then the 404 arrives.
    const after = ipc(world, "cbase:ports:select", COPY, [p1], { mode: "bringAlong" });
    const human = ipc(world, "cbase:ports:select", "p-b/main", [], { mode: "exclusive" });
    held.shift()();
    assert.equal((await human).active, "p-b/main");
    await after;
    // A further chain link only runs once the fallback is through.
    await ipc(world, "cbase:ports:select", "p-b/main", [], { mode: "bringAlong" });
    assert.equal(await ipc(world, "cbase:ports:active"), "p-b/main", "the fallback overwrote the user's selection");
    assert.equal(former().activeInstance, "p-b/main");
    assert.deepEqual(await linesOfThe(world), [], "a forward of the removed copy (or of its main) stayed next to the choice");
    // The same lock for the pill: a fallback computed for ANOTHER choice does nothing and reports the current one.
    assert.deepEqual(await ipc(world, "cbase:ports:select", "p-a/main", [], { mode: "exclusive", ifActive: COPY }),
      { ok: false, error: "the selection has changed in the meantime", active: "p-b/main" });
    assert.equal(await ipc(world, "cbase:ports:active"), "p-b/main", "a fallback for another choice set the choice");
    assert.deepEqual(await ipc(world, "cbase:ports:select", "p-a/main", [], { mode: "exclusive", ifActive: "broken" }), { error: "invalid condition" });
    // If the condition holds, the selection happens as without it.
    const yes = await ipc(world, "cbase:ports:select", null, [], { mode: "exclusive", ifActive: "p-b/main" });
    assert.equal(yes.ok, true, JSON.stringify(yes));
    assert.equal(await ipc(world, "cbase:ports:active"), null);
  } finally {
    globalThis.WebSocket = realWs;
    for (const a of held.splice(0)) a();
    await allStop(world);
    world.cleanUp();
  }
});

test("selection: fallback — if the active copy is removed (404 \"unknown instance\"), the choice falls to its project's main", async () => {
  const p1 = await freePort();
  const p2 = await freePort();
  const COPY = "p-a/copy-k1";
  const { world, win, former } = await startClient({ forwardingsWithoutInstanceRemoved: true });
  const sent = [];
  win.webContents.send = (k, v) => sent.push([k, v]);
  const realWs = globalThis.WebSocket;
  // The tunnel to the copy never opens (the server no longer knows it) …
  globalThis.WebSocket = class {
    constructor() { setImmediate(() => this.onclose?.()); }
    close() {}
  };
  // … and the port query with its identifier answers 404 "unknown instance" (the server's wording).
  world.electron.net.request = ({ url }) => {
    const h = {};
    const r = {
      on(ev, fn) { h[ev] = fn; return r; },
      end() {
        setImmediate(() => {
          const response = new EventEmitter();
          const ports = url.includes("/api/ports/running");
          response.statusCode = ports ? 404 : 200;
          h.response(response);
          response.emit("data", ports ? `unknown instance: ${COPY}` : JSON.stringify({ ticket: "T1" }));
          response.emit("end");
        });
      },
      abort() {},
    };
    return r;
  };
  try {
    const w = await ipc(world, "cbase:ports:select", COPY, [p1, p2], { mode: "exclusive" });
    assert.equal(w.ok, true, JSON.stringify(w));
    await new Promise((resolve) => {
      const s = nodeNet.connect(p1, "127.0.0.1");
      s.on("error", () => {});
      s.on("close", () => resolve());
    });
    await untilCondition(async () => (await ipc(world, "cbase:ports:active")) === "p-a/main", "the choice did not fall to main");
    await untilCondition(async () => (await linesOfThe(world)).length === 1, "the copy's remaining forwards do not end");
    assert.deepEqual(await linesOfThe(world), [["p-a/main", p1, p1, "selection"]], "the forward did not move to main with its local port");
    assert.equal(former().activeInstance, "p-a/main");
    assert.deepEqual(former().forwards, [{ instance: "p-a/main", port: p1, localPort: p1, source: "selection" }]);
    assert.deepEqual(sent.filter(([k]) => k === "cbase:ports-active").map(([, v]) => v), [COPY, "p-a/main"]);
  } finally {
    globalThis.WebSocket = realWs;
    await allStop(world);
    world.cleanUp();
  }
});

// ── Outer boundaries of the shell ─────────────────────────────────────────────────────────────────────────────────
// Rules in client/shell-rules.js (pure functions), tested twice here: as a table against the rule and against the real
// main.js, via exactly the paths an attack would take (window open/will-navigate with `smb://`, the relay with `/../`, an
// IPC call from a foreign frame).

test("external rule: outward only http, https, mailto and the VS Code link — opened is the parsed form", () => {
  for (const [one, out] of EXTERN_ALLOWED) assert.equal(externalTarget(one), out, JSON.stringify(one));
  for (const one of EXTERN_DISMISSED) assert.equal(externalTarget(one), null, `${JSON.stringify(one)} would go to the operating system`);
});

// The binding runs the REAL builders: under `vscode-remote` the rule only lets the pill's two authorities through.
// `module.stripTypeScriptTypes` (Node ≥ 22.13) turns the .ts file into runnable JS without web/node_modules —
// vscode-tunnel.ts has no imports.
async function vscodeBuilder() {
  const file = path.join(here, "..", "..", "web", "src", "lib", "vscode-tunnel.ts");
  const source = fs.readFileSync(file, "utf8");
  const { stripTypeScriptTypes } = await import("node:module");
  assert.equal(typeof stripTypeScriptTypes, "function", `this Node (${process.version}) has no module.stripTypeScriptTypes — the binding cannot run vscode-tunnel.ts`);
  const module = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(stripTypeScriptTypes(source))}`);
  return { source, ...module };
}

test("external binding: every vscode:// link the UI builds (web/src/lib/vscode-tunnel.ts) is allowed — otherwise the pill's button would be dead", async () => {
  const { source, tunnelLinks, containerLink } = await vscodeBuilder();
  assert.equal(typeof tunnelLinks, "function", "anchor: tunnelLinks is missing in vscode-tunnel.ts");
  assert.equal(typeof containerLink, "function", "anchor: containerLink is missing in vscode-tunnel.ts");
  // A third builder of a vscode:// link belongs in this test — otherwise its link would stay unchecked and maybe dead.
  const templates = [...source.matchAll(/`(vscode:\/\/[^`$]*)/g)].map((m) => m[1]);
  assert.deepEqual(templates, ["vscode://vscode-remote/tunnel+", "vscode://vscode-remote/attached-container+"],
    "vscode-tunnel.ts builds other vscode:// links than tunnelLinks/containerLink — the new builder belongs in this binding");
  const names = ["cbase-k", "cbase", "a", "a0123456789abcdefghi", " cbase-7 "];
  const paths = ["/home/agent/workspaces/Mein WS", "/home/agent/workspaces/demo/till", "/home/agent/workspaces/Müller & Söhne/x", "home/agent", ""];
  const container = ["cbase-k-p123-alpha", "p-a", "cbase-k-p9-grün"];
  let count = 0;
  for (const name of names) {
    for (const filePath of paths) {
      const { desktop } = tunnelLinks(name, filePath);
      assert.equal(externalTarget(desktop), desktop, `tunnel link ${desktop} is rejected (or opened differently than built)`);
      count++;
      for (const c of container) {
        const link = containerLink(name, c, filePath);
        assert.ok(link, `containerLink(${JSON.stringify(name)}, ${JSON.stringify(c)}) builds no link`);
        assert.equal(externalTarget(link), link, `container link ${link} is rejected (or opened differently than built)`);
        count++;
      }
    }
  }
  assert.equal(count, names.length * paths.length * (1 + container.length));
});

test("external client: window open, will-navigate and the \"openExternal\" permission do not hand a foreign scheme to the operating system", async () => {
  const { world, win } = await startClient();
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    const wc = win.webContents;
    assert.equal(typeof wc.openWindow, "function", "main.js sets no setWindowOpenHandler");
    const navigate = (url) => { const ev = { prevented: false, preventDefault() { this.prevented = true; } }; wc.emit("will-navigate", ev, url); return ev; };
    for (const url of EXTERN_DISMISSED.filter((u) => typeof u === "string" && u)) {
      assert.deepEqual(wc.openWindow({ url }), { action: "deny" }, `window open ${JSON.stringify(url)}`);
      const ev = navigate(url);
      // `file://` stays the one navigation path inside the window (connect.html); it opens nothing externally either.
      if (!url.startsWith("file://")) assert.equal(ev.prevented, true, `will-navigate ${JSON.stringify(url)} continued inside the window`);
    }
    assert.deepEqual(world.extern, [], `an shell.openExternal ging: ${JSON.stringify(world.extern)}`);
    assert.ok(warnings.some((w) => w.includes('"smb:"')), "the rejection is not logged");
    assert.ok(!warnings.some((w) => w.includes("attacker")), "the log carries the URL — only the scheme belongs there");
    // Allowed targets go out, in the parsed form — on both paths.
    for (const [one, out] of EXTERN_ALLOWED) {
      world.extern.length = 0;
      assert.deepEqual(wc.openWindow({ url: one }), { action: "deny" });
      assert.equal(navigate(one).prevented, true);
      assert.deepEqual(world.extern, [out, out], JSON.stringify(one));
    }
    // The same origin stays a child window and does not go out.
    world.extern.length = 0;
    assert.deepEqual(wc.openWindow({ url: `${GATEWAY}/gw/admin` }), { action: "allow" });
    assert.equal(navigate(`${GATEWAY}/workspaces`).prevented, false);
    assert.deepEqual(world.extern, []);
    // Chromium's own program launch (embedded frames, bypassing will-navigate) asks the "openExternal" permission.
    assert.equal(typeof world.permissionsHandler, "function", "the UI has no permission handler — Chromium grants \"openExternal\" silently");
    const permission = (name, details) => { let response; world.permissionsHandler(wc, name, (a) => { response = a; }, details); return response; };
    for (const url of EXTERN_DISMISSED) assert.equal(permission("openExternal", { externalURL: url }), false, `permission for ${JSON.stringify(url)}`);
    for (const [one] of EXTERN_ALLOWED) assert.equal(permission("openExternal", { externalURL: one }), true, one);
    assert.equal(permission("openExternal", undefined), false, "a request without details is not a yes");
    for (const other of ["media", "notifications", "clipboard-sanitized-write", "fullscreen"]) {
      assert.equal(permission(other, {}), true, `"${other}" was granted without a handler and must stay so`);
    }
  } finally {
    console.warn = warn;
    world.cleanUp();
  }
});

test("external client: `shell.openExternal` has exactly ONE caller (main.js openExternally) — the native browser's button goes through it too", () => {
  const files = fs.readdirSync(path.join(here, "..")).filter((d) => /\.(c?js|mjs)$/.test(d));
  const hits = files.flatMap((d) => [...fs.readFileSync(path.join(here, "..", d), "utf8").matchAll(/shell\.openExternal\(/g)].map(() => d));
  assert.deepEqual(hits, ["main.js"], `openExternal-Calls: ${hits.join(", ")}`);
  const main = fs.readFileSync(CLIENT_MAIN, "utf8");
  const body = main.slice(main.indexOf("function openExternally("), main.indexOf("// ── Who may address the shell"));
  assert.ok(/const target = externalTarget\(url\);/.test(body) && /shell\.openExternal\(target\)/.test(body), "openExternally does not open the checked form");
  const browser = fs.readFileSync(path.join(here, "..", "browser.js"), "utf8");
  assert.ok(/openExternally\(url, "Browser-Pane"\)/.test(browser), "the native browser's button does not go through openExternally");
  assert.ok(/\n\s*openExternally,\n/.test(main.slice(main.indexOf("installBrowser({"))), "main.js does not hand openExternally to the browser");
});

test("OAuth relay rule: the relay only passes paths under /api/codex-oauth — checked before AND after normalization", () => {
  const GW = "https://gw.example";
  // The callback itself and what codex serves next to it: unchanged, including the search.
  assert.equal(oauthRelayTarget(GW, "/auth/callback?code=abc&state=xyz"), `${GW}${OAUTH_PREFIX}/auth/callback?code=abc&state=xyz`);
  assert.equal(oauthRelayTarget(GW, "/success"), `${GW}${OAUTH_PREFIX}/success`);
  assert.equal(oauthRelayTarget(GW, "/"), `${GW}${OAUTH_PREFIX}/`);
  // `..` in the search does not change the path.
  assert.equal(oauthRelayTarget(GW, "/auth/callback?next=/../../x"), `${GW}${OAUTH_PREFIX}/auth/callback?next=/../../x`);
  // A server URL with a path keeps it.
  assert.equal(oauthRelayTarget("https://gw.example/cbase/", "/auth/callback?code=1"), `${GW}/cbase${OAUTH_PREFIX}/auth/callback?code=1`);
  const malicious = [
    "/../../api/runs/active", "/..", "/.", "/auth/../../api/x", "/auth/./callback",
    "/%2e%2e/runs/active", "/%2E%2e/../gw/ingest-tokens", "/.%2e/x", "/%2e./x", "/%2e",
    "/..%2f..%2fapi/x", "/%2e%2e%2f%2e%2e%2fapi%2fx",
    "/%252e%252e/%252e%252e/api/x", "/%25252e%25252e/x", // double and triple encoded
    `/%${"25".repeat(DECODE_STAGES + 2)}2e/x`, // encoded deeper than is checked: rejected, not waved through
    "/a\\..\\..\\api", "/\\..\\api", "/a%5c..%5capi", "/a%255c..%255capi",
    "/auth/callback\t..", "/a b", "/a%00b", "/a%20/../x", "/%zz", "/auth#..",
    "http://foreign.example/x", "*", "", "auth/callback", null, undefined, 3,
  ];
  for (const url of malicious) assert.equal(oauthRelayTarget(GW, url), null, `${JSON.stringify(url)} would go out with the session`);
  // Without a valid server URL, nothing.
  for (const base of ["", "broken", "ftp://gw.example", "file:///x", null]) assert.equal(oauthRelayTarget(base, "/auth/callback?code=1"), null, String(base));
  // The promise AFTER normalization, for every string built from parts a path can carry: whatever gets through lies
  // under the prefix on the gateway's origin.
  const parts = ["/", ".", "..", "%2e", "%2E", "%25", "%2f", "%5c", "\\", "a", "auth", "?", "%3f", "#", "//", "@", ":"];
  let checked = 0;
  for (const a of parts) for (const b of parts) for (const c of parts) {
    const target = oauthRelayTarget(GW, `/${a}${b}${c}`);
    checked++;
    if (target === null) continue;
    const u = new URL(target);
    assert.equal(u.origin, GW, `/${a}${b}${c} → ${target}`);
    assert.ok(u.pathname === OAUTH_PREFIX || u.pathname.startsWith(`${OAUTH_PREFIX}/`), `/${a}${b}${c} → ${target} leaves the prefix`);
  }
  assert.equal(checked, parts.length ** 3);
});

test("OAuth relay client: the relay on 127.0.0.1:1455 does not send `/../`, `%2e%2e` and backslash out with the gateway session", async (t) => {
  // The relay removes itself after ten minutes — with fake clocks this timer does not keep the test process open.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = [];
  const fakeHttp = {
    default: {
      createServer(fn) {
        const s = { fn, listens: null, on() { return s; }, listen(...a) { s.listens = a; }, close() {} };
        server.push(s);
        return s;
      },
    },
  };
  const { world } = await startClient({}, { fakes: { "node:http": fakeHttp } });
  const requests = [];
  world.electron.net.request = (opts) => {
    requests.push(opts);
    const r = { on() { return r; }, end() {}, abort() {} };
    return r;
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(typeof world.requestFinished, "function", "main.js does not observe the Codex login — the relay is unreachable");
    world.requestFinished({ method: "POST", statusCode: 200 });
    assert.equal(server.length, 1, "the Codex login did not start a relay");
    assert.deepEqual(server[0].listens, [1455, "127.0.0.1"]);
    const request = (url) => {
      const res = { status: null, body: "", writeHead(st) { res.status = st; return res; }, write() {}, end(x) { res.body += x ?? ""; } };
      server[0].fn({ url, method: "GET", headers: {} }, res);
      return res;
    };
    for (const url of ["/../../api/runs/active", "/%2e%2e/runs/active", "/%2E%2e/../gw/ingest-tokens", "/..%2f..%2fapi/x",
      "/%252e%252e/%252e%252e/api/vars", "/a\\..\\..\\api/vars"]) {
      const res = request(url);
      assert.deepEqual(requests.map((a) => a.url), [], `${url} went to the gateway — with the session cookie`);
      assert.equal(res.status, 400, `${url}: no rejection to the asker`);
    }
    // The real callback goes on, to the checked address, with the session.
    request("/auth/callback?code=abc&state=xyz");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `${GATEWAY}/api/codex-oauth/auth/callback?code=abc&state=xyz`);
    assert.equal(requests[0].useSessionCookies, true);
    assert.equal(requests[0].method, "GET");
  } finally {
    console.warn = warn;
    world.cleanUp();
  }
});

test("IPC sender rule: window, main frame and the surface's origin — each line alone is a no", () => {
  const S = GATEWAY;
  const main = (url) => ({ fromTheWindow: true, frame: { url, parent: null } });
  assert.equal(ipcSenderAllowed(main(`${S}/workspaces`), "server", S), true);
  assert.equal(ipcSenderAllowed(main(`${S}/`), "server", `${S}/`), true, "a trailing slash on the server URL does not change the origin");
  assert.equal(ipcSenderAllowed(main("file:///Apps/cbase%20Client.app/connect.html"), "connect", S), true);
  assert.equal(ipcSenderAllowed(main("https://foreign.example/"), "window", S), true, "the preload's question comes before its origin check");
  const no = [
    ["other window", { fromTheWindow: false, frame: { url: `${S}/`, parent: null } }, "server"],
    ["no flag", { frame: { url: `${S}/`, parent: null } }, "server"],
    ["subframe", { fromTheWindow: true, frame: { url: `${S}/`, parent: { url: `${S}/` } } }, "server"],
    ["subframe (window)", { fromTheWindow: true, frame: { url: `${S}/`, parent: {} } }, "window"],
    ["no frame", { fromTheWindow: true, frame: null }, "server"],
    ["no frame (window)", { fromTheWindow: true, frame: null }, "window"],
    ["foreign origin", main("https://foreign.example/"), "server"],
    ["other port", main("http://gateway.test:7718/"), "server"],
    ["other scheme", main("https://gateway.test:7719/"), "server"],
    ["connect page at the server surface", main("file:///x/connect.html"), "server"],
    ["server at the connect surface", main(`${S}/`), "connect"],
    ["unreadable URL", main("broken"), "server"],
    ["unknown surface", main(`${S}/`), "everything"],
  ];
  for (const [name, sender, surface] of no) assert.equal(ipcSenderAllowed(sender, surface, S), false, name);
  for (const server of ["", "broken", "file:///x", null]) assert.equal(ipcSenderAllowed(main(`${S}/`), "server", server), false, `Server-URL ${server}`);
});

// Every channel main.js registers, with its surface and the answer of a rejected call. A new channel without a line
// here turns the next test red: whoever adds a channel decides whom it belongs to.
const CHANNELS = {
  handle: {
    "cbase:window-button": ["server", ["close"], false],
    "cbase:ports:list": ["server", [], []],
    // Port 0 is invalid: a handler WITHOUT the check would answer "invalid port" and bind nothing.
    "cbase:ports:forward": ["server", [0, 0, null], { error: "foreign sender" }],
    "cbase:ports:stop": ["server", [0, null], { error: "foreign sender" }],
    "cbase:ports:select": ["server", [null, [0]], { error: "foreign sender" }],
    "cbase:ports:active": ["server", [], null],
    "cbase:ports:lift": ["server", [0, "p-a/main"], { error: "foreign sender" }],
    // "" is not a URL: without the check the handler would answer "URL missing" without touching the network.
    "cbase:connect": ["connect", [""], { error: "foreign sender" }],
    "cbase:get-server": ["connect", [], ""],
  },
  on: {
    "cbase:theme": ["server", ["dark"]],
    "cbase:textSize": ["server", ["large"]],
    "cbase:get-server-sync": ["window", []],
  },
};

test("IPC sender client: EVERY channel of main.js checks the sender — subframe, foreign window, navigated away, foreign origin", async () => {
  const { world, win } = await startClient();
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    assert.deepEqual([...world.ipc.handle.keys()].sort(), Object.keys(CHANNELS.handle).sort(), "main.js registers a channel that has no line here (or has lost one)");
    assert.deepEqual([...world.ipc.on.keys()].sort(), Object.keys(CHANNELS.on).sort(), "main.js registers a channel that has no line here (or has lost one)");
    const foreign = foreignSender(world, win);
    const connectionPage = { webContents: win.webContents, frame: { url: "file:///x/connect.html", parent: null } };
    for (const [channel, [surface, args, rejected]] of Object.entries(CHANNELS.handle)) {
      const sender = [...foreign, ["foreign origin in the main frame", foreignOrigin(win)]];
      if (surface === "server") sender.push(["Verbindungsseite", connectionPage]);
      if (surface === "connect") sender.push(["server UI", win]);
      for (const [name, a] of sender) assert.deepEqual(await world.calls(channel, a, ...args), rejected, `${channel} ← ${name}`);
    }
    for (const [name, a] of [...foreign, ["foreign origin in the main frame", foreignOrigin(win)], ["connect page", connectionPage]]) {
      world.send("cbase:theme", a, "dark");
      world.send("cbase:textSize", a, "large");
      assert.deepEqual(world.nativeTheme.assignments, [], `cbase:theme ← ${name} set the theme`);
      const stages = world.menu.find((m) => m.label === "View").submenu.find((p) => p.label === "Text size").submenu;
      assert.equal(stages.some((r) => r.enabled), false, `cbase:textSize ← ${name} reported the text size`);
    }
    // The preload's question: every page in the window's main frame gets the answer (it decides by `location.origin`),
    // nobody else — and a no is an empty answer, never none (sendSync would hang).
    for (const [name, a] of foreign) assert.equal(world.sendSync("cbase:get-server-sync", a), "", `cbase:get-server-sync ← ${name}`);
    assert.equal(world.sendSync("cbase:get-server-sync", foreignOrigin(win)), GATEWAY);
    assert.equal(world.sendSync("cbase:get-server-sync", win), GATEWAY);
    assert.ok(warnings.some((w) => w.includes("IPC call rejected")), "a rejection is not logged");
    // And every channel ASKS the check — even one whose rejected answer equals the real one (`ports:list` without
    // forwards is [] either way, `ports:active` without a choice null): a handler without the check never reads `senderFrame`.
    for (const kind of ["handle", "on"]) {
      for (const [channel, [, args]] of Object.entries(CHANNELS[kind])) {
        let read = 0;
        const ev = {
          sender: win.webContents,
          returnValue: undefined,
          get senderFrame() { read++; return { url: GATEWAY, parent: { url: GATEWAY } }; },
        };
        await world.ipc[kind].get(channel)(ev, ...args);
        assert.ok(read > 0, `${channel} never reads the sender's frame — it does not go through the check`);
      }
    }
    // The UI itself gets through everywhere.
    world.send("cbase:theme", win, "dark");
    assert.deepEqual(world.nativeTheme.assignments, ["dark"]);
    assert.deepEqual(await world.calls("cbase:ports:forward", win, 0, 0, null), { error: "invalid port" });
    assert.equal(await world.calls("cbase:window-button", win, "minimize"), true);
  } finally {
    console.warn = warn;
    world.cleanUp();
  }
});

test("IPC sender client: the connect page (file:) speaks its two channels — and only those", async () => {
  const { world, win } = await startClient({ serverUrl: "" });
  try {
    assert.ok(String(win.webContents.mainFrame.url).startsWith("file:") && win.webContents.mainFrame.url.endsWith("/connect.html"), "without a server the client does not load connect.html");
    assert.deepEqual(await world.calls("cbase:connect", win, ""), { error: "URL missing" }, "connect.html does not get through");
    assert.equal(await world.calls("cbase:get-server", win), "");
    assert.equal(await world.calls("cbase:window-button", win, "minimize"), false, "the connect page operates the UI's window buttons");
    assert.deepEqual(await world.calls("cbase:ports:list", win), []);
  } finally {
    world.cleanUp();
  }
});

test("IPC sender client: the native browser asks the same check — browser.js has no version of its own", () => {
  const browser = fs.readFileSync(path.join(here, "..", "browser.js"), "utf8");
  const main = fs.readFileSync(CLIENT_MAIN, "utf8");
  assert.ok(!/BrowserWindow\.fromWebContents/.test(browser), "browser.js checks the sender itself again — a second version of the rule");
  assert.ok(/const fromWindow = \(ev\) => typeof senderMay === "function" && senderMay\(ev\) === true;/.test(browser), "browser.js does not ask senderMay");
  assert.ok(/senderMay: \(ev\) => pageMay\(ev, "server"\),/.test(main), "main.js does not hand the check to the browser");
  // Every channel in browser.js goes through the check — itself or via withScope/withState, which start with it.
  const body = browser.slice(browser.indexOf("const fromWindow"), browser.indexOf("// If the window itself reloads"));
  const beginnings = [...body.matchAll(/\n\s+(?:handle|on)\((?:"|`)cbase:browser:/g)].map((m) => m.index);
  assert.ok(beginnings.length >= 10, `anchor: only ${beginnings.length} channels of the native browser found`);
  beginnings.forEach((beginning, i) => {
    const block = body.slice(beginning, beginnings[i + 1] ?? body.length);
    assert.ok(/fromWindow\(ev\)|withScope\(ev,|withState\(ev,/.test(block), `a channel of the native browser does not check the sender: ${block.trim().split("\n")[0].slice(0, 80)}`);
  });
  for (const helper of ["function withScope(ev, scope, fn) {\n    if (!fromWindow(ev)", "function withState(ev, scope, fn) {\n    if (!fromWindow(ev)"]) {
    assert.ok(browser.includes(helper), `${helper.split("(")[0]} does not check the sender first`);
  }
});
