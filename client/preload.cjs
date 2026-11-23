// Preload of the cbase client. Two separate, narrow bridges:
//  • file://connect.html → connection API (check/store the server URL)
//  • the configured server origin → port-forwarding API, the chosen theme and the header's window
//    buttons. Only this one origin gets the surface — foreign pages (external links etc.) see nothing.
const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("cbaseClient", {
    connect: (url) => ipcRenderer.invoke("cbase:connect", url),
    getServer: () => ipcRenderer.invoke("cbase:get-server"),
  });
} else {
  let serverOrigin = "";
  try { serverOrigin = new URL(ipcRenderer.sendSync("cbase:get-server-sync") || "").origin; } catch { /* no server set */ }
  if (serverOrigin && location.origin === serverOrigin) {
    // Theme and window buttons: `setTheme(mode)` reports the CHOSEN mode (light · dark · system);
    // main.js sets `nativeTheme.themeSource` with it, and AppKit draws the traffic lights visibly
    // even in an unfocused window. Its mere PRESENCE is the version switch: an older client lacks
    // it, and the header then draws the grey state itself — hence the three button actions remain.
    const press = (action) => ipcRenderer.invoke("cbase:window-button", action);
    // One listener per channel, always with an unsubscribe: a React pane mounts and unmounts, and a
    // listener without one would pile up on every tab switch.
    const listeners = (channel, cb) => {
      const h = (_ev, payload) => cb(payload);
      ipcRenderer.on(channel, h);
      return () => ipcRenderer.removeListener(channel, h);
    };
    // Text size of the whole app: the page reports its level (`setTextSize`, which sets the check
    // mark under "View → Text Size" and turns ⌘+ / ⌘− / ⌘0 into text size), the menu sends
    // commands back (`onTextSize`: "+1", "-1", "0" or a level). Its PRESENCE is the version switch
    // (web/src/lib/shell-bridge.ts).
    contextBridge.exposeInMainWorld("cbaseShell", {
      windowClose: () => press("close"),
      windowMinimize: () => press("minimize"),
      windowZoom: () => press("zoom"),
      setTheme: (mode) => ipcRenderer.send("cbase:theme", mode),
      setTextSize: (stage) => ipcRenderer.send("cbase:textSize", stage),
      onTextSize: (cb) => listeners("cbase:text-size-command", cb),
      // The desktop app's version for Settings → About (`app.getVersion()`). Its PRESENCE is the version switch: an older
      // client lacks it, and the web shows "unknown" for the desktop app.
      appVersion: () => ipcRenderer.invoke("cbase:app-version"),
    });
    contextBridge.exposeInMainWorld("cbaseClient", {
      // Per instance ("<projectId>/<instance>", none = null): `forward`/`stop` take it as the last argument — a UI that
      // does not know it calls with (port[, localPort]) as before. `select` switches all ports of an instance; its
      // PRESENCE is the version switch for the web.
      ports: {
        list: () => ipcRenderer.invoke("cbase:ports:list"),
        forward: (port, localPort, instance) => ipcRenderer.invoke("cbase:ports:forward", port, localPort, instance),
        stop: (port, instance) => ipcRenderer.invoke("cbase:ports:stop", port, instance),
        // With `options` `{ mode: "exclusive" | "bringAlong" }` the exclusive selection; without, the plain switchover
        // (an older UI keeps calling with two arguments).
        select: (instance, ports, options) => ipcRenderer.invoke("cbase:ports:select", instance, ports, options),
        // The choice: which instance forwards the ports (identifier or null = none). The PRESENCE of `active` is the
        // version switch of the selection in the web; `onActive` reports every change (including the fallback of a removed copy).
        active: () => ipcRenderer.invoke("cbase:ports:active"),
        onActive: (cb) => listeners("cbase:ports-active", cb),
        // Lift a forward without an instance to its instance — the client measures itself whether it leads there today.
        // Its PRESENCE is the version switch.
        lift: (port, instance) => ipcRenderer.invoke("cbase:ports:lift", port, instance),
        onChanged: (cb) => listeners("cbase:ports-changed", cb),
      },
      // The native browser. Its mere PRESENCE is the version switch: an older client lacks it, and
      // the web then uses the streamed browser. So nothing belongs here that would answer without
      // the module in the main process.
      browser: {
        open: (scope) => ipcRenderer.invoke("cbase:browser:open", scope),
        // Bounds without a reply: they arrive on every resize tick and every scroll; an invoke each
        // would mean a round trip per frame.
        bounds: (scope, hostId, rect) => ipcRenderer.send("cbase:browser:bounds", scope, hostId, rect),
        stillFrame: (scope, on) => ipcRenderer.invoke("cbase:browser:stillFrame", scope, on),
        navigate: (scope, url) => ipcRenderer.invoke("cbase:browser:navigate", scope, url),
        back: (scope) => ipcRenderer.invoke("cbase:browser:back", scope),
        forward: (scope) => ipcRenderer.invoke("cbase:browser:forward", scope),
        reload: (scope) => ipcRenderer.invoke("cbase:browser:reload", scope),
        stop: (scope) => ipcRenderer.invoke("cbase:browser:stop", scope),
        newTab: (scope, url) => ipcRenderer.invoke("cbase:browser:newTab", scope, url),
        tabClose: (scope, tabId) => ipcRenderer.invoke("cbase:browser:tabClose", scope, tabId),
        selectTab: (scope, tabId) => ipcRenderer.invoke("cbase:browser:selectTab", scope, tabId),
        devtools: (scope, open) => ipcRenderer.invoke("cbase:browser:devtools", scope, open),
        extern: (url) => ipcRenderer.send("cbase:browser:extern", url),
        hintResponse: (id, choice) => ipcRenderer.invoke("cbase:browser:hintResponse", id, choice),
        onState: (cb) => listeners("cbase:browser-state", cb),
        onHint: (cb) => listeners("cbase:browser-hint", cb),
        onAddressBar: (cb) => listeners("cbase:browser-address-bar", cb),
      },
    });
  }
}
