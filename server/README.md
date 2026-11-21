# cbase server — gateway + per-user backend

The server makes cbase multi-tenant **without** rewriting the backend: every user gets their own Docker container in which the
backend (`server/backend/`) runs single-tenant. The gateway in front handles login, user management, container lifecycle and
proxying.

```
Client ──HTTPS/SSE──▶ Gateway (gateway/)      ──▶ container user A (backend/ image, volume A)
                       · cbase login (cookie)  ──▶ container user B (…, volume B)
                       · user administration (admin)
                       · serves the web UI (web/out)
                       · proxies /api/* to the container (incl. SSE/terminals)
                       · idle stop (optional)
```

## Components

### `backend/` — image of the per-user backend
- `Dockerfile`: `node:22-bookworm-slim` + git/ripgrep/compilers + the **claude and codex CLIs** (npm -g, pinned) + backend code.
  Runs as user `agent`; `$HOME=/home/agent` is the persistent volume (SQLite DB, workspaces, `~/.claude`, `~/.codex`).
- `headless.js`: starts `startServer` from `server/backend/electron/server` without Electron (`CBASE_HOST=0.0.0.0`, `CBASE_UI_LANG=de` would make German the default until a client reports its language; English otherwise, data
  under `/home/agent/cbase`).
- `build.sh`: stages a lean build context (copies `server/backend/electron`) and builds the images `cbase-backend` (override
  with `CBASE_IMAGE`) and `cbase-projectbox`.

```bash
server/backend/build.sh
```

### `gateway/` — control plane (no external dependencies)
- `index.js` — HTTP server: `/gw/*` (auth, admin, environment), static web UI, `/api/*` proxy.
- `users.js` — users and sessions (node:sqlite, scrypt, token hashes).
- `containers.js` — Docker CLI: create/start/stop one container per user (`cbase-u-<id>`, volume `cbase-u-<id>-home`, dynamic
  host port on 127.0.0.1), health wait, single flight.
- `proxy.js` — streaming proxy (SSE-safe; counts open streams for the idle reaper).
- `resources.js` — the pure computations of the administration: required keys of the bodies, `docker run` / `docker update`
  arguments, back-computation from `docker inspect`, response shapes, `resources-desired.json`. The numbers themselves (levels,
  shares, minimum RAM, buffer, reserve) live ONCE in `administration-contract.js` — the seam to web and iOS, a sheet without imports.
- `cbase-share.js` — consumption from the cgroups (host share for `/gw/host`, per container for the administration on request).
- `push.js` — per-user event stream and APNs delivery; `outerShell.js` — login brake and error policy of the gateway's outer
  skin.
- The administration (admins only) is **Settings → Administration** in web and iOS; `GET /gw/admin` redirects there
  (`/?settings=administration`).

```bash
cd web && npm run build          # build the web UI once (the gateway serves web/out)
node server/gateway/index.js     # start the gateway
```

On first call the UI asks for the **initial setup** (admin account). After that the admin creates users under
**Settings → Administration**. A user's first API access provisions their container automatically (seconds), with the limits
stored for that user.

### Administration: users and resources per container

Routes (all behind the admin check, otherwise 403; fields and required keys in `gateway/administration-contract.js`):

| Route | Effect |
|---|---|
| `GET /gw/admin/administration` | `{ server, user }`: threads, RAM, reserve, sum of RAM limits; per user role, lock, resources, `actual` (from `docker inspect` and `cpu.weight`), `consumption` (cgroups), container state. Docker silent ⇒ 502 (never "missing"). |
| `POST /gw/admin/users` | create (`username`, `password`, `role` — all required); resources = the unit's template |
| `PATCH /gw/admin/users/:id` | EXACTLY one of `role` / `locked`; demoting or locking the last active admin, or locking yourself ⇒ 400 |
| `POST /gw/admin/users/:id/password` | set the password |
| `PUT /gw/admin/users/:id/resources` | `ramGiB`, `cpuPrio`, `cpuMax` (all required, `null` = no hard limit): stored first, then applied with `docker update <id>` (swap = 2 × RAM; "no limit" = `--cpus <threads>`). RAM below consumption + 512 MiB of a running container ⇒ 409 with `consumptionBytes`; 409 during teardown; stored but not applied ⇒ 502. |
| `POST /gw/admin/users/:id/start` · `restart` · `stop` | container actions; locked or being torn down ⇒ 409 |
| `DELETE /gw/admin/users/:id[?purge=1]` | lock, tear down, then delete |

The values live in `gateway.db` (table `container_resources`). If a user has no row (existing state), the gateway reads the limits
of their container from `docker inspect` at start and adopts them — the container itself does not change; without a container the
template applies. At every start and every change the gateway atomically writes `GW_DATA/resources-desired.json`
(`{ <userId>: { memory, nanoCpus, cpuShares } }`), against which the deploy tool compares each container.

## Configuration (env)

| Variable | Default | Meaning |
|---|---|---|
| `GW_PORT` | `7719` | gateway port |
| `GW_HOST` | `127.0.0.1` | bind address (production: `0.0.0.0` behind TLS termination) |
| `GW_DATA` | `gateway/data` | gateway DB (users/sessions) |
| `GW_WEB_DIR` | `../../web/out` | built web UI |
| `GW_IMAGE` | `cbase-backend` | backend image |
| `GW_IDLE_STOP_MIN` | `0` (off) | stop a container after X min without activity/streams (the volume stays) |
| `GW_CONTAINER_MEM` / `GW_CONTAINER_CPUS` | — | only the **template** for new users and for existing users without a container; what applies is stored per user in `gateway.db` (`CPUS` is a HARD limit) |
| `GW_CONTAINER_CPU_SHARES` | — | template of the weight under contention (`--cpu-shares`), rounded to the nearest level (1287 = "low" = cpu.weight 50). Only counts against siblings in system.slice; the conversion depends on the runtime (`CPU_PRIO_SHARES` in `administration-contract.js`) |
| `GW_SECURE` | — | `1` = Secure flag on session cookies (behind HTTPS) |
| `GW_TRUSTED_PROXYS` | — (loopback only) | comma list of further addresses whose `CF-Connecting-IP` counts as the real client address (login brake); only needed if cloudflared does not connect over loopback |
| `GW_USER_QUOTA_GB` | `0` (none) | optional storage quota shown for the own environment |
| `GW_CGROUP_ROOT` | — | cgroup root override for the consumption meter (tests) |
| `GW_PROJECT_STOP_CAP_MS` | derived | cap for the exec that stops project containers before a backend is removed (tests set it small) |
| `GW_PUSH_SILENCE_MS` / `GW_PUSH_GAP_MS` / `GW_PUSH_SHORT_MS` | 90 s / 2 s / 1 s | idle deadline, reason gap and "too short stream" threshold of the event stream |
| `GW_APNS_TEAM_ID` | — | Apple team ID for native iPhone notifications |
| `GW_APNS_TOPIC` | `dev.cbase.mobile` | APNs topic / bundle ID |
| `GW_APNS_KEY_ID` / `GW_APNS_KEY_PATH` | — | key ID and `.p8` secret for sandbox and production |
| `GW_APNS_SANDBOX_KEY_ID` / `GW_APNS_SANDBOX_KEY_PATH` | shared key | optional override for Xcode development builds |
| `GW_APNS_PRODUCTION_KEY_ID` / `GW_APNS_PRODUCTION_KEY_PATH` | shared key | optional override for TestFlight / App Store |

A normal APNs signing key serves both environments; the separate variables are only for deliberately environment-restricted
keys. Key files belong to the gateway as a host/orchestrator secret, never in the image or the user containers. The app registers
tokens authenticated under `/gw/push/devices/current`; the gateway ties them to the logged-in user and removes tokens APNs
rejects or reports expired.

**Outer skin of the gateway** (`gateway/outerShell.js`, guard `gateway/index.test.js`):

- **Login brake:** only failures count, per connection (IPv4 address, for IPv6 the /64; 10 in 5 min) and per user name (30 in
  5 min — a connection from which the name logged in successfully in the last 30 days is exempt; remembered in `gateway.db`, table
  `login_proven`, so it survives a restart). Password checking (scrypt) runs asynchronously, at most two at a time — beyond that
  429 at once.
- **No delivery token any more:** `/gw/ingest-tokens` is gone, the table `ingest_tokens` is dropped at start, and `/api/ingest/*`
  is a path like any other — 401 without a session, without waking a backend.
- **Deleting a user** locks first (sessions, login, container start), then tears down; the user disappears only when the container
  (and with `purge` both volumes) is really gone — otherwise 500, the user stays locked ("deletion incomplete" in the
  administration) and the deletion can be repeated.
- **Event stream per user** (`gateway/push.js`): one event at most 1 MiB, a per-minute budget, an idle deadline; catching up on
  missed notifications takes at most 200 notes per response (the backend's ring buffer holds 100) and writes the cursor once. A
  violation — also a stream the backend closes after less than a second — doubles the reconnect gap up to 5 min.

## Provider auth (own subscription per user)

Each user authenticates their LLM providers **inside their container**:
- **Codex:** `codex login --device-auth` — device-code flow (URL + one-time code, no localhost callback); convenient through the
  terminal tab or the login console in the UI.
- **Claude:** token from `claude setup-token` (generated locally) stored in the container, or `claude auth login` in the UI login
  console (Linux: credentials in `~/.claude`).
- Third-party API keys: as before, in the settings — they live in the user's container DB.

## Security / limits

- Isolation = container boundary: bash and agents only see their own `/home/agent`.
- The gateway binds container ports on `127.0.0.1` only; outward, only the gateway speaks.
- TLS is the job of an upstream reverse proxy (Caddy/nginx/Traefik) — then set `GW_SECURE=1`.
- The gateway's `docker` access is root-equivalent on the host; operate it accordingly.
