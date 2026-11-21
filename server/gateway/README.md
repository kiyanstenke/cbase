# `server/gateway/` — the control plane

The gateway is the only process that listens on the network. It logs users in, starts one long-lived container per user, proxies
`/api/*` (HTTP and SSE) to that container and serves the shared web UI (`web/out`). It has no npm dependencies — only Node built-ins
(Node 22, `node:sqlite`). Configuration (`GW_*`) and the overall server layout: [../README.md](../README.md).

| File | What |
|---|---|
| `index.js` | the process: routes, login and sessions, administration, container lifecycle, serving `web/out` |
| `outerShell.js` | what `index.js` reads from every request before it decides, as pure functions |
| `proxy.js` | the streaming reverse proxy to the user container (no buffering, so SSE and uploads pass through) |
| `containers.js` | one container and named volumes per user over the docker CLI; `docker inspect` is the source of truth |
| `users.js` | users and sessions in the gateway's own SQLite database (scrypt passwords, only token hashes stored) |
| `resources.js`, `cbase-share.js` | RAM and CPU per user container as a computation; the server share of all user containers |
| `administration-contract.js` | the administration page's contract between gateway, web and iOS |
| `push.js` | iPhone notifications over APNs (the APNs key stays in the gateway, never in a user container) |
| `gateway-harness.mjs`, `*.test.js` | the tests: the real gateway as a child process against a fake docker |

Tests: `node --test server/gateway/*.test.js`, or the whole gate with `./check` from the repository root.
