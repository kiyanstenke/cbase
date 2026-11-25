# Changelog

All notable changes to cbase are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/) as [VERSIONING.md](VERSIONING.md) defines it; before 1.0, a minor release
(0.x.0) may break compatibility. A switch-off is announced under "Deprecated" in an earlier release.

## [Unreleased]

## [0.3.1] - 2026-11-25

### Added

- Claude and Codex models now come from the CLIs' own account catalogs: a model the signed-in account can use appears in the
  picker with its effort levels, default level and context window without a cbase update; a model the plan may not use, a
  hidden one, or one that needs a newer CLI stays out. Without a catalog the built-in lists apply. The built-in Codex list
  gains GPT-6.2 Sol, GPT-6.2 Astra and GPT-6.1 Terra, and the `/model astra` alias now points at GPT-6.2 Astra (`astra6`
  for GPT-6 Astra).

### Changed

- The backend image ships Claude Code 2.1.332 (was 2.1.322) and Codex 0.172.0 (was 0.162.1). Every flag, lock list and
  stream shape cbase relies on was re-measured against the new binaries; the guide to dynamic workflows now says that a
  failed call also ends the replay on resume, as the reference does.
- Text that cbase hands a running Claude process without a human having typed it (a completion notice, an event, an
  agent's message or report, a scheduled continuation) is marked `isSynthetic`, so the CLI never takes it for the user's
  own words. A human follow-up stays unmarked.

## [0.3.0] - 2026-11-24

### Added

- Settings in web and desktop show the running version under About.
- The iOS app tells the server its version and API level, shows app and server version in Settings, and says clearly when a
  server needs a newer app.
- `GET /api/version` and build fields in `/gw/info` report the product version, build id and API level.
- `VERSIONING.md` describes how versions, build ids, build numbers and the API level work.

### Changed

- iOS build numbers are computed from the commit count instead of being set by App Store Connect; store builds are made only
  from a release tag.
- `./deploy`: a green gate now serves every clone on the same machine. Its marker lives in `~/.cache/cbase-gate` and is keyed by
  the working tree, the installed dependencies and the local environment, so a deploy from a separate rollout clone of the same
  commit no longer repeats the test suites. The suites no longer read the installation's `deploy.local.json`.
- The desktop app shows the cbase lens and name next to the window buttons, and every left sidebar of the iOS app starts with
  them instead of the section's name.
- In the chat's Outputs list the download button now appears in place of the size or count on hover instead of pushing it
  aside.

## [0.2.0] - 2026-11-23

### Added
- Delete your own account from the iOS app (Settings → Account or Profile → Account) and the web client (Environment settings):
  `POST /gw/account/delete` re-checks the password, refuses the last admin while other users exist, and erases the account with
  both volumes in the background, retried after a restart. Settings on iOS also gets Sign out and a Version row.
- Privacy policy and support page of the iOS app as a GitHub Pages site under `docs/`; the cleanliness guard lets the
  `https://<owner>.github.io/cbase` address through, like the GitHub repository address.
- Download from a chat's Outputs: every file and folder row gets a download link on hover, the Outputs row downloads the whole
  place, and a folder comes as a ZIP (`GET /api/chats/:id/outputs/folder`; links inside are skipped and listed in
  `_CBASE-SKIPPED.txt`). iOS offers the same ZIP in the toolbar of each folder level.

### Changed
- iOS app prepared for App Store review: privacy manifest (`PrivacyInfo.xcprivacy`, no tracking, no collected data, reasons for
  every required-reason API the app uses), export-compliance and usage-description keys in `Info.plist`, iPhone-only for the
  first release, plain http only for servers on the local network, and a "Privacy policy" row in Settings → About; a gate test
  keeps the manifest and these keys in step with the sources.
- The git bar shows its Repositories section with a single repository too (web and iOS), so the repository is always named.
- New logo: a "C" with a blue square. The app icon (iOS, desktop client, home screen, browser tab) is the dark tile; inside the
  apps the mark comes in two variants, a dark letter on light grounds and a light one on dark grounds, picked by the theme on web,
  iOS and the desktop client's connect page. `tools/icon/build-icons.mjs` writes all of them from two source images.

## [0.1.0] - 2026-11-22

### Added
- First public release: gateway with one container per user, per-user backend (Claude Code and Codex harness), shared web UI,
  desktop client (Electron) and iOS app.
- One product version for every part (packages, gateway, iOS app), checked by the gate; `node tools/version.mjs release x.y.z`
  prepares a release.
- Licensed under the GNU Affero General Public License, version 3 (AGPL-3.0-only); the settings page "Third-party notices" links
  the licence and the source code.

### Security
- The first-time setup needs a one-time setup token from the gateway's log (or `GW_SETUP_TOKEN`), so a fresh gateway cannot be
  claimed by whoever reaches it first.
- VS Code Remote Tunnels start only after the user accepted the VS Code Server licence in the UI; cbase never accepts the licence
  on the user's behalf.

[Unreleased]: https://github.com/kiyanstenke/cbase/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/kiyanstenke/cbase/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/kiyanstenke/cbase/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kiyanstenke/cbase/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kiyanstenke/cbase/releases/tag/v0.1.0
