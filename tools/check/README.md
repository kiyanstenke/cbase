# `tools/check/` — the gate

`./check` is the public gate: everything that must hold before a change leaves the working tree. It touches no server, no SSH, no
device — only this repository. (The private part of a clone, when there is one, adds its own plan on top; see "Plans".) The maintainer keeps extra, non-public checks in a separate tree; contributors never need them, and the public gate is complete on its own.

```
./check --quick        # no suites: node --check, import smoke test, tree guards, line count, guard register, git diff --check
./check                # the full gate: the quick checks, then the suites
./check --short        # the quick checks and the short suites, without the long backend suite (CI on push/PR; writes no marker)
./check --recheck      # run the suites even if this exact tree was green within the last hour
./check --skip-tests   # the same as --quick
```

A full gate that ends green writes a marker (`.deploy-logs/gate-ok.json`, scope `public`) with the hash of the working tree and the
suites that ran. A repeated call on the same bytes within the hour runs only the quick checks and says why.
The pre-push hook (`.githooks/pre-push`, switch on with `git config core.hooksPath .githooks`) runs `--quick`.

## Setup the full gate needs

```
(cd web && npm ci) && (cd client && npm ci) && (cd server/backend && npm ci)   # the gateway has no dependencies
chmod +x server/backend/node_modules/node-pty/prebuilds/*/spawn-helper   # the package ships it 0644: terminal tests die with "posix_spawnp failed"
node client/node_modules/electron/install.js                              # macOS only: Electron downloads its binary on request; a test reads the real bundle
```

## Layout

| Path | What |
|---|---|
| `run.mjs` | the command line (`./check`) |
| `targets/check.mjs` | the gate itself: the rows, the verdict, the marker |
| `lib/gate-plans.mjs` | the plans: WHAT the gate runs (suites, register file, line-count exceptions, marker scope) as data |
| `lib/gate-plan.mjs`, `gate-lock.mjs`, `gate-marker.mjs`, `test-output.mjs` | widths and deadlines, the one-gate-per-machine lock, the marker, the verdict per suite |
| `lib/test-stdout-guard.mjs` | preload of every suite (`--import` in NODE_TEST): a test's plain stdout goes to stderr, so Node 22's runner never reads it as a protocol frame ("Unable to deserialize cloned data") |
| `lib/guard-register.mjs`, `latch.json` | the guard register: every test file the gate runs is registered, both directions |
| `lib/loc-gate.mjs`, `loc-allow.json` | no source file over 2,000 lines; the exceptions are named and may only shrink |
| `lib/tree-rules.mjs`, `lib/manifest-diff.mjs` | route, schema and hook registers, back-imports; the byte proof of moved code |
| `cleanliness*.{mjs,json}`, `translations.mjs` | nothing private in the public tree; the translation rules |
| `baseline/<pin>/` (maintainer-only) | the checked-in reference of the workflow tool for each pinned Claude Code version (`pinSync.json` ties them to the pin) |
| `fixtures/` | data a gate test needs from an old state that is not part of the public tree (`monolith-b686294.json`: the routes of the last monolith) |
| `lib/oldstate.mjs` | reads the recorded old files of the maintainer's private suites (absent from the public tree — public counter-tests carry fixtures of their own) |
| `*.test.mjs` | the gate's own tests and the product guards that cannot live in a product test folder |

## Plans

`check({ plan })` takes a plan. `PUBLIC_PLAN` (the default) is complete in itself: Backend, Gateway, Web, Client, Gate tool (this
folder's tests), Deploy tool (tools/deploy) and macOS. A plan names its register file(s), so the gate holds each suite against the tree in both directions: a
registered file that is gone is red, a test file that is not registered is red. A new test is one line in `latch.json`.

## Rules of this folder

- Nothing here imports anything outside `tools/check` except product code (`server/`, `web/`, `client/`, `mobile/`) —
  `public-closure.test.mjs` walks every `.mjs` here. `config-leaf.test.mjs` pins the gate's own closure.
- Old states for counter-tests are checked in, not fetched from git history (the gate also runs in a shallow clone).
- A test with a counter-proof (a sabotaged copy that must turn it red) beats a test without one.
