# `preview/` — preview links for project containers (ngrok)

**What lives here:** the domain side of the preview links. In the UI a user creates a public link for a registered service
with a port of an instance; third parties open it in the browser. The path goes through the user's own ngrok account: the
backend builds ONE outgoing session to the ngrok edge, every link is a listener on it that forwards to its own rewrite proxy
in the backend (`127.0.0.1:<free>`), which forwards to `http://<instance-ip>:<port>` (without an instance `127.0.0.1`). The
proxy sets `Host: localhost:<port>` towards the service and rewrites `http://localhost:<port>` to the public address towards
the visitor — a link to the frontend port is enough, without changing the project's code or `.env`. Gateway and API fence see
nothing of it.

| File | What | Called by |
|---|---|---|
| `ngrok-session.js` | the ONE session: `@ngrok/ngrok` lazily via `createRequire` (if missing: `sdkExisting()` false, routes 501 `WITHOUT_SDK`), `open({ authtoken, target, domain, metadata, stoppedText }) → { url, proxy, close }` (first the proxy on `target`, then the listener on the proxy; `close` closes both), `checkAuthtoken` (its own throwaway session), `sessionClosed` (all listeners and proxies), `sessionsCounted`, test seam `setNgrokSdk` | `links.js`, test |
| `rewrite-proxy.js` | leaf, only `node:*`: `startRewriteProxy({ target, log, stoppedText }) → { url, port, target, close }` — `stoppedText()` per request/upgrade: a text ⇒ 502 with that text, nothing to the service (stopped instance) — Host/Origin/Referer to the service (no `X-Forwarded-Host` — Next.js Server Actions; the public address as `X-cbase-Public-Host`), text bodies and address headers to the visitor (streamed with a carry; 206 and `text/x-component` unchanged), `Set-Cookie` without `Domain=localhost`, gzip to the visitor with a flush per chunk, WebSocket raw, 502 for a dead service, an unusable response or a stopped instance; `rewriter(port, { host, schema })`, `proxyTarget(url)`, `openProxies()` | `ngrok-session.js`, tests |
| `ngrok-api.js` | leaf with `fetch`: `checkApiKey`, `reserve`, `gibFree` (404 = already released), `searchReservation` (after a reservation without a response); `{API}` = `CBASE_NGROK_API` at runtime, else `https://api.ngrok.com`; our texts never name the key, the `msg` taken over from ngrok can — `links.js` redacts | `links.js` |
| `contract.js` | leaf without imports: the contract of the seam (`POST_FIELDS`, `PUT_FIELDS`, `VALID_DAYS`, `MODES`, `LIMIT`, `STATES`, `ENDED_REASONS`, `LINK_FIELDS`, `STATUS_FIELDS`, `ACCESS_FIELDS`, `SSE_TYPE`, `HISTORY`) — do not rename, do not remove anything (the clients' binding test imports it) | `links.js`, `routes.js`, tests (backend and web) |
| `names.js` | leaf: `slugFrom` (`[a-z0-9-]`, ≤ 20, empty → `preview`), `randomPart` (`crypto.randomInt`), `domainFor` → `<slug>-<6>.ngrok.app`, `NAMES_ATTEMPTS` (1 + 3) | `links.js` |
| `links.js` | mode (`off`/`dev`/`names`, computed from the access), `createOne`, `revoke`, `targetRemoved` (observer of the delete paths, synchronous) + `previewPostWork`, `checkProcedure(now)` (expiry, target gone, target changed, retried releases, reopening), `reinstate`, tick, `readAccess`/`setAccess`/`deleteAccess`, `list`, `targetFor` (test seam `target`), `stoppedTextOf` (502 text for a stopped/stopping instance, live from the row — the link stays), `redact`, SSE `preview/link`, hooks `previewRestartGrace`/`previewServerEnd` | `routes.js`, `server.js` |
| `routes.js` | `previewRoutes` following the route contract: `/api/preview-links` (GET, POST), `/api/preview-links/:id` (DELETE), `/api/integrations/ngrok` (GET, PUT, DELETE); every response `Cache-Control: no-store`; the shape of the bodies (every field required, `null` explicit) | dispatcher (`ROUTES` in `server.js`, before `projectListRoutes`) |

Outside the folder: the data layer `../store/preview-links.js` (tables `ngrok_access` — one row, the values never go back
out — and `preview_links`), the observer of the delete paths `store.setTargetRemovedObserver`
(`../store/project-instances.js`, called from `deleteProjectInstance`, `deleteProject`, `deleteWorkspace`,
`deleteProjectService`, `serviceFallsWithLayout`, `reconcileScan`; wired in `../server.js`), the hook registrations
`restartGrace` (AFTER the project restore) and `serverEnd` (awaited, ≤ 5 s) in `../server.js`, the target from
`../projectbox/network-targets.js` (`instanceTarget`) and `../projectbox/address.js` (`hostPort`).

**Terms:**
- **Mode** — `dev`: authtoken only (Free plan), the account's dev address, without `.domain()`, one link at a time, visitors
  first see the ngrok warning page. `names`: authtoken + API key (Hobbyist), a reserved random name per link, three at a
  time, released at the end. `off`: no authtoken.
- **Active** — `ended_at IS NULL` (states `start` · `online` · `error`). Ended with reason `revoke` · `expired` · `error`;
  the row stays as history (the list shows the last 20).
- **Target gone** — instance, project or service deleted. The delete path reports it SYNCHRONOUSLY (`targetRemoved`): the
  link is ended (`error`) before the delete path returns, the listener closes at once — otherwise it would publicly point
  at the IP that `selectSubnet` gives the next instance. The tick is the safety net (orphaned: project, service, instance
  gone; a link without an instance of a project that has been converted meanwhile).
- **Target changed** — the same instance has a different IP: the tick closes the listener and opens on the new target (the
  opened target is kept at the listener in memory, not in a column); without an IP the link is in `error` until it has one
  again.

**Typical questions:**
1. *A link is in `error` — why, and does it come back?* `error` in the row (with `ERR_NGROK_…`); reopening on restart
   (`links.js:reinstate`) and then every minute (`links.js:checkProcedure`).
2. *Why does ngrok still have a reservation after a revoke?* The release failed (`approved_at IS NULL`); the tick retries it
   (`links.js:approve`, `store.previewLinksWithoutApproval`). An API key is still used for outstanding releases before it is
   deleted (`links.js:approvalsBeforeTheDelete`); if one stays open, it is NOT deleted (409 `APPROVAL_OPEN` with `open`).
   Without a key `approve` logs the name that stays at ngrok.
3. *Why only one ngrok session?* Free and Hobbyist allow three agents at a time; a session per link would use them up
   (`ngrok-session.js:fetchSession`). Guard: `server/backend/test/preview-links.test.js`.
4. *The frontend works through the link, but a call still points to localhost?* The proxy replaces only the port OF the link
   and only addresses written literally (`rewrite-proxy.js:rewriter`): a second port (`localhost:4201` in the browser) and a
   composed URL (`"http://localhost:" + port`) stay. Guard: `server/backend/test/preview-rewrite.test.js`.

**What does NOT live here:** an MCP tool (only the user creates links — no tool under `../../mcp/`, no row in the API fence,
both held by `preview-links.test.js`); the UI (web `components/pills/`, `components/settings/NgrokSettings.tsx`,
`lib/api/preview.ts`; iOS `Shell/PreviewLinks.swift`, `Settings/IntegrationsSettings.swift`). App configuration of the target
(Vite `server.allowedHosts`, NextAuth `AUTH_TRUST_HOST`) is not needed thanks to the rewrite proxy.

**Rules:**
- Access values never leave — no route, no SSE, no log, not even a rejected value (`links.js:redact` over every error text
  from SDK and API and in the 500 response of `routes.js`; ngrok repeats the token in ERR_NGROK_105/107).
- No second list: fields, value sets, limits, history and SSE type come from `contract.js`.
- A missing field is no statement: each of the four keys of the POST and both of the PUT are required, `null` explicit (400).
- Limit and row are ONE step (no `await` in between); a revoke ends the row exactly once (condition in the UPDATE) and wins
  against a creation that is still running (409 `REVOKE`).
- The test calls `checkProcedure(t)` and `reinstate()` directly — no clock, no tick in the test; it waits for the observer's
  post-work with `previewPostWork()`.

**Residual risks:**
- The rewrite proxy replaces `localhost:<port>` also where a text shows it on purpose (docs, a log on the page).
- A reservation whose response was lost (timeout AFTER creation) is searched via `searchReservation` and released. If the
  search fails too, or the reservation only comes into being after it, the name stays at ngrok (it is in the log).
- A delete path in the middle of an outer transaction that is rolled back afterwards has already ended the link and closed
  the listener (for `deleteProject`, `deleteWorkspace`, `serviceFallsWithLayout` and `reconcileScan` the report comes only
  after their own transaction).
- A new API key (instead of a deleted one) does not release outstanding reservations of the old account; a 404 of the new
  account counts as "released" there.
