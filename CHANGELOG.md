# Changelog

All notable changes to cbase are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/); before 1.0, a minor release (0.x.0) may break compatibility.

## [Unreleased]

### Added
- Delete your own account from the iOS app (Settings → Account or Profile → Account) and the web client (Environment settings):
  `POST /gw/account/delete` re-checks the password, refuses the last admin while other users exist, and erases the account with
  both volumes in the background, retried after a restart. Settings on iOS also gets Sign out and a Version row.
- Privacy policy and support page of the iOS app as a GitHub Pages site under `docs/`; the cleanliness guard lets the
  `https://<owner>.github.io/cbase` address through, like the GitHub repository address.

### Changed
- iOS app prepared for App Store review: privacy manifest (`PrivacyInfo.xcprivacy`, no tracking, no collected data, reasons for
  every required-reason API the app uses), export-compliance and usage-description keys in `Info.plist`, iPhone-only for the
  first release, plain http only for servers on the local network, and a "Privacy policy" row in Settings → About; a gate test
  keeps the manifest and these keys in step with the sources.

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

[Unreleased]: https://github.com/kiyanstenke/cbase/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kiyanstenke/cbase/releases/tag/v0.1.0
