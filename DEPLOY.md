# Deployment

This is the maintainer's rollout tool. You can use it for your own server, but it is not needed to contribute: the public gate
(`./check`) is complete on its own. The maintainer also keeps extra, non-public checks in a separate tree; contributors never need
them.

The client and mobile targets need a Mac: the desktop client is built for macOS arm64 only (`tools/deploy/targets/client.mjs`),
and iOS needs Xcode. Without a Mac use `./deploy web server` instead of `all`.

### Host prerequisites

- Linux x86_64 with Docker.
- [Sysbox](https://github.com/nestybox/sysbox): the generated gateway unit (`tools/deploy/templates/cbase-gateway.service`) sets
  `GW_RUNTIME=sysbox-runc`, so user containers run under the Sysbox runtime.
- A systemd user session that survives logout: `loginctl enable-linger <user>`.
- `rsync`.
- Node 22 at the path `remote.node` (default `/usr/bin/node`, see `tools/deploy/config.mjs`).
- `ionice` (util-linux): image builds on the host run under `nice -n 10 ionice -c3` (`tools/deploy/lib/build-throttle.mjs`).

One tool rolls out every part of cbase: the web UI, the backend in the user containers, the desktop client and the iOS app.

```sh
./deploy status          # measure only: what runs where, what deviates
./deploy check           # the gate, nothing is rolled out
./deploy all             # web → server → client
```

`./deploy` is a thin shell wrapper around `tools/deploy/deploy.mjs`, a Node script without dependencies. It does not replace the
build steps themselves (`npm run dist` for the client, `docker build` for the image, the `.command` scripts for iOS); it makes
everything around them mandatory: measure, check, secure, and look again afterwards. The public gate lives in `tools/check/`
(called directly as `./check`). Details on single guards and folders of the tool are in `tools/deploy/README.md`.

Two words used throughout: **B** is the per-user backend in its user container (`cbase-u-<id>`, behind the gateway); a **latch** is a
test that pins one promise of the code (the register of all of them is `tools/check/latch.json`; every test file the gate runs
must be listed there).

## Setup

1. Copy `deploy.local.example.json` to `deploy.local.json` (gitignored) and fill in what is specific to your machine:
   SSH host (`user@server`), key and known-hosts file, the server root (`remote.root`, default `/srv/cbase-server`), and for iOS the desktop user, the Xcode location, the device UDID and the simulator.
   Everything else (gateway port `remote.gatewayPort`, paths, image and bundle names) has a default in `tools/deploy/config.mjs`.
2. Every value can also be set by environment variable, which wins over the file: `CBASE_SSH_HOST`, `CBASE_SSH_KEY`,
   `CBASE_SSH_KNOWN_HOSTS`, `CBASE_REMOTE_ROOT`, `CBASE_GATEWAY_PORT`, `CBASE_CONTAINER_PREFIX`, `CBASE_IMAGE`,
   `CBASE_PROJECTBOX_IMAGE`, `CBASE_CLIENT_APP`, `CBASE_DESKTOP_USER`, `CBASE_XCODE_APP`, `CBASE_DEVICE_UDID`, `CBASE_SIMULATOR`,
   `CBASE_TEST_DERIVED_DATA`, `CBASE_GIT_BRANCH`, `CBASE_GIT_REMOTE`, `CBASE_REMOTE_NODE`, `CBASE_CLEANUP_CRON_UTC_HOUR`.
3. Set the gateway port if 7719 is taken on the host. Running a second installation side by side needs its own root, port,
   container prefix and image names.
4. Mark the checkout as a rollout checkout (see "Rollout checkout" below):
   ```sh
   pwd -P > .cbase-rollout-checkout
   ```
5. Switch on the pre-push hook, once per clone (the hook is versioned, switching it on is not):
   ```sh
   git config core.hooksPath .githooks
   ```
6. For the gate: the dependencies of every package and [gitleaks](https://github.com/gitleaks/gitleaks) on the `PATH`. A missing
   gitleaks is red, not skipped. `CONTRIBUTING.md` lists the exact setup commands.

SSH always runs with `-o BatchMode=yes -o ConnectTimeout=10`: a connection that would need an interactive login fails after ten
seconds instead of asking. If a deploy stops at the first SSH step, check your SSH access first, not the server.

### First installation on the host

```sh
./deploy init            # once, on a fresh host
```

`init` creates `<root>/{releases,data,secrets,backups,gateway,web-out}` (`secrets` with mode 700) and writes the systemd user unit
`~/.config/systemd/user/cbase-gateway.service` from `tools/deploy/templates/cbase-gateway.service` (root, port and image filled in
from the configuration), followed by `systemctl --user daemon-reload`. It does not start or enable the unit, does not touch Docker
and rolls out no code. The first `./deploy server --gateway` brings the gateway code; starting the unit is your decision. `init`
refuses an existing root or unit; with `--force` it only completes the folders and moves an existing unit aside as
`<unit>.bak-<release>`. Nothing is ever deleted.

## Rollout checkout

Rollout commands (`server`, `web`, `client`, `rollback`, `all`, `init`) run only from a checkout that carries both:

- `deploy.local.json` in the repo root, and
- the file `.cbase-rollout-checkout` in the repo root (gitignored, never tracked) whose content is exactly the real path of this
  checkout (`pwd -P`).

The marker is untracked and bound to the path on purpose: a clone or a copied folder never carries a valid one, and a stray
`deploy.local.json` alone unlocks nothing. So a working tree used for development cannot roll out by accident. The rule is checked
twice: in the shell wrapper `./deploy` and again in `deploy.mjs` before any rollout work, so `node tools/deploy/deploy.mjs server`
does not bypass it.

`check` and `status` are free everywhere. The wrapper `./deploy` lets through only these words and the rollout commands; for `mobile`
call the script directly: `node tools/deploy/deploy.mjs mobile …`.

## Targets

| Target | What happens | Downtime |
|---|---|---|
| `status` | measure, change nothing (see "What `status` answers") | none |
| `check` | the gate: syntax, tests, guards, `git diff --check` | none |
| `web` | build `web/`, sync `web/out` to `web-out` on the server | none |
| `server` | create a release, build the image **and check it**, swap the user containers, restore their inner containers | container restart |
| `client` | rebuild the desktop client only if its shell changed (shell files, icon, Electron version against `client/node_modules`), then restart it | client restart |
| `all` | `web`, `server`, `client` | see above |
| `mobile` | iOS: `--device` (default), `--testflight` or `--ipa`; or `--tests` for the XCUITests in the simulator | — |
| `rollback server\|client` | back one release (see "Rollback") | container or client restart |
| `init` | first installation on the host (see "Setup") | none |

The order is fixed, however the targets appear on the command line: **web-out first** (uninterrupted), then the container, then
**the client last**. The client calls `/gw/env/ensure` when it starts; if that finds a running, healthy container the gateway leaves it
alone, otherwise it replaces it, and the inner services are gone a second time.

`mobile` is deliberately not part of `all`: TestFlight uploads to Apple, and `--device` needs an unlocked iPhone, either cabled or
paired on the same Wi-Fi. The preflight wakes a sleeping Wi-Fi tunnel via `devicectl device info details` and reports whether the
phone is reachable by cable or Wi-Fi (`tools/deploy/lib/iphone.mjs`, the same rule as in `status`).

The maintainer's tree carries one more target, `baseline`, which records the reference of the workflow tool from a Claude Code
binary. It is maintainer-only and not part of the public tree.

## Options

```
-c, --commit            after a successful deploy commit EVERYTHING and push
-m, --message <text>    subject line for that commit
-n, --dry-run           only show what would run; measurements still run
-y, --yes               no questions (unattended runs)
    --force             bypass gates (running work is lost)
    --wait [s]          wait for idle before destructive steps (default 300)
    --skip-tests        skip the checks
    --quick             checks without the test suites
    --recheck           run the suites even if a full gate was green on the same working tree within the hour
    --gateway           roll out the gateway code too (restart: open SSE streams break)
    --settle <s>        post-observation after the container swap (default 150, 0 = off)
    --cron-window-ignore
                        server / all / rollback server only: bypass the cleanup-cron guard
    --release <id>      set the release id (default: YYYYMMDD-<epoch-ms>)
    --to <id>           target of a rollback (a release, or a client backup)
```

Rollback-only switches (`rollback server` only; each bypasses exactly one *unknown* count, see "Rollback lock"):
`--rollback-without-relocation`, `--rollback-without-copy`, `--rollback-without-episodes`, `--rollback-without-lfs`,
`--rollback-without-layout`, `--rollback-without-instance-stopped`, `--rollback-without-bridge-cbp`. On any other command these switches are an error rather than
silently doing nothing; the same holds for `--cron-window-ignore` outside `server`, `all` and `rollback server`.

Options of `mobile --tests`: `--only <id>`, `--runs <n>`, `--wait <s>` (default 600 there) and `--force` (see below). They belong
to `mobile` alone, and `--only`/`--runs` only together with `--tests`.

A deploy release id names one rollout; it is not the product version (see [VERSIONING.md](VERSIONING.md)).

Exit codes: `0` success, `1` error, `2` aborted by a gate or a question. Every run writes a complete log to
`.deploy-logs/<release>-<targets>.log`; an abort writes its reason into the log before the process ends. Every step shows
`[+m:ss]` since the start, and "Done" prints a table with the duration per step and the total.

## Git: always `main`, always everything

Two rules of the maintainer's own rollout workflow, which the tool enforces. They are about rolling out a live installation from one
checked tree, not about how contributions arrive: pull requests from branches and forks are welcome (see CONTRIBUTING.md); the
maintainer merges them to `main` before a rollout.

**Work happens on `main`.** On another branch `./deploy` refuses service. `--force` bypasses that, but never together with
`--commit`. The check runs before the first step, so nothing is built from a wrong branch.

**`--commit` takes the whole working tree.**

```sh
./deploy all --commit                         # roll out, then commit everything and push
./deploy all --commit -m "Fix the review node" # with your own subject line
```

There is no picking of single files and no regard for other, unfinished work in the tree: `git add -A`, commit, push to the
configured remote and branch (default `origin`/`main`, set in `deploy.local.json` under `git`). What must not go along belongs in
`.gitignore`; `deploy.local.json`, `.cbase-rollout-checkout` and `.deploy-logs/` are already there.

The commit happens **after** the last successful target: what is not rolled out is not pushed. If something fails before, the
working tree stays untouched. After the push the tool checks that the remote branch really points at `HEAD`; if the remote is ahead,
it stops with the `git pull --rebase … && git push …` command to run instead of rewriting history on its own.

## The gate

`./deploy check` runs the gate without rolling anything out. `./deploy <target>` runs it on its own before the first step (skipped
with `--skip-tests`, or reduced to the quick checks when nothing is shipped, for example a client whose shell did not change).

- **Plan.** In the public tree `./deploy check` runs the same public plan as `./check`: Backend, Gateway, Web, Client, Gate tool,
  Deploy tool and macOS (the macOS suite only on macOS). In the maintainer's tree it runs a merged plan instead:
  the public suites plus the maintainer's private suites and their own guard register.
- **Quick checks** (always, also with `--quick`): `node --check` over every backend file, an import smoke test of `server.js` and
  `store.js` (the only check that sees a missing named export or an import cycle at module level), the tree guards (route
  registration, schema and hook registers, no back-imports), the line-count guard (no source file over 2,000 lines; exceptions in
  `tools/check/loc-allow.json`, which may only shrink), the guard register (every test file the gate runs is listed in
  `tools/check/latch.json`, and every listed file exists), `tsc --noEmit -p web`, the secret scan with gitleaks over the public
  files, and `git diff --check`. The cleanliness guard (nothing private in the public tree) runs as a test in the suites.
- **Verdict per suite.** Red on exit ≠ 0, on `# fail N > 0`, on `# skipped N > 0` (`node --test` counts a skip as passed), and on
  output whose counts cannot be read. Every suite runs with `--test-reporter=tap`, and the gate removes an inherited
  `NODE_TEST_CONTEXT` from the child environment (otherwise the child prints nothing and exits 0).
- **Two phases.** The short suites run together first, then the backend alone. The backend width is
  `max(3, min(10, cores − 4 − foreign))`, where `foreign` is the load above a base load of 0.5 per core, measured at the gate start and
  again before the backend (the smaller value counts).
- **Stall instead of total time.** A suite is aborted after 300 s without a TAP result (`ok N` / `not ok N`), with an emergency cap
  of one hour. The whole process group is killed, so no grandchild survives; Ctrl-C is passed on to the groups.
- **One gate per machine.** A full gate takes the lock `/tmp/cbase.gate.lock`; a second one (other session, other worktree, or the
  gate of a `./deploy all`) waits and says on whom. A lock whose process is dead, or whose pid was reused, is free. `--quick` never
  takes the lock.
- **Gate marker.** A full, green gate records a key of what it tested: the working tree, the working tree of the maintainer's private
  clone if there is one, and the installed dependencies. The marker lives once per machine (`~/.cache/cbase-gate/gate-ok.json`, or the private
  part's own file for the merged plan; `CBASE_GATE_MARKER_DIR` moves it), not per clone. A deploy with the same key within one hour,
  from any clone, runs only the quick checks and logs why. `--recheck` forces the suites; `--quick` never writes a marker. So the
  efficient way is `./deploy check` in the development clone, read the result, push, pull in the rollout clone (also its private clone),
  then `./deploy all` there.

Knobs for other machines (for example a clone with few cores):

| Variable | Default | Meaning |
|---|---|---|
| `CBASE_SUITE_STALL_MS` | 300000 | abort a suite after this long without a test result |
| `CBASE_SUITE_TIMEOUT_MS` | 3600000 | emergency cap on the total duration of each suite |
| `CBASE_TEST_CONCURRENCY` | computed (above) | width of the backend suite; overrides cores and load |

**The pre-push hook** (`.githooks/pre-push`) runs `./check --quick` (a few seconds) for a bare `git push` that goes past
`./deploy`. A push from `./deploy --commit` skips it, because the full gate ran minutes before. Skip it once with
`git push --no-verify`. `./deploy status` shows whether it is switched on.

## What the tool checks

**Before the build**

- The quick checks and suites of the gate (above).
- Root-owned build artifacts: a former `sudo` build leaves files npm cannot delete, while the wrapper still reports exit 0. The tool
  finds them first and prints the `chown` command.

**After the build**

- `index.html` in the web build output (`out/` under `web`) must be newer than the build start (a timestamp, not an exit code).
- The tree `electron/server/` inside the built `app.asar` must equal the working tree. The hash is over the tree, not one file: all
  `*.js` recursively, sorted by relative path, sha256 over `<relpath>\n<sha256(content)>\n`. The same recipe is used for the image,
  `current/` on the server and the running container.
- The Electron version in the built client bundle must equal `client/node_modules/electron`. A version jump alone is a reason to
  rebuild; unknown on either side is never "equal".
- Every Mach-O file in the built bundle is checked with `codesign -v --strict` (recognized by magic bytes, not by extension), plus the
  seal of the whole bundle with `codesign --verify --deep --strict`. Invalid means no swap.

**Before destructive steps (gates)**

An answer that is not a real answer (error body, timeout, 500, an object without `busy`) counts as busy. Unknown is never free.

- `/api/runs/active` in every user container. `busy` counts runs and live background agents. Running dynamic workflows are not
  counted: the swap interrupts them and the restarted server resumes them from their journal (agents that were running start
  again, so their tokens are spent twice). Gate and `status` show them in the row "Dynamic workflows".
- Background oneshots (compact, title, classification runs): read from the full process list in the container and from the
  backend's own count; more than 0 is busy. An unreadable process list is "unknown" and holds like a running oneshot. An agent of a
  dynamic workflow does not hold; a subagent does.
- Project instances in setup, start, re-creation or relocation count as busy too; `--force` aborts them midway.
- Running project services are not covered by `/api/runs/active` and do not survive a restart. The tool lists them and asks one by
  one.
- `--wait <s>` waits up to that long for idle instead of aborting; `--force` goes ahead regardless.

**The server image**

- With the private part present, `server` first checks the pin-sync guard: if the Claude Code pin in `server/backend/Dockerfile`
  moved without the artifacts written against that version, it stops before the image build (`--force` bypasses). Without the
  private part it warns and skips this check.
- The image is built as `cbase-backend:cand-<release>` and moved to `:latest` only **after** the checks pass, because the gateway
  creates new containers from `:latest` at any time. Checked inside the image, not in the source tree: `chromium` and `task` present,
  every `.js` under `electron/server` parses, `server.js` and `store.js` import, the tree equals the working tree, the dead
  `onnxruntime-web` package is absent. The project box image is built as `cbase-projectbox:cand-<release>`, probed, and distributed
  into every user container before the swap. If anything fails, `:latest` and `current` stay untouched and everything keeps running.
- Image builds run under `nice -n 10 ionice -c3`.

**The build stamp.** `web` and `server` compute the build id once per run (`node tools/version.mjs describe --json`; rules in
`VERSIONING.md`) and write `build.json` — `version`, `build`, `commit`, `dirty`, `release`, `builtAt` — into `releases/<id>/` (the
gateway reports it on `/gw/info` through `current/`) and into `web-out/`. It does **not** go into the image: a stamp there would
change the image on every deploy, so every user container would be swapped even with an unchanged backend. The backend therefore
knows no build id (`GET /api/version` answers only the product version and the API level). The file is never committed
(`.gitignore`). A checkout with uncommitted changes rolls out with a warning and a build id ending in `.dirty`; if the build id
cannot be computed, the stamp says `<version>+unknown` with a warning — never a clean-looking build. The local copy stays in `.deploy-logs/build-<release>.json`, and the header and final table of the run
name the build.

**Stopped user containers.** The gateway puts idle user containers (B) to sleep. A stopped B would keep the old image and later be
woken with old code, so `server` starts every stopped B after the image checks and swaps it like the others. A B that does not start
stays stopped and unswapped (a warning; the rest goes on). A B in another state (restarting, paused, dead) is named and not touched.

**Inner containers.** Their names are recorded before the swap and started again afterwards with `docker start` (most have no restart
policy). Project containers are not started by the deploy: the backend restores them itself after its start, in dependency order.
Old containers taken over by a relocation are never restarted.

**After the swap**

- Per container: image digest, tree hash of `electron/server`, `/api/health`, `/api/runs/active`, host port.
- Then a **post-observation** (`--settle`, default 150 s), because the gateway may replace the freshly created container within
  seconds (with `RestartCount` 0, so it does not look like a restart). If that happens the inner containers are restored again.
  If another target follows (`client` in `all`), the observation runs in the background and "Done" waits for it; its result is
  reported even when a later target fails.
- Client: running, `main.js` in the bundle, shell, icon and asset catalog, Electron version. Every row counts in the verdict.
- At the end the tool prints the rollback commands and reminds you to run `./deploy status` again after a few minutes.

## The cleanup-cron guard

If the host runs a daily docker cleanup that removes unused images and stopped containers (it would also remove a candidate image
and a container in the middle of a swap), set its UTC hour as `remote.cleanupCronUtcHour` in `deploy.local.json` (or
`CBASE_CLEANUP_CRON_UTC_HOUR`). `server`, `all` and `rollback server` then abort before the gate (or before the rollback) when the run
would span that hour. Without the setting there is no guard. The end is computed from an assumed duration of 45 minutes, not measured; the message says so.
Only `--cron-window-ignore` bypasses it (a warning in the table); `--yes` and `--force` do not. A dry run shows a red row instead of
aborting.

## Rollback

```sh
./deploy rollback server              # to the release that was active before current
./deploy rollback server --to <id>    # to a specific release
./deploy rollback client              # the previous client bundle (--to <backup> for another)
```

**Server.** Without `--to` the target is the release that was active *before* `current`, read from the activation history
(`activations`, see "Server layout"), never "the newest release in stock": `web` and failed server deploys create releases that were
never active. A rollback takes back the topmost activation; a second one goes further back, never forward. If the predecessor is
unknown (no history, `current` moved by hand), the rollback refuses and asks for `--to`.

The swap uses the candidate image that was checked back then; no rebuild. If that image is unreadable the rollback aborts instead of
rebuilding. Only a `--to` further back than the kept candidates rebuilds from the release tree, and that image skips the image checks
of a deploy. The swap is the same as in a deploy (including the race with the gateway); only afterwards are `:latest` and `current`
repointed, and the UI comes from the release snapshot. If a container does not become healthy, the others still get their inner
containers and the project box, and the error follows after.

If the target image predates the separate login directory, the rollback copies the stored Claude login back into the place the old
image expects, through a throwaway container on the home volume (a rollback is often needed when B does not run). If that is not
possible the rollback aborts before removing the container; `--force` bypasses and the verdict carries a red row.

**Client.** Each deploy moves the replaced bundle to `~/Library/Application Support/cbase/deploy-backups/` as
`cbase Client.app.previous-<release>`; the last three are kept.

**Limit:** a rollback restores code, not data. The user volume stays as it is, and database migrations do not run backwards. If a
migration changed the schema, the old code may not work with it.

### Rollback lock

`server/backend/capabilities.json` lists what a release knows. A rollback to a release that lacks a capability would lose state it
cannot read, so `rollback server` checks each user container before rebuilding an image, after the idle gate, and again right before
each swap:

| Axis | Capability | Count read from the container | Switch for an unknown count |
|---|---|---|---|
| relocation | `relocation` | converted projects, open relocations | `--rollback-without-relocation` |
| stack copies | `copy`, `copy-clear-away`, `copy-move-in` | live copies | `--rollback-without-copy` |
| episodes per workspace | `episodes-per-workspace` | source ids with episodes in two workspaces | `--rollback-without-episodes` |
| git-lfs in the project box | `lfs` | none (always unknown) | `--rollback-without-lfs` |
| layout | `layout` | layouts under rebuild | `--rollback-without-layout` |
| stopped instances | `instance-stopped` | stopped instances, stops in progress | `--rollback-without-instance-stopped` |
| bridge prefix `cbp-` | `bridge-cbp` | converted projects | `--rollback-without-bridge-cbp` |

- A **known** count above 0 locks, and nothing bypasses it, not even `--force`. The way out is to repair forward, to roll back to a
  release that knows the capability, or to clear the state (for example start the stopped instances first).
- An **unknown** count (container stopped, backend silent, field missing) is first read from the database in the home volume through
  a read-only throwaway container. If it stays unknown, only the axis' own switch bypasses it; with the switch you assert that the
  state does not exist there.
- A missing `capabilities.json` means the release knows nothing.
- `./deploy status` shows the matching rows per container.

## What `status` answers

Above all one question: **does anything run somewhere that is newer than the working tree?** A deploy from `main` would silently
remove it. `status` compares hashes, not timestamps:

- Git: branch, uncommitted changes, unpushed commits, commits that exist only on other branches, the pre-push hook.
- Working tree ↔ installed client bundle ↔ `current/` on the server ↔ running containers ↔ `web-out`.
- The client runtime: "Electron in bundle == node_modules" (the tree hash does not see a pure Electron jump).
- The pinned Claude Code and Codex versions in the image (read from the Dockerfile) and, with the private part, whether the
  baseline for the Claude pin is up to date. The version inside the running containers is not shown; check it with
  `docker exec <container> claude --version` in every user container.
- The build: of the working tree, in `current/` and in `web-out/` (their `build.json`). Which backend a user container runs is the row
  "electron/server in container" (tree hash against the working tree) — the backend itself knows no build id.
- Per user container: runs, background agents, dynamic workflows, project instances, setups, copies, project box state, network
  separation, inner containers; stopped user containers; whether the gateway code on the host deviates.
- iOS: reachable devices with transport (cable or Wi-Fi) and the latest archive.

## Server layout

```
/srv/cbase-server/
  current -> releases/<id>/    symlink to the live release
  activations                  one release per line that carried current, newest last (read by rollback server)
  releases/<id>/build.json     the build stamp of the release (read by the gateway through current/)
  releases/<id>/backend/       complete docker build context (without build.json)
  releases/<id>/gateway/       snapshot
  releases/<id>/web-out/       snapshot (for rollback)
  web-out/                     served by the gateway, read fresh from disk on every request
  gateway/                     the gateway code (systemd user unit cbase-gateway.service)
  data/  secrets/  backups/
```

The last five releases stay. Of the candidate images, `current` and the three most recent activations are always kept, plus the two
youngest others. If the activation history cannot be read, nothing is pruned.

**Gateway.** It is touched only with `--gateway`, and restarted with
`XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart cbase-gateway.service`, never with `kill` + `nohup` (two gateways would
fight over the port). Without a unit the tool falls back to restarting the process with the environment taken from the running one.
A gateway restart breaks open SSE streams.

## `mobile`

```sh
node tools/deploy/deploy.mjs mobile --device       # to the connected iPhone (default)
node tools/deploy/deploy.mjs mobile --testflight   # upload to App Store Connect
node tools/deploy/deploy.mjs mobile --ipa          # build an .ipa only
```

The modes call `mobile/refresh-on-iphone.command`, `mobile/deploy-testflight.command` and `mobile/make-ipa.command`. The tool
enforces the right user context: Xcode accounts, keychain certificates and provisioning data are per user, and `xcodebuild` as
`root` reports "No Accounts" although everything looks right in Xcode. It runs as the desktop user from the configuration. Only
`--testflight` needs an Apple account in Xcode; `--device` and `--ipa` sign with the local identity. Never put a server address or
credentials into the app, the scheme or the repository.

**Store builds are releases.** `--testflight` and `--ipa` refuse unless the working tree is clean and `HEAD` is exactly at the tag
`v<version>`; there is no `--force` for this check (`tools/deploy/lib/build-stamp.mjs`). `--device` is always allowed. The build
number is computed, never committed: `node tools/version.mjs ios-build` (100 plus the commits on `HEAD`), passed to `xcodebuild` as
`CURRENT_PROJECT_VERSION`; the export does not let App Store Connect renumber it, and the archive is named
`cbase-<version>-<build>.xcarchive`. The desktop client gets the same number as electron-builder `buildVersion`.

### `mobile --tests`: the full XCUITest run

```sh
node tools/deploy/deploy.mjs mobile --tests                                                 # all classes except the live walkthrough
node tools/deploy/deploy.mjs mobile --tests --only CbaseMobileUITests/ShellUITests/testX --runs 5
node tools/deploy/deploy.mjs mobile --tests --only CbaseMobileUITests/ChatStageUITests     # a whole class
node tools/deploy/deploy.mjs mobile --tests --wait 1200                                     # wait longer for idle
node tools/deploy/deploy.mjs mobile --tests --wait 60 --force                               # bypass the load gate after 60 s
node tools/deploy/deploy.mjs mobile --tests --dry-run                                       # show every command, start nothing
```

This target rolls nothing out: no gate (the backend suite and the simulator do not get along on one machine), no branch rule
(bisect worktrees may measure). It belongs to the desktop user; as `root` it aborts. The steps, each one a command that `--dry-run`
shows:

1. **Port 17718.** If it is taken, a foreign process (often a fixture from another session) holds it. Abort with PID and command
   line; the tool kills nothing.
2. **Fixture.** `node mobile/test-fixtures/chat-gateway.mjs` as a child process, waited for until it prints
   `CBASE_MOBILE_FIXTURE_READY 17718`, and always ended at the end, also after an error. A fresh fixture also means its sticky
   counter-probe switches are reset; if you run by hand against a fixture that is already up, check
   `GET /fixture/waiting-agent-counter-probe` first.
3. **Simulator.** Device from `mobile.simulator` (exact name or UDID; default "iPhone 17"). The tool checks the hardware keyboard
   setting **of that device** first: Simulator.app stores "Connect Hardware Keyboard" per device
   (`DevicePreferences.<UDID>.ConnectHardwareKeyboard` in `com.apple.iphonesimulator`; the global key is only the default). Unless
   the device value is explicitly `false`, the tool quits Simulator.app, writes `false` for the device and the default through
   `defaults export` → `plutil` → `defaults import`, and opens it again. Then `open -a Simulator` (before booting: without the running
   app, xcodebuild boots with the hardware keyboard attached), `simctl boot` if needed, `simctl bootstatus -b`. A device booted less
   than four minutes ago has no software keyboard yet; expect the warm-up test to retry. `open -a Simulator --args …` passes nothing
   to an app that already runs; the device comes from `-destination`.
4. **Delete persisted composer drafts** in the plist of the app's **data container** (`simctl get_app_container <udid> <bundle>
   data`, then `simctl spawn <udid> defaults read|delete "<path>/Library/Preferences/<bundle>.plist" <key>` for each key with the
   prefix `cbase.mobile.draft:`), then read back. Not `defaults read <bundle>`: that is the simulator's user domain, where no draft
   lives. If the app is not installed, the log says so as a reason, not as a success. A dry run deletes nothing and says
   "nothing deleted (N found)".
5. **Load gate.** 1-minute load below 3 and no foreign build processes: `next dev` / `next-server`, any `xcodebuild`, `mds_stores`
   above 100 % CPU. The tool waits up to `--wait` (default 600 s), then aborts with a table, or with `--force` bypasses the gate and
   records it: the measured load appears in the table and the JSON, and the final table says the gate was bypassed. `--force` takes
   effect only after the full wait. It never bypasses a running `xcodebuild` (two builds on one machine are what the gate exists to
   prevent); there only waiting helps. `next dev` has no CPU threshold, so an idle dev server of another project blocks as much as a
   busy one; `--force` is the way out.
6. **`build-for-testing`** into its own DerivedData (`CbaseMobile-UITests`), separate from hand builds and the device build.
7. **Expectation** from `-enumerate-tests -test-enumeration-style flat`: all identifiers minus the live walkthrough
   (`CbaseMobileUITests/CbaseMobileUITests/testFullCategorySweepAgainstLiveGateway`); with `--only` exactly the named ones. An
   unknown `--only` identifier aborts here. The same identifier named twice counts once; a class identifier expands to its tests.
8. **Warm-up test** `AAAWarmupUITests/testKeyboardAppears` on its own: opens the fixture chat, taps the composer, waits up to 60 s for
   a keyboard inside the screen. Passed means it is in the passed list; a skipped warm-up is not a keyboard. Not passed: retry after
   10 s, up to 5 minutes, but a new attempt starts only if the remaining time can carry it (≥ 120 s). Not run at all (Executed 0):
   abort at once. After each red attempt the tool reads the device log for `_hardwareKeyboardAvailable = YES` and the stored
   preference; if either saw a hardware keyboard, it resets Simulator.app once per run.
9. **Run** `test-without-building` with `-skip-testing:<live walkthrough>` (or `-only-testing:` per `--only`), `--runs N` times.
   Progress per test on the console.
10. **Verdict.** `Executed N tests` of the outer suite against the expectation, red list, skips with reasons, duration per test.
    A deviation, a red test or a disallowed skip means **exit 1, also with `TEST EXECUTE SUCCEEDED`**: an `-only-testing` on a path
    that does not exist reports SUCCEEDED with zero tests. Skipped tests do not count as green (if the fixture dies, every test
    skips). Allowed in a full run are only the five diagnostic skips listed in `DIAGNOSTIC_SKIPS` (`tools/check/lib/uitests.mjs`).
    With `--only`, no skip of an explicitly named test is allowed; a class identifier brings its diagnostic skips along.

**Logs:** `.deploy-logs/uitests-<stamp>.log` (the full xcodebuild output of all steps) and `uitests-<stamp>[-rN].json` (executed,
expected, red tests, skips with reasons, duration per test, load before and after, boot age, fixture PID, warm-up, drafts, exit code,
the xcresult path). Exit `0` only if every run has Executed == expected, nothing red and no disallowed skip. A run that aborts before
the first xcodebuild (port taken, load gate without `--force`) leaves only `uitests-<stamp>-fixture.log`; its reason is in
`<stamp>-mobile.log`.

The verdicts are pure functions in `tools/check/lib/uitests.mjs`, each with a green and a red case in `tools/check/uitests.test.mjs`.
The probes (`uptime`, `ps`) run with `LC_ALL=C`; a localized macOS writes decimal commas and localized dates the parsers would not
read.

## Limits

- Desktop builds are macOS/arm64 only. The bundles are signed with an "Apple Development" identity (hardened runtime) without a
  secure timestamp (`codesign -dv` shows `Signed Time=` instead of `Timestamp=`), so notarization and distribution are out. The
  identity stays the same on purpose: the macOS privacy approvals (TCC) hang on its designated requirement and would be lost with
  ad hoc signing on every deploy.
- There is no lock against two parallel deploys.
- The gate lock has no kernel lock (Node has no `flock`): two new gates that clear the same dead lock at the same instant can both
  pass. It holds only gates that know it; a bare `node --test` ignores it. The load counts only what ran at the gate start.
- `mobile --tests` measures only in the simulator. There is no real lock against a second run, but in practice the second one stops
  at step 1 once the first fixture listens on 17718, and the load gate sees a foreign `xcodebuild`. Not seen: a second run that
  starts later, or one whose fixture does not listen yet.
