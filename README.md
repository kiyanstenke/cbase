# cbase — monorepo

cbase is a Claude Code / Codex harness that runs client/server. The repo holds the server (gateway and one backend per user),
two clients (desktop, iOS) and a shared web UI. The backend also runs without a gateway (tests, probes, local development).

## Layout

```
cbase/
  web/          Shared frontend (Next.js, static export). ONE source of the UI; behind the gateway with
                login/account/environment, against a bare backend (tests, probes) without those edges.
  server/       Gateway / control plane for multi-tenant operation (server/gateway) and the per-user
                backend with image, tests and lockfile (server/backend).
  client/       Desktop app (Electron shell + connection page); loads the shared UI from the gateway.
  mobile/       iOS app (SwiftUI, its own Xcode project).
```

## Architecture

- **One long-lived container per user.** The backend runs unchanged and single-tenant inside it (it already assumes
  "one user, many workspaces"). Multi-tenancy comes from container separation — no `user_id` on every query, no
  Postgres migration. That settles filesystem isolation, auth and port namespaces at once.
- **Gateway** (`server/gateway/`): user management and login, container provisioning and lifecycle (idle → hibernate, the
  volume stays), reverse proxy for HTTP **and SSE**.
- **Own credentials per user.** Everyone brings their own Claude/Codex subscription and API keys; no shared login.
  - **Codex:** `codex login --device-auth` (device-code flow, no localhost callback).
  - **Claude:** long-lived token from `claude setup-token`, injected into the container as `CLAUDE_CODE_OAUTH_TOKEN`.

## Shared UI

`web/` is the only source of the interface. The desktop client loads it from the gateway; the core (chat, projects, editor,
terminals, …) stays DRY. Only the edges differ (connection, login, account, environment status) and sit behind a small
session/environment abstraction or in client-own screens.

## Requirements

- **Server:** Linux x86_64 with Docker. [Sysbox](https://github.com/nestybox/sysbox) is recommended (`GW_RUNTIME=sysbox-runc`): it gives
  every user container its own inner Docker without `--privileged`, which project containers need. Without it the gateway runs
  plain containers and project containers are unavailable.
- **Node.js 22** for the gateway, the backend and the tools (the backend image brings its own).
- **Desktop client:** macOS (Electron); **iOS app:** Xcode 26 or newer.
- Every user brings their own Claude and/or Codex subscription or API key.

## Quick start

```
(cd server/backend && npm ci)                    # backend dependencies for tests and tools
server/backend/build.sh                          # build the backend image (once / on changes)
(cd web && npm ci && npm run build)              # build the shared UI (the gateway serves web/out)
GW_RUNTIME=sysbox-runc node server/gateway/index.js   # start the gateway on 127.0.0.1:7719
```

Open `http://127.0.0.1:7719`: on first start the UI asks for the **initial setup** and creates the first admin account. The admin then
adds users under **Settings → Administration**; a user's first request starts their container. In production put the gateway
behind TLS (`GW_HOST=0.0.0.0`, `GW_SECURE=1`). Gateway settings (`GW_*`) and the server layout: [server/README.md](server/README.md).

Desktop client: `(cd client && npm ci && npm start)` — it asks for the gateway address. iOS: open `mobile/` in Xcode.

## Checks

One public gate for the whole tree — environment, syntax, import smoke test, tree guards, line count, guard register, whitespace,
then the test suites (backend, gateway, web, client, the gate's own tests):

```
./check --quick          # everything but the suites (a few seconds); the pre-push hook runs this
./check                  # the full gate (start it in the background; a green run leaves a marker for the same bytes)
./check --recheck        # the suites again, even if this exact tree was green within the hour
```

How the gate is built, how to add a test and what the guards promise: [tools/check/README.md](tools/check/README.md).
Switch the hook on once per clone: `git config core.hooksPath .githooks`.

## License

cbase is licensed under the Apache License, Version 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party attributions are in
[web/public/THIRD_PARTY_NOTICES.txt](web/public/THIRD_PARTY_NOTICES.txt). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md);
security reports: [SECURITY.md](SECURITY.md); conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
