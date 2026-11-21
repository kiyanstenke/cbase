# cbase client — desktop (remote mode)

The desktop app for client/server operation. It contains **no** backend: a thin Electron shell
connects to a cbase gateway and loads the shared web UI from there. Login/sessions are cookies in
the Electron session; in gateway mode the UI shows the login gate, user chip and sign-out by itself
(see `web/src/lib/gateway.tsx`).

## Files

- `main.js` — window (hiddenInset, traffic-light offset), server URL handling
  (`~/Library/Application Support/cbase Client/client-settings.json`), gateway probe (`/gw/info`),
  menu "Switch server…" (Cmd+Shift+K). Sets `nativeTheme.themeSource` to the mode the page chose
  (`cbase:theme`, stored as `theme` in the same file) — this keeps the native traffic lights visible
  without focus. Popups of the same origin (e.g. `/gw/admin`) open as child windows; foreign links
  (e.g. OAuth URLs from provider login consoles) go to the default browser.
- `connect.html` — connect page on first run (enter the server address, check, store).
- `preload.cjs` — the two narrow IPC bridges: `cbaseClient.connect/getServer` on the local connect
  page; `cbaseShell` (theme and window buttons) and `cbaseClient.ports` / `cbaseClient.browser` ONLY
  on the configured server origin.
- `browser.js` — the **native browser**: one `WebContentsView` per tab in the main window, bound to
  the rectangle of the browser pane in the web UI. Sessions `persist:browser-<scope>` per
  project/workspace, tabs per scope in `client-settings.json` (`browserTabs`), DevTools docked at the
  bottom, auto-forward of localhost ports through the existing tunnel. The AGENT browser stays
  streamed.
- `browser-rules.js` — the pure rules behind it (profile name, forward decision including origin,
  permissions of a foreign page, port from URL, scope lifetime, bounds clamp including page zoom,
  keyboard, remembered tabs). `browser.js` decides none of this itself — it measures and asks.
  Also the MEASUREMENT "does the container have the port?": `containerMeasurement` asks
  `/api/ports/running?ports=<P>&registered=1` with its own deadline `CONTAINER_DEADLINE_MS` (above
  the server's docker cap); `measurementForRequest` re-measures once in the main frame after an
  expired deadline, and if it stays open `forwardDecision` says "not-measurable": the request is
  cancelled and the pane shows `notMeasurableText(port, reason)`. `has: null` carries a `reason`
  (`deadline` · `status:<n>` · `network` · `unreadable` · `no-server`). `measurementCache` also remembers
  "not measurable" for `appliesMs`, but the main frame ignores a remembered null (`withoutNull`), so
  a reload measures again.
- `forwarding-rules.js` — port forwarding per INSTANCE: key (instance, port), the one-time migration
  of old stored entries to `instance: null`, the tunnel query (with instance
  `&instance=<identifier>`, WITHOUT instance no parameter — the server then decides as for an old
  client), the plan of `select`, and which instance the native browser means for a scope.
  EXCLUSIVE SELECTION: exactly one instance or none forwards, chosen in the services pill; the
  choice is stored as `activeInstance` in `client-settings.json` (IPC `cbase:ports:active`, report
  `cbase:ports-active`), its forwards carry `source: "selection"` and end with the next choice.
  `switchoverPlan` with `mode` "exclusive" (selecting: the local numbers are taken from everyone)
  or "bringAlong" (the pill adds services started later: a manual forward stays, its port is
  reported as `occupied`); `startState` at start: the one-time migration (marker
  `forwardingsWithoutInstanceRemoved`) and only the selection forwards of the active instance, each
  first on its own number; a fallback only selects if its choice still holds in the chain link
  (`ifActive`); `instanceForScope` gives the active instance's port to the native browser first.
  Who brings along, and why the pill, is in the header of `web/src/components/pills/ServicesPill.tsx`.
- `shell-rules.js` — the shell's outer boundaries as pure rules: `externalTarget` (what
  `shell.openExternal` receives: http, https, mailto and the VS Code link
  `vscode://vscode-remote/…` with only the pill's two authorities, `tunnel+<name>` and
  `attached-container+<hex>@tunnel+<name>`; opened in the parsed form — `main.js openExternally` is
  the ONE caller), `oauthRelayTarget` (the relay on 127.0.0.1:1455 only passes paths under
  `/api/codex-oauth` — dot segments, backslash and control characters rejected at every decoding
  stage, the prefix checked after normalization) and `ipcSenderAllowed` (every IPC channel of
  `main.js` and `browser.js` goes through `main.js pageMay`: the cbase window, its main frame, the
  origin of the surface "server" · "connect" (connect.html) · "window" (only
  `cbase:get-server-sync`)).

## Tests

All run without Electron: `cd client && node --test test/*.test.mjs`.

- `test/browser-rules.test.mjs`, `test/forwarding-rules.test.mjs` — the pure rules. The latter also
  holds "every relative file of the shell is in `build.files` AND `SHELL_FILES`".
- `test/shell-client.test.mjs` — the real `main.js` against a fake Electron from
  `test/shell-harness.mjs` (load hooks instead of the Electron import): theme contract, traffic
  lights on blur, `TRAFFIC_LIGHT_POSITION`, forwarding and selection over IPC, the outer boundaries
  (window open/will-navigate/permission with `smb://`, the relay with `/../`, every registered
  channel against subframe, child window, navigated-away frame and foreign origin).
- `test/browser-wiring.test.mjs` — a binding by path to lines in the main process whose absence
  breaks the browser (second window failing on IPC, views running on after close, permissions
  without a handler, two binders on one port, still-frame race). It says "the countermeasure is
  still there", not "it works" — the proof is the smoke test in the built client.
- `test/services-instances-ios.test.mjs` — text and executed-Swift guards for the iOS services pill.

Whether AppKit really draws the traffic lights visibly is not covered by any test; check it in the
built client.

**Pitfall:** a new file under `client/` must be registered in TWO places — `build.files` in
`client/package.json` (otherwise electron-builder does not pack it and the app does not start) and
`SHELL_FILES` in the deploy tool's client.mjs (otherwise the deploy tool reports "unchanged"
and leaves the old bundle). `test/forwarding-rules.test.mjs` holds every relative import of
`main.js`/`browser.js` against both lists.

## Development & build

```bash
cd client
npm install
npm start          # starts the app (first run: connect page; the FIRST start downloads the Electron binary)
npm run dist       # packages cbase Client.app (electron-builder, dist/mac-arm64)
```

To install, copy the built bundle to `/Applications`:

```bash
cp -R "dist/mac-arm64/cbase Client.app" "/Applications/cbase Client.app"
```

## App icon

`build/icon.png`, `build/icon.icns` and `build/Assets.car` are produced by
`tools/icon/build-icons.mjs` from `tools/icon/source.png`, together with the iOS icon and the lens.

```bash
node tools/icon/build-icons.mjs     # from the repo root; sharp comes from server/backend/node_modules
```

`tools/make-mac-icon.swift` is the older way: it fits a borderless artwork into the shape of a
template with a macOS mask (`swift tools/make-mac-icon.swift <artwork.png> <template.png> <target.png>`).
`build/icon.png` itself works as the template.

## Flow

1. First run → connect page: enter the gateway address (e.g. `https://cbase.example.com`).
2. The app checks `/gw/info`, stores the URL and loads the UI from the gateway.
3. Gateway login (or first-time setup of the admin account) → the personal server environment
   (container) starts automatically → the full cbase app.
