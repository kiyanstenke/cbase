# Contributing to cbase

Thanks for helping. This file covers how to build, test and send a change. If you work with a coding agent, point it at
`AGENTS.md` too: how the system is built, the question to ask before every hand-over, and the traps. If you change the interface,
read `DESIGN.md` first: colour roles, the flat form, the building blocks of the web and the iOS kit.

## Setup

The full gate needs the dependencies of every package and two setup steps that `npm ci` does not do:

```
(cd web && npm ci) && (cd client && npm ci) && (cd server/backend && npm ci)   # the gateway has no dependencies
# Linux x64: (cd server/backend && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci) — onnxruntime-node's CUDA download fails otherwise
chmod +x server/backend/node_modules/node-pty/prebuilds/*/spawn-helper   # the package ships it 0644; terminal tests fail without it
node client/node_modules/electron/install.js                              # macOS only: downloads the Electron binary a test reads
```

Server code needs Node 22.x, at least 22.13 (the gateway and the backend use `node:sqlite`). The full gate also needs:

- [gitleaks](https://github.com/gitleaks/gitleaks) on the `PATH` (`brew install gitleaks`, or a release binary on Linux): it scans the public
  tree for secrets; a missing scanner is red, not skipped.
- A Chromium that starts — Google Chrome, or any Chromium set as `CBASE_CHROMIUM=<path>` — and `ffmpeg` (`brew install ffmpeg`,
  `apt-get install ffmpeg`): the backend suite drives a real browser and records captures. A missing one turns tests into skips, and
  the gate counts an unexpected skip as red. On Ubuntu 24.04 take Google Chrome; the distribution's Chromium snapshot has no usable
  sandbox there.

The gate runs on macOS and Linux; the macOS suite (Electron, code signature) only on macOS. A full run takes about 20 minutes on a
recent multi-core Mac and about an hour on a two-core CI runner, most of it the backend suite. `tools/check/README.md` explains the
gate in detail.

## Test

```
./check --quick          # everything but the suites, a few seconds
./check                  # the full gate; start it in the background, it takes a while
git config core.hooksPath .githooks   # once per clone: the pre-push hook runs ./check --quick
```

A change is ready when `./check` is green. A new test file is registered in `tools/check/latch.json`. Prefer a test with a counter-proof,
that is a sabotaged copy that must turn it red, over a test without one. Tests wait for events, never for a duration.

## Changes

- Work on `main` or on a short-lived branch and open a pull request against `main`.
- Continuous integration (`.github/workflows/check.yml`) runs `./check --short` on Linux for every push and pull request (the backend
  suite needs about an hour on the runner's two cores), and the full `./check` every night and on demand. Run the full gate locally
  before you ask for a review.
- Note a user-visible change under "Unreleased" in `CHANGELOG.md`.
- Keep a change focused. Move code and change behavior in separate commits.
- Commit messages: a short imperative subject (about 70 characters), then a body that says why, not what.
- All code, comments, identifiers, UI text and documentation are in English (the language and identifier guards of the gate check it).
  The English UI string is the key; every new one also needs its German entry — `web/src/lib/i18n-de.ts` for the web,
  `server/backend/electron/server/i18n-de.js` for texts the backend sends, `mobile/CbaseMobile/Kit/LocDE*.swift` for iOS (the file of
  the area, e.g. `LocDEChats.swift`). A missing entry falls back to English at run time, but the translations guard turns the gate
  red; if you cannot write German, say so in the pull request and a maintainer adds it.
- Ported third-party code carries a header naming its origin and licence and is listed in `web/public/THIRD_PARTY_NOTICES.txt`.

## Keep private data out

The gate includes a cleanliness guard (`node tools/check/cleanliness.mjs`). Do not commit real names of people, companies or customers,
credentials, tokens, device identifiers, internal host names or routable IP addresses. Use reserved example names (`example.com`,
`*.test`, `192.0.2.1`) and visibly fake keys that contain the word `placeholder`.

## Licence

By contributing you agree that your contribution is licensed under the GNU Affero General Public License, version 3 (AGPL-3.0-only,
see `LICENSE`).
Conduct in the project is governed by `CODE_OF_CONDUCT.md`; security problems go through `SECURITY.md`, not public issues.
