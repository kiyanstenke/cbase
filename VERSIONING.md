# Versioning

This is the one place that says how cbase is versioned: what a version number promises, how a running build names itself, how
clients and servers of different ages get along, and how a release is cut. `CONTRIBUTING.md`, `CHANGELOG.md`, `DEPLOY.md` and
`tools/version.mjs` link here instead of repeating it.

## 1. One product version

cbase has **one** version for all its parts: web client, desktop client, backend, gateway and iOS app. It is written into several
files (every build system wants its own), and only `tools/version.mjs` writes them; the table `PLACES` in that file lists every one,
and the gate holds them together (`tools/check/version.test.mjs`). Never edit a version number by hand.

```sh
node tools/version.mjs                 # prints the version; fails if the files disagree
node tools/version.mjs describe        # the build id of this tree (section 2)
node tools/version.mjs ios-build       # the build number (section 9)
```

## 2. Build ids

The build id is **computed, never stored** in the repository:

| State of the tree | Build id |
|---|---|
| exactly on the tag `v0.2.0`, nothing uncommitted | `0.2.0` |
| three commits after the last `v*` tag, commit `abc1234` | `0.2.0+3.gabc1234` |
| the same with uncommitted or untracked changes | `0.2.0+3.gabc1234.dirty` |
| no `v*` tag reachable | `0.2.0+N.g…`, N counted from the first commit |
| no git (e.g. a source archive) | `0.2.0+unknown` |

`node tools/version.mjs describe --json` prints `{"version", "build", "commit", "dirty"}` (`commit` is the full hash, or `null`
without git; `dirty` is always `true` or `false`). Every deploy writes these values, together with its release id and the build
time, to a `build.json` in the release folder (`releases/<id>/build.json`, which the gateway reads through `current/`) and in the
served web UI (`web-out/build.json`); that file is never committed. It is **not** in the backend image: a stamp there would change
the image on every deploy and replace every user container even when the backend did not change. If the build id cannot be
computed, the deploy warns and writes `<version>+unknown`; a gateway without the file reports the build `unknown`. Neither ever
pretends to be a clean release.

## 3. What a version number is measured against

Semantic Versioning needs a public interface. For cbase it is:

- **the HTTP API** (`/api` of the backend and `/gw` of the gateway) as the iOS app and third-party clients use it;
- **the self-hosting surface**: installation, configuration files, environment variables, volumes and ports;
- **the database at rest**: data written by one version must be readable by the next.

Not part of it: the user interface, the tool catalogue the agents see, and the pinned provider CLI and Electron versions. They
change in any release. (The web and desktop clients load their interface from the server they talk to, so they always match it;
only the iOS app and third-party clients can drift apart from a server.)

## 4. API level

The HTTP API carries its own compatibility number, the **API level**, in one place:
`server/backend/electron/server/api-level.js` exports `API_LEVEL = { level, oldest }`.

- `level` is the newest level the server speaks, `oldest` the oldest it still serves.
- Adding a route or an optional field raises nothing.
- Removing or renaming a route or field, or making a field required, raises `level`.
- Switching an old level off raises `oldest` (section 7 says when that is allowed).
- Level 1 is exactly what the iOS app 0.2.0 uses; it is frozen.

The backend reports it at `GET /api/version` (`version`, `api`), the gateway at `GET /gw/info` (`version`, `build`, `commit`,
`release`, `api`, `gatewayVersion`). The backend knows no build id (see section 2); the build id of a rollout comes from the
gateway.

## 5. The client header

The iOS app names itself on every request:

```
X-Cbase-Client: ios/0.3.0 (131); api=1
User-Agent: CbaseMobile/0.3.0
```

The parts are the app version, the build number and the API level the app speaks. A request **without** the header counts as
API level 1 and is served. Third-party clients are welcome to send the same header with their own name.

## 6. Degrading in both directions

- **Server too new for the app** (the app's level is below the server's `oldest`): the app says that this server needs a newer
  app and links to the store. It judges this on every fresh `/gw/info` (connecting, signing in, opening Settings), not only at
  launch. The server itself refuses no client by its level.
- **Server too old for the app** (the server's `level` is below what the app would like): the app keeps working and quietly says
  that some features are unavailable.

## 7. Deprecation window

`oldest` rises no earlier than **90 days** after an app that speaks the new level is available in the store, and only after the
switch-off was announced under **"Deprecated"** in the changelog of an earlier release.

## 8. Bump rules

The number is measured against the public interface of section 3, not against how much changed. A new feature in the user
interface, a larger model catalogue or a newer pinned CLI is a patch as long as the API, the self-hosting surface and the database
stay as they were.

Before 1.0:

- **Minor** (0.x.0) when the public interface changes: a route or field of the HTTP API is added, changed or removed; the API level
  changes; the database schema changes; or the self-hosting surface changes. A break carries a `Breaking:` line in the changelog
  with the step to migrate.
- **Patch** (0.x.y) for everything else: features and changes that leave the public interface alone, fixes and security fixes.

Choosing the number is the maintainer's call; the tool does not enforce it.

From 1.0 on: **major** for a break of anything in section 3 (including raising `oldest`), **minor** for additions to it that keep
what was there (new routes, new optional fields, a new API level that keeps the old one, a backward-compatible schema change),
**patch** for everything else.

## 9. Build numbers

iOS (and desktop) build numbers are **100 + the number of commits up to HEAD** (`node tools/version.mjs ios-build`, constant
`BUILD_OFFSET`). They are filled in at build time and never committed. They grow with every commit on `main`, so the store never
sees a number twice. The tool refuses a shallow clone, whose count would be too low.

## 10. Store builds are releases

A build for TestFlight or the App Store (`./deploy mobile --testflight` or `--ipa`) is made only from a clean tree exactly on the
tag `v<version>`, with no override. A build on your own device (`--device`) can be made at any time; it carries the product
version and its build number (section 9).

## 11. What is shown where

| Where | What |
|---|---|
| `GET /gw/info` | version, build id, commit, deploy release id, API level, gateway version |
| `GET /api/version` | the backend's product version and API level |
| iOS settings | "App 0.3.0 (131)" and "Server 0.3.0+4.gabc1234 · API 1" |
| web and desktop client | "About": the server's build id (from `/gw/info`; on a server without a gateway the bare version with "build unknown"), the API level, the gateway version and, in the desktop client, the app version |
| the deploy tool's status | the build id of the working tree, of `current/` and of `web-out/` |

## 12. When a release is cut

- always before a store build;
- at once for a security fix;
- otherwise when user-visible changes are live, about weekly at most. Deploys in between are normal and carry `+N.g<sha>`.

## 13. Release procedure

1. `node tools/version.mjs release x.y.z [--commit]`. Before it writes anything it checks: branch `main`, a clean tree, HEAD equal
   to `origin/main` (when that ref exists) and a non-empty "Unreleased" section. It then writes the
   version everywhere and turns "Unreleased" in `CHANGELOG.md` into the section of the release. With `--commit` it also commits
   `Release x.y.z` and creates the annotated tag `vx.y.z` locally. It never pushes.
2. The maintainer runs the gate and pushes the commit and the tag.
3. CI (`.github/workflows/release.yml`) checks that the tag equals the version, that the tagged commit is on `main` and that the
   changelog has the section, runs the version tests, and creates a **draft** GitHub release with that section as its notes.
4. The maintainer reviews the draft and publishes it by hand.

## 14. Hotfixes

There are no release branches. A fix ships in the next release from `main`; if new features already sit on `main`, that release
is a minor one.

## 15. Separate version axes

These numbers move on their own and are not the product version:

- the **API level** (section 4);
- the **MCP protocol version**;
- the **pinned provider CLI and Electron versions**;
- the **deploy release id** (`YYYYMMDD-<epoch-ms>`), which names one rollout, not a version.

## 16. Later, if needed

Left out on purpose until there is a reason for them:

- an answer `426` from the gateway for apps below `oldest` (today the app decides itself, section 6);
- a database schema number stored in the database itself;
- version bumps enforced by the release tool (today section 8 is the maintainer's rule).

## 17. When 1.0 comes

cbase becomes 1.0 when the API level and the client header have shipped in a store build, both directions of section 6 are
tested against the test fixture, the self-hosting guide is public, and one minor release went by without an unplanned break.
