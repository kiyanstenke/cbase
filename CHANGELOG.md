# Changelog

All notable changes to cbase are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [Semantic Versioning](https://semver.org/) once it reaches 1.0.

## [Unreleased]

### Added
- First public release: gateway with one container per user, per-user backend (Claude Code and Codex harness), shared web UI,
  desktop client (Electron) and iOS app.

### Security
- The first-time setup needs a one-time setup token from the gateway's log (or `GW_SETUP_TOKEN`); before, whoever reached a fresh
  gateway first could create the admin account.
- VS Code Remote Tunnels start only after the user accepted the VS Code Server licence in the UI; before, cbase passed
  `--accept-server-license-terms` on the user's behalf. A tunnel that was active before this change stays off until it is accepted.
