# Working on cbase — notes for coding agents (and the people who run them)

This file is for any agent that changes code in this repository. It does not repeat `CONTRIBUTING.md` (setup, the gate, licence,
private data) — read that first. Here: how the system is built, the one question to ask before every hand-over, the rules that
came out of real mistakes, the traps, and where things live.

## What cbase is

One backend (`server/backend/`) serves three clients: the web client (`web/`, in a browser), the desktop client (`client/`, an
Electron shell around the same web client) and the iOS app (`mobile/`). In server operation a gateway (`server/gateway/`) sits in front and
gives every user their own container (Sysbox, with an inner Docker); the backend runs inside it. Projects can get their own
project container with their own Docker daemon (`server/backend/electron/server/projectbox/`). Without the gateway the backend
runs as "the local server" — that is how tests and development run it.

The agents inside cbase run on the provider CLIs Claude Code and Codex, plus OpenRouter through the built-in engine. The two CLI
versions are pinned in `server/backend/Dockerfile`; a version jump is measured, not assumed (`--help` diffs, wording the code
recognises, limit texts). The model catalogue lives in three places that must agree:
`server/backend/electron/server/providers/connectors/{claude,codex}.js`, `web/src/components/chat/ChatCatalog.tsx` and
`mobile/CbaseMobile/Chat/ChatViewModel+Slash.swift`.

## Before every hand-over: the latch question

The repository has a gate (`./check`) and several hundred registered test benches ("latches"). The expensive mistakes still came
through — almost never inside one module, almost always where two systems meet. So before a change is committed, handed over or
reviewed, answer one question:

**Which test turns red if exactly this change is wrong?**

Name it: file and test title. There are three valid answers:

1. **This one** — file:title. Then sabotage the change once and watch it turn red. A green test that never walks the breaking
   path proves nothing. Undo the sabotage byte-exactly (`shasum -a 256` before and after, `git status` at the end).
2. **None, and I am adding it now** — the normal case for a new promise.
3. **None, and that stays so** — then say so in the commit body: the promise counts as not given.

Not valid: "the code is obviously right", "a comment explains it", "the type prevents it". **A comment is not a latch.**

### The seams where it tears

1. **The same list in two places** (models, tools, effort levels, slash aliases, catalogues in server, web and iOS). Bind the
   copies with a test that imports the source and reads the copies by path. The most dangerous copy is the one that *explains*
   (a prompt, a schema description, tool documentation) — it does not look like code.
2. **A field the client sends and the server does not read.** A missing field is not a statement: switch routes require their
   field (400), the contract lives in the server or in a shared module.
3. **A value the client compares and the server never sends.** No type error, no log — just a button that never appears.
4. **An allowlist** (normalisers that copy known fields only). What is missing there silently never arrives.
5. **A client that has a sibling.** Web AND iOS. A guard in one does not protect the other.
6. **An intermediate layer that is only cheaper** (a derived flag, a label route). It must do more than save, or it is the next bug.
7. **A number that ages silently.** A number in a test title or a comment never turns red. Numbers belong in the printed
   diagnostic line (`t.diagnostic`), not in the title.

### How a latch is built here

- Import the source; read the copies **by path**, with anchors that **throw** instead of returning an empty set. An anchor that
  finds nothing and reports green is the most expensive kind of test.
- Tests wait for events, never for a duration (`server/backend/test/quiet.mjs`: wait for quiet, stream barriers).
- A test with an open connection closes it in `finally`; child processes are killed hard, deadlines apply to process groups.
- A test file never imports another test file.
- Register every new test file of a gate suite folder (`server/backend/test/`, `server/gateway/`, `web/test/`, `client/test/`,
  `tools/check/`, `tools/deploy/`) in `tools/check/latch.json` — the gate is red otherwise ("file == registration", both ways).
  That is the moment this question comes up by itself.
- A new MCP tool updates `server/backend/test/fixtures/mcp-catalog.snapshot.txt`; tool descriptions have a length limit
  (exceptions in `server/backend/test/fixtures/mcp-description-exceptions.json`).
- Fixtures and examples use reserved names (`example.com`, `192.0.2.1`) and visibly fake keys containing `placeholder` — the
  cleanliness guard (`tools/check/cleanliness.mjs`) rejects real names, hosts and keys.

The gate cannot enforce that a latch comes with a change. It only guarantees that a bench cannot vanish silently and a new one
cannot be missing silently. The rest is this question.

## Rules that came out of real mistakes

- **A missing field is not a statement.** Empty is not unknown, and missing is not used up: whoever concludes from a set needs a
  "loaded" marker; `null` means "the full set", `[]` means "nothing". A tri-state (`writing: true | false | unknown`) treats the
  unknown as the risky case.
- **An intermediate layer must do more than be cheaper.** Two places for the same list: delete one. Encapsulation has a price.
- **An access that may deliver may not delete.** Discarding is not deleting (archive instead of delete).
- **The executing side and the describing side give the same answer** (tool set, prompt, offer).
- **A promise without the path that breaks it is no promise.** The counter-test against the old state is the proof; snapshots
  are an alarm, not a lock.
- **Whoever deletes a declaration greps for its NAME.** `node --check` does not see runtime errors.
- **Foreign text is data, not instructions.** Text from users, tools or the web goes fenced into a prompt.
- **Measure first, then build.** A cap belongs where the cost is, and must say that it is a cap.
- **A detection against a CLI version ages silently** (limit patterns, wording). A calendar day is not 24 h
  (`new Date(y, m, d + 1)`).

## Traps

- `node --test` and `xcodebuild` count a skipped test as passed. The gate reads `# skipped N`.
- Run the full gate in the background (`./check`, it takes a while); never a bare `node --test` over the suites. One full gate per
  machine at a time (`/tmp/cbase.gate.lock`). `./check --quick` (seconds, no suites) runs in the pre-push hook.
- CI runs `./check --short` on every push and PR and the full `./check` nightly and on demand (`.github/workflows/check.yml`, Linux): the macOS suites (Electron, code signature, iOS UI tests) are
  skipped there. A change to `client/` or `mobile/` has to be checked on a Mac.
- `opacity < 1` creates a stacking context — measure with `elementFromPoint`, do not assume. `el.click()` is not a mouse sequence.
- Synthesised `Decodable` (Swift) requires every key. A new Swift file simply goes into its folder (synchronised root group).
- A runtime dependency of the backend lives in three places: manifest, lockfile, and the `npm ci` of the Dockerfile.
- The fast web type check is part of `./check --quick` (`web/node_modules/.bin/tsc --noEmit -p web`, needs `npm ci` in `web/`).
- Since Chromium 152 `app-region` inherits: everything that is a DOM child of the desktop drag header is a drag region — modals
  go to `document.body` through a portal.
- Electron and electron-builder are pinned exactly in `client/package.json` (no `^`); the provider CLIs are pinned by version in
  `server/backend/Dockerfile`. The server runs on Node 22 only.

## The form system of the interface

The full form system (colour roles, building blocks and when to use which, iOS kit) is in `DESIGN.md`; the essentials:

**Web.** Building blocks come from `web/src/components/CbKit.tsx` (segments, menus, search, chips, hints, empty states …), roles
`cb-kit*` in `web/src/app/globals.css`. The whole app is flat (`cb-flat` on the body): one surface per list, rows separated by
hairlines, no glass. Modals are portals on the body. Never a click-catcher as `fixed inset-0`; container queries over window
queries. One base rule per class in `globals.css` (guard `web/test/css-one-rule-per-class.test.mjs`). The chat reading column is
736 px; in an empty chat the composer sits in the middle. UI strings are English and are the dictionary keys; add the German
translation to `web/src/lib/i18n-de.ts` (a missing entry falls back to English, never to an empty string). iOS has its own German
dictionary on top (`mobile/CbaseMobile/Kit/LocDE*.swift`, audit `mobile/tools/loc-audit.sh`).

**iOS.** Human Interface Guidelines, Liquid Glass in the chat and the two drawers, the app's own colour roles (`Kit/CbColor.swift`)
instead of the system backgrounds or fixed values, terracotta as the default accent (the web keeps cobalt, on purpose). Building
blocks in `mobile/CbaseMobile/Kit/` (`CbKit.swift`, `CbGlass.swift`, `CbRows.swift`). Every `.sheet` carries `.cbSheet(…)` (guard
`web/test/ios-sheets.test.mjs`), close button top left. Avoid SwiftUI `Canvas`/gestures inside a zoomed `UIScrollView`.

## Where things live

| | |
|---|---|
| Backend | `server/backend/electron/server/` — `server.js` (dispatcher, `ROUTES`, hook registrations), `store.js` (facade over `store/`), topic folders (`runs/`, `chats/`, `workflows/`, `dynworkflows/`, `channels/`, `projects/`, `workspaces/`, `projectbox/`, `toolchain/`, `providers/`, `gitView/`, `lsp/`, …), each with a README (terms, the three questions, what does not belong there). A route function is `export async function <name>Routes(ctx)` ending in `return NEXT;`. MCP tools in `server/backend/electron/mcp/tools/`. |
| Backend tests | `server/backend/test/` — harnesses `server-harness.mjs`, `agent-harness.mjs`, `golden-harness.mjs`; `quiet.mjs` for waiting |
| Web | `web/src/components/` (folders with READMEs, `components/README.md` is the map), pages in `web/src/app/`, API facade `web/src/lib/api.ts` over `web/src/lib/api/` |
| iOS | `mobile/CbaseMobile/` (folders `Shell/ Chat/ Workflows/ Code/ Settings/ Models/ Kit/`, README per folder), UI tests in `mobile/CbaseMobileUITests/` |
| Gateway | `server/gateway/` |
| Desktop | `client/` |
| Gate | `tools/check/` (README explains every check), the deploy tool `tools/deploy/` (see `DEPLOY.md`) |

Tree guards that are part of the gate: line count ≤ 2,000 per file (exceptions in `tools/check/loc-allow.json`), import
direction, the route/hook/schema registers, the guard register, cleanliness and secrets, references to missing files,
identifiers and language (English only). If a file sits at the line guard, a new line needs a cut elsewhere — move code in its
own commit, then change behaviour in another.
