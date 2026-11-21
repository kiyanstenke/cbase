// The wiring of the native browser in the main process (client/browser.js, client/main.js).
//
// No test bench covers the Electron side itself: views, sessions and IPC need a window. What CAN
// be tested is the wiring: whether the lines are there whose absence once broke the browser. A
// deleted line in the main process turns no test red; it only breaks the browser, and only on the
// second window or after the first ⌘R.
//
// This is a binding by path, not a proof of behavior. It says "the countermeasure is still there",
// not "it works". The proof is the smoke test in the built client.
//
// Run:  node --test client/test/browser-wiring.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(here, "..", name), "utf8");
const browser = read("browser.js");
const main = read("main.js");

test("a second window must not fail on IPC: all channels go through register-with-unregister", () => {
  // `ipcMain.handle` THROWS the second time on the same channel, and `installBrowser` runs in
  // `createWindow`. On macOS closing the window does not quit the app — the next click in the Dock
  // calls `createWindow` again, the throw escapes the activate handler, and `loadTarget` NEVER
  // runs: an empty window that loads nothing.
  const bare = [...browser.matchAll(/ipcMain\.(handle|on)\(/g)].length;
  assert.equal(bare, 2, "ipcMain.handle/on appears in browser.js outside the two register helpers — a second window would die on \"second handler\"");
  assert.ok(/try \{ ipcMain\.removeHandler\(channel\); \} catch \{\}\s*\n\s*ipcMain\.handle\(channel, fn\);/.test(browser),
    "the handle helper does not unregister the channel first");
  assert.ok(/ipcMain\.removeAllListeners\(channel\);\s*\n\s*ipcMain\.on\(channel, fn\);/.test(browser),
    "the on helper does not remove the old listeners — they silently stack");
  assert.ok(/unregister\(\) \{/.test(browser), "the bridge returns no `unregister`");
  assert.ok(/for \(const k of channels\.handle\) \{ try \{ ipcMain\.removeHandler\(k\); \} catch \{\} \}/.test(browser),
    "`unregister` does not release the handle channels");
  assert.ok(/for \(const k of channels\.on\) \{ try \{ ipcMain\.removeAllListeners\(k\); \} catch \{\} \}/.test(browser),
    "`unregister` does not release the on channels");
});

test("window closed means views closed: `unregister` hangs on the window's closed", () => {
  // Electron does NOT destroy a WebContentsView with its window. Without this line every tab of
  // every scope would keep running invisibly after closing — timers, network, sound — and the
  // still registered IPC handlers would keep it alive.
  assert.ok(/mainWindow\.on\("closed", \(\) => \{ browserBridge\?\.unregister\(\);/.test(main),
    "the window's `closed` does not unregister the bridge — the browser views keep surfing invisibly");
  assert.ok(/beforeTheQuit\(\);\s*\n\s*destroyAll\(\);/.test(browser),
    "`unregister` does not remember the tabs before destroying the views — the last state would be lost");
  // And every access to the window goes through a guard: `getContentSize()` throws on a destroyed
  // window, and a throw in the main process takes the whole app down.
  assert.ok(/const windowAlive = \(\)/.test(browser) && /if \(!tab \|\| !windowAlive\(\)\) return;/.test(browser),
    "`create` touches the window without a guard");
});

test("a destroyed webContents is no longer touched (the page's window.close())", () => {
  // After `window.close()`, `view.webContents` is undefined; `tab.view.webContents.loadURL(…)`
  // would throw SYNCHRONOUSLY, before there is a promise that could catch it.
  assert.ok(/function wcOf\(tab\)/.test(browser), "there is no checked access to a tab's webContents");
  assert.equal([...browser.matchAll(/\.view\.webContents/g)].length, 1,
    "a view's webContents is still touched directly — only `wcOf` may do that (and that is the one place in it)");
  assert.ok(/wc\.on\("destroyed", \(\) => \{ if \(!tab\.gone\) closeTab\(s, tab\.id\); \}\);/.test(browser),
    "a page that closes itself leaves a dead tab in the row");
});

test("the renderer learns when the client forgets its hosts — and `obscured` falls with them", () => {
  // The pane only reports CHANGES of its rectangle. If it does not learn that `allHide` dropped
  // the host, it stays silent with the same rectangle and the area stays empty. `obscured` is the
  // second part: ONLY the renderer takes it back, and on a reload of the UI the renderer is gone —
  // a view under a modal would otherwise stay invisible forever.
  const block = browser.slice(browser.indexOf("function allHide()"), browser.indexOf("// ── Scopes"));
  assert.ok(/s\.obscured = false;/.test(block), "`allHide` does not take the obscuring back");
  assert.ok(/report\(s\);/.test(block), "`allHide` tells the pane nothing — it never reports its rectangle again");
  // A same-document navigation (history.replaceState of the UI) is not a navigation.
  assert.ok(/if \(isMainFrame !== false && inPlace !== true\) allHide\(\);/.test(browser),
    "a replaceState of the UI drops the hosts — the area would stay empty");
});

test("still frame on/off is sequenced: the late \"on\" does not overwrite an \"off\"", () => {
  // "on" takes time (capturePage), "off" answers at once. Without the counter an overtaken "on"
  // would write the obscuring back, and the area would stay empty until some overlay opened and
  // closed again.
  assert.ok(/const state = \+\+s\.stillFrameStatus;/.test(browser), "the still-frame request carries no state");
  assert.ok(/if \(state !== s\.stillFrameStatus\) return null;/.test(browser),
    "an overtaken still-frame request still sets `obscured` — the view would stay invisible");
});

test("the DevTools are really closed on a tab switch", () => {
  // Clearing the flag alone is not enough: the old tab's panel would stay open, the button would
  // say "off", and the next click would open a SECOND one.
  assert.ok(/if \(s\.devtools\) try \{ wcOf\(activeTab\(s\)\)\?\.closeDevTools\(\); \} catch \{\}/.test(browser),
    "`selectTab` claims to close the DevTools and does not");
  assert.ok(/s\.activeId = \(s\.tabs\[idx\] \|\| s\.tabs\[s\.tabs\.length - 1\]\)\.id; s\.devtools = false;/.test(browser),
    "if the tab WITH the DevTools is closed, the flag stays");
});

test("pages in the native browser get permissions only through the rule", () => {
  // Electron's default without a handler is "allow everything" — camera, microphone, location, on
  // THIS machine, without a dialog and without a way to revoke it.
  assert.ok(/setPermissionRequestHandler\(\(_wc, permission, done\) => done\(allowedPermission\(permission\)\)\)/.test(browser),
    "a scope's session gets no permission handler");
  assert.ok(/setPermissionCheckHandler\(\(_wc, permission\) => allowedPermission\(permission\)\)/.test(browser),
    "without a check handler navigator.permissions.query still reports \"granted\"");
  assert.ok(/setDevicePermissionHandler\?\.\(\(\) => false\)/.test(browser), "HID/serial/USB stay allowed");
  assert.ok(/session: scopeSession\(scope\)/.test(browser), "the scope creates its session bypassing the rule");
});

test("auto-forward: the origin counts, and both loopback families are measured", () => {
  assert.ok(/originIsLocal\(details\.webContents\?\.getURL\?\.\(\) \|\| ""\)/.test(browser),
    "the request's origin is not read — any visited page could trigger a tunnel into the container");
  assert.ok(/if \(!mainFrame && !originLocal\) return callback\(\{\}\);/.test(browser),
    "a subrequest of foreign origin is still measured and forwarded");
  assert.ok(/Promise\.all\(\[attempt\("127\.0\.0\.1", port\), attempt\("::1", port\)\]\)/.test(browser),
    "\"is someone listening locally?\" measures only IPv4 — a service on [::1] would stay invisible");
  assert.ok(/const ourLocalPorts = \(scope, m\) => localPortsForScope\(\[\.\.\.forwards\.values\(\)\], scope, m\);/.test(browser),
    "rule 1 asks the container ports instead of the local ones — after \"other port\" the browser would take its own listener for a foreign one");
  assert.ok(/code === -3 \|\| code === -20/.test(browser),
    "the cancelled request of our own hint additionally appears as a red error");
});

// Without these lines rule 1 counted every forward (a page of project B silently showed the app of A), there was no
// choice among several projects and no lifting.
test("auto-forward per scope: the main frame measures when the forward of ANOTHER project sits on the local port", () => {
  assert.ok(/if \(onPort && \(!mainFrame \|\| !forwardingNeedsMeasurement\(onPort, s\.scope\)\)\) return callback\(\{\}\);/.test(browser),
    "an already forwarded local port is let through without measuring, even if it belongs to another project");
  assert.ok(/ourLocalPorts: ourLocalPorts\(s\.scope, m\)/.test(browser),
    "the decision after the measurement counts the local ports without scope and measurement");
  assert.ok(!/if \(unsere\.has\(port\)\) return callback\(\{\}\);/.test(browser), "the old shortcut \"our port ⇒ through\" before any measurement is still there");
});

// Exclusive selection: the browser must not silently displace the choice — its measurement asks the active instance
// first (rule: forwarding-rules.test.mjs "native browser and the choice"), and a new choice invalidates its measurements.
// The evaluation lives in browser-rules.js containerMeasurement (with its behavior test); browser.js passes the choice in.
test("selection: the native browser measures with the active instance, and a new choice clears its measurements", () => {
  const rules = read("browser-rules.js");
  assert.ok(/return instanceForScope\(j\.open, scope, port, activeInstance\?\.\(\) \?\? null\);/.test(rules),
    "the browser's measurement does not know the choice — it would forward the scope's port although the active instance holds it");
  assert.ok(/containerMeasurement\(\{ question: sessionRequest, base: serverUrl\?\.\(\), port, scope, activeInstance \}\)/.test(browser),
    "browser.js does not pass the choice into the measurement");
  assert.ok(/export function installBrowser\(\{[^}]*\bactiveInstance \}\)/.test(browser), "installBrowser does not accept the choice");
  assert.ok(/\n\s*activeInstance,\n\s*\}\);/.test(main), "main.js does not hand the choice to the browser");
  const set = main.slice(main.indexOf("function setActive("), main.indexOf("let selectChain"));
  assert.ok(/browserBridge\?\.forgetMeasurements\(\);/.test(set), "a new choice leaves the browser's measurements in place — the old instance for five seconds");
  assert.ok(/mainWindow\?\.webContents\.send\("cbase:ports-active", fresh\)/.test(set), "a new choice is not reported to the UI");
});

test("several projects on the port: a card with the candidates, the answer only from among them", () => {
  assert.ok(/if \(choice === "choice"\) \{/.test(browser), "\"choice\" is not handled — the page would silently run into \"connection refused\"");
  assert.ok(/send\("cbase:browser-hint", \{ id, scope: s\.scope, kind: "ambiguous", port, url: details\.url, candidates: m\.candidates \}\);/.test(browser),
    "the \"ambiguous\" card does not carry the candidates");
  assert.ok(/else if \(selected && h\.candidates\?\.includes\(selected\)\) instance = selected;/.test(browser),
    "the answer \"instance:<k>\" is not checked against the measured candidates — the UI could smuggle in an instance");
  assert.ok(/if \(choice === "other-port" && !h\.candidates\) instance = h\.instance \?\? null;/.test(browser),
    "\"other port\" on an \"ambiguous\" card would forward to B without a choice");
});

test("lift: a forward without instance only goes where its tunnel leads TODAY, and keeps its local port", () => {
  const preload = read("preload.cjs");
  assert.ok(/lift: \(port, instance\) => ipcRenderer\.invoke\("cbase:ports:lift", port, instance\)/.test(preload), "the bridge has no `lift`");
  assert.ok(/ipcMain\.handle\("cbase:ports:lift", /.test(main), "main.js does not register `cbase:ports:lift`");
  const block = main.slice(main.indexOf("async function liftForwarding("), main.indexOf("const validPort = "));
  assert.ok(/if \(tunnelTargetWithoutInstance\(open, port\) !== instance\) return/.test(block),
    "lifting happens at the UI's request, not by the tunnel's rule");
  assert.ok(!/stopForward|bindForward|startForward/.test(block), "lifting lets go of the local port (stop and rebind)");
  assert.ok(/f\.instance = instance;/.test(block) && /forwards\.set\(forwardKey\(instance, port\), f\);/.test(block),
    "lifting does not change the entry's key or instance");
  assert.ok(/remember\(without\(s\.forwards, \{ instance: null, port \}\), \{ instance, port, localPort: f\.localPort \}\)/.test(block),
    "the stored forward stays without instance and silently dies again on the next start");
  assert.ok(/new WebSocket\(tunnelWsUrl\(containerPort, ticket, entry\.instance\)\)/.test(main),
    "a new connection reads the instance from the argument — after lifting it would continue without instance");
});

test("two concurrent requests bind ONE forward", () => {
  // `forwards.has` is synchronous, the map is filled only AFTER binding: N concurrent requests for
  // the same port would create N servers. The surplus ones would be in no list — "stop forwarding"
  // would not free the port. Keyed by (instance, port), the same key as `forwards`.
  assert.ok(/const starting = new Map\(\); \/\/ "<instance>:<port>" -> Promise/.test(main), "there is no map of running bindings");
  assert.ok(/const key = forwardKey\(instance, containerPort\);/.test(main), "startForward does not compute the key from instance and port");
  assert.ok(/const running = starting\.get\(key\);\s*\n\s*if \(running\) \{/.test(main),
    "startForward does not wait for a running binding of the same port");
  assert.ok(/starting\.set\(key, p\);/.test(main) && /\.finally\(\(\) => starting\.delete\(key\)\)/.test(main),
    "the running binding is not entered or not removed again");
  // And a click on a port already forwarded automatically is a request. The rule `sourceTo` computes that (table in
  // forwarding-rules.test.mjs), and every source but the browser's is remembered.
  assert.ok(/const fresh = f \? sourceTo\(f\.source, source\) : null;/.test(main) && /if \(fresh !== "browser"\) rememberForward\(instance, containerPort, f\.localPort, fresh\);/.test(main),
    "a manually requested forward on an automatic port stays \"browser\" and is never remembered");
});

test("the measurement cache is invalidated by what changes the port — not by traffic", () => {
  // `portsChanged` fires on EVERY tunneled TCP connection (open and close). If it cleared the
  // measurements, the cache would be cleared twice per HTTP request — and every further request to
  // a non-forwarded port would be held until TCP probe and gateway answer are in.
  const block = main.slice(main.indexOf("const portsChanged = () => {"), main.indexOf("function rememberForward("));
  assert.ok(!/forgetMeasurements/.test(block), "portsChanged clears the port measurements — our own traffic makes the cache worthless");
  assert.equal([...main.matchAll(/browserBridge\?\.forgetMeasurements\(containerPort, /g)].length, 2,
    "start- and stopForward do not both say which port to re-measure");
  assert.ok(/forgetMeasurements\(\.\.\.ports\)/.test(browser), "the bridge can only forget ALL measurements");
});

test("the bounds carry the window's page zoom", () => {
  // `getBoundingClientRect` measures CSS pixels, `setBounds` takes DIPs. The client's menu carries
  // `viewMenu` (Zoom In/Out/Actual Size), and Electron remembers the level per origin.
  assert.ok(/zoom = win\.webContents\.getZoomFactor\(\) \|\| 1;/.test(browser), "the zoom factor is not read");
  assert.ok(/clampRect\(visibleRect\(s\), \{ width: content\[0\] \?\? 0, height: content\[1\] \?\? 0 \}, zoom\)/.test(browser),
    "the zoom factor does not enter the bounds calculation — after a ⌘+ the page would sit too small and offset");
});

// The rules (deadline, light question, re-measuring, "not-measurable", null only for subrequests) are held by
// browser-rules.test.mjs; this test holds that browser.js uses them instead of a version of its own.
test("auto-forward measures through the rules: own deadline, re-measuring in the main frame, \"not-measurable\" with a sentence in the pane", () => {
  assert.ok(!/sessionRequest\(`/.test(browser), "browser.js asks the server bypassing containerMeasurement — with main.js's 4 s default");
  assert.ok(/const cache = measurementCache\(\{/.test(browser) && !/new Map\(\);\s*\/\/ "<scope>\|<port>"/.test(browser),
    "browser.js keeps a measurement cache of its own");
  assert.ok(/measurementForRequest\(\(opts\) => measurement\(port, s\.scope, opts\), mainFrame\)\.then\(/.test(browser),
    "the main frame does not re-measure — a single slow answer lets the page run into \"connection refused\"");
  // `withoutNull` must reach the cache — otherwise the main frame takes the subrequests' remembered null, and
  // "reload to measure again" asks nobody.
  assert.ok(/const measurement = \(port, scope, opts\) => cache\.measurement\(port, scope, opts\);/.test(browser),
    "browser.js does not pass the main frame's `withoutNull` to the cache — it would take the remembered \"not measurable\"");
  const block = browser.slice(browser.indexOf('if (choice === "not-measurable") {'), browser.indexOf('if (choice === "hint") {'));
  assert.ok(block.length > 0, "\"not-measurable\" is not handled — the page would silently run into \"connection refused\"");
  assert.ok(/s\.error = notMeasurableText\(port, m\.reason\);\s*\n\s*report\(s\);\s*\n\s*return callback\(\{ cancel: true \}\);/.test(block),
    "\"not-measurable\" tells the pane nothing, does not name the cause, or lets the request through after all");
  // The reason travels from containerMeasurement through the measurement into the pane's sentence.
  assert.ok(/containerHas: container\.has, reason: container\.reason,/.test(browser),
    "the measurement does not carry the reason — the pane would say \"in time\" for a 401, and re-measuring would never apply");
  assert.ok(/cache\.clear\(\)/.test(browser) && !/measurements\.clear\(\)/.test(browser), "the measurements are cleared bypassing the rule");
});

// browser-rules.js containerMeasurement reads the reason of a `has: null` from the SHAPE of the throws of main.js
// sessionRequest — `deadline: true` (only then does the main frame re-measure) and `status` (401 = expired session).
// browser-rules.test.mjs models the throws; this test holds that main.js throws them that way.
test("sessionRequest marks its throws the way containerMeasurement reads them (deadline, status)", () => {
  const block = main.slice(main.indexOf("function sessionRequest("), main.indexOf("function tunnelWsUrl("));
  assert.ok(block.length > 0, "sessionRequest is no longer in front of tunnelWsUrl — the anchor does not match");
  assert.ok(/reject\(Object\.assign\(new Error\("timed out"\), \{ deadline: true \}\)\)/.test(block),
    "the abort after the deadline does not carry `deadline: true` — containerMeasurement would take it for a network error: no re-measuring, wrong sentence");
  assert.ok(/Object\.assign\(new Error\(`Server responded with \$\{res\.statusCode\}`\), \{ status: res\.statusCode,/.test(block),
    "an answer ≥ 400 does not carry `status` — the pane would say \"unreachable\" for a 401");
  const rules = read("browser-rules.js");
  assert.ok(/if \(e\?\.deadline === true\) return "deadline";/.test(rules) && /if \(Number\.isInteger\(e\?\.status\)\) return `status:\$\{e\.status\}`;/.test(rules),
    "containerMeasurement no longer reads the markers of sessionRequest");
});

test("a destroyed scope leaves no open hints behind", () => {
  const block = browser.slice(browser.indexOf("function destroyScope(scope)"), browser.indexOf("function openTab("));
  assert.ok(/for \(const \[id, h\] of openHints\) if \(h\.scope === scope\) openHints\.delete\(id\);/.test(block),
    "the hints of a destroyed scope stay until quit — their answer would load into a view that no longer exists");
});
