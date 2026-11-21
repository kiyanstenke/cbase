# `server/backend/test/` — the backend suite

The gate's glob is **`server/backend/test/*.test.js`**, run as `node --test` with shortened limit deadlines
(`tools/check/targets/check.mjs`). The `.mjs` files next to the tests are **harnesses, not tests**: they are imported, never run.

```sh
./check                      # the right way - ALWAYS in the background (> 10 min)
CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 \
CBASE_AGENT_STALL_MS=3600000 CBASE_EMBED_OFFLINE=1 CBASE_UI_LANG=de CBASE_OPENROUTER_OFFLINE=1 CBASE_DYNWF_SECTION_MS=5000 \
CBASE_DYNWF_RUN_CAP=16 CBASE_DYNWF_USER_CAP=8 CBASE_DYNWF_STAGGER_MS=0 CBASE_DYNWF_STALL_MS=3600000 \
CBASE_MAIN_AGENT_WAIT_MS=3600000 \
  node --test --test-reporter=tap server/backend/test/channel.test.js   # one file alone, with the gate's knobs
```

Never run a bare `node --test` over the whole folder: more than a hundred files, each with a real server and fake-CLI children,
give changing failures on a busy machine.

What the knobs do:

- Without the shortened limit deadlines every test that goes through the auto-continue path waits 45 s of real wall clock.
- `CBASE_AGENT_STALL_MS` points the OPPOSITE way (production 600 s, gate one hour): a fake subagent at a gate shows no progress and
  would otherwise be aborted by the stall watchdog under load (`agent-stall.test.js` sets it itself).
- The five `CBASE_DYNWF_*` knobs (values from `check.mjs:fastDeadlines`): time limit per section of a workflow script 5 s
  (production 30 s), the two concurrency caps fixed at 16/8, the stagger at 0, the stall of workflow agents like that of subagents
  at one hour. The tests for concurrency, stagger and stall set their values themselves.
- `CBASE_MAIN_AGENT_WAIT_MS` also points the opposite way: in production the main agent never waits for a subagent (default 0), in
  the gate up to an hour, because most agent tests fetch the report in the call; `main-agent-waiting-never.test.js` removes the
  knob and measures the product.
- `CBASE_OPENROUTER_OFFLINE=1`: a test process with its own data folder would otherwise fetch the whole catalog from openrouter.ai
  at every server start. `CBASE_EMBED_OFFLINE=1` likewise keeps a process with its own HOME from loading the embedding model.

## What lives here

| | |
|---|---|
| **Server tests** | The normal case: `withServer(...)` starts a real backend process on a free port, with a fake CLI in front of it. Measured over HTTP and over the store, not over internals. |
| **Units without server** | Pure computations and source-text guards: `import-direction.test.js`, `dispatcher.test.js`, `store-facade.test.js`, `code-scopes.test.js`, `mcp-catalog.test.js` (snapshot - holds only the tool NAMES), `mcp-schema.test.js` (the enumerations of the cbase tools against their sources), `preset-wire.test.js` (which effort level goes out as which field), `native-orchestrator.test.js` (native orchestration tools blocked in every run), `ultracode-rule.test.js` (the ONE ultracode rule, case by case, plus a source guard over every `updateChat`/`createChat` that touches level, model, provider or mode), `browser-flow-control.test.js` (the adaptive ack window of the screencast against a fake viewer with a set clock - a count under simulated latency, not a measurement of the machine). |
| **Harnesses** | See below. |
| **Fixtures** | `fixtures/golden/<scenario>/{sse,db,spawn,hooks}`, `fixtures/code-scopes/responses.json`, `fixtures/fake-code-cli.mjs`, `fixtures/clone-check/cases.json` (the ONE rule of the clone address for server, web and iOS), `fixtures/dynworkflows*/<pin>/` (see "Re-recording anchors"). |
| **Real Chromium** | `captures-e2e.test.js`, `browser-last-tab.test.js`, `browser-agent-choice.test.js`. Skipped only where `resolveChromium()` finds nothing; a skip is red in the gate. |

### Harnesses

- `server-harness.mjs` - fake CLI, `withServer`, builders, `withMcp`.
- `agent-harness.mjs` - `withAgentsServer` on a free REAL port with the real cbase MCP server; `fakeClaude({ main, sub })` calls MCP
  tools through the real configuration of its run; `fakeCodex`; a fake preset endpoint `opts.engine` (the built-in OpenRouter on
  that endpoint, answering `/models`, `/key`, `/generation` and `/models/<id>/endpoints` with catalog `HARNESS_CATALOG` and a
  reported amount per answer); waiting for events without deadline, gates instead of durations, `restart()` on the same data folder
  and port, a `finally` that cleans up the process tree without overwriting the body's error; the fake Claude reads stdin
  SERIALLY like the real CLI (a line in the middle of a turn becomes the next turn); `oneshot` for one-off calls; `opts.childProcess` runs
  the server as a process of its own (`agent-server-child.mjs`) with `crash()` (SIGKILL, restart on the same data folder) and `db()`;
  `projectWithoutInstance({ name, path })` creates a project without an instance row; `wakeParked()` (only with `opts.childProcess`).
  Its own proof is `agent-harness.test.js`; the files that run on it name themselves in its header under "USED BY".
- `dynworkflows-harness.mjs` - the sandbox seam without server (`fakeHost({ auto, workflows })` records every `agent()` call and
  releases it when the test says so); started as a process of its own it also runs the prohibition probes, an unhandled rejection
  of a script's own promise, and the late reply after the script's end.
- `golden-harness.mjs` + `golden-scenarios.mjs` - the equality proof of a run (see "Golden suite").
- `ripcord.mjs` - the ONE emergency brake of the fake CLIs (120 s, `unref()`).
- `quiet.mjs` - the harness core: `waitForQuiet(base)` waits without deadline until `/api/runs/active` reports `quiet: true`;
  `streamBarrier(reader, target)` puts a marker `{type:"harness", subtype:"barrier"}` into the same stream and waits until the
  reader has it; `GLOBAL` for the global stream; exposed in the harnesses as `ctx.waitForQuiet`/`ctx.barrier`.
- `jsonl.mjs` - `readJsonl`: only completed lines of a log that is still being written.
- `process-group.mjs` - `groupAlive(pgid)` and `processAlive(pid)`; alive means "exists and is not a zombie".
- `fake-docker.mjs` (+ `fake-docker-copy-view.mjs`, `fake-docker-stat.mjs`) - a fake docker with gates (`waitAtGate`, exit 9 with a
  line when the brake fires), `inspect` states, volumes with local folders, label inheritance from images, copy view of overlays,
  health checks, `pause`/`unpause`; `fake-compose-env.mjs`, `fake-proc.mjs`, `fake-lfs.mjs`, `fake-lsp.mjs` fake the neighbours.
- `projectbox-scenario.mjs` - the scenario of a project creation over the fake docker (own project, home, root with network marker
  and routes, "inside" of the container); `withOps` sets the markers ONLY around the call.
- `setup-harness.mjs` - `withCreation` over `projectbox-scenario.mjs` with fake docker, git and python3, held at markers
  (`hold-`/`waiting-`/`continue-`) so a state BETWEEN two steps of the setup is reachable without a duration.
- `stacks-copy-harness.mjs` - ONE copy `k1` through the real sequence up to `ready` (`withCopy`, `buildCopy`); the "agent" works via
  `inCopy`/`gitCopy`/`writeInCopy`.
- `fence-seam.mjs` - `mcpApiCalls(mcpDir)` and `toolCalls(mcpDir)` read every `api(` call of the MCP tools and expand the path to
  concrete paths (used by the fence seam guards); an unknown form throws.
- `openrouter-spy.mjs` - replaces the built-in OpenRouter for a test without server.
- `managing-old-seed.mjs`, `gaps-model.mjs`, `projectbox-git-scenario.mjs` - seeding of an old store, gap model, scenario of the
  administration git (see "Re-recording anchors").

### Families

- **Archive:** `archive-store.test.js` (without server: column `archived_at` on fresh and old databases, the folder-rule triggers
  over a second raw connection, the store functions) and `archive.test.js` (routes, open work reason by reason, folders, the write
  lock as a request matrix including the second check AFTER the body via `Expect: 100-continue`, the event, MCP). Both check the
  invariant (active chats in archived folders = 0) over a raw connection after EVERY test.
- **Project setup** (`setup-harness.mjs`): `project-setup`, `project-setup-findings` (each finding with its counter-test in the
  header; one over the REAL gateway via `server/gateway/gateway-harness.mjs`), the setup case in `project-detection`.
- **Clone of a source:** `project-clone.test.js` puts a git shell in front (log per call, redirection of https addresses to local bare
  repos - `protocol.file.allow` only while a redirection stands) and a fake `git-lfs`; `clone-check.test.js` runs every case of
  `fixtures/clone-check/cases.json` against `checkCloneDetail` with a built-in sabotage - a new case belongs in the fixture, which the
  test never changes.
- **Layout of existing projects:** `layout-check`, `layout-quiet`, `layout-procedure` (a whole existing project, write lock, restart
  before and after the switch-over, fault after the switch-over). A halt in the middle: the fake docker's `stopGate` or the fake
  git's `gitHold`.
- **Providers and usage:** `only-three-provider`, `provider-migration`, `openrouter-catalog`, `once-consumption`, `usage-routes`,
  `abort-booking`, `crash-late-booking`, `default-model`.
- **Effort levels:** `effort-core`, `effort-validation`, `auto-gone`, `oneshot-level`, `default-level-inherit`, `ultra-gone`.
- **Dynamic workflows:** the sandbox seam `dynworkflows-sandbox` (scripts against a fake agent host without server), `dynworkflows-cap`,
  `dynworkflows-journal` (the key chain against a REAL Claude Code journal); everything else runs on the main seam of the agent
  harness, one file per topic (`dynworkflows-library`, `-run`, `-agents`, `-stop`, `-approval`, `-resume`, `-concurrency`,
  `-structured`, `-budget`, `-size`, `-call`, `-limits`, `-agent-type`, `-tree`, `-reminder`, `-slash`, `-interventions`,
  `graph-dynworkflow`). A running dynamic workflow is NOT in `busy` but in its own field of `/api/runs/active` (`active-runs.test.js`).
- **Subagents that outlive the turn:** `parent-id`, `output-location`, `agent-stop`, `agent-limit-parking`, `agent-lifetime`,
  `agent-foreground`, `agent-cap`, `agent-depth`, `agents-types`, `agent-readjust`, `agent-orphaned` (with `opts.childProcess` and `crash()`),
  `agent-stall` (counting clock via `advanceStallClock`, no wall clock), `agent-parent-chain` and more, mostly on the agent harness.
- **Project containers:** `projectbox-*`, `stacks-*`, `in-project*`, `service-probe`, `project-lock`, `project-working-folder`,
  `engine-in-project`, `session-transfer`, `network-target` and the fence guards, all over the fake docker; waiting is on gates and
  markers, never on durations; every `127.0.0.1` promise is written with that address because `localhost` resolves to `::1` first
  on macOS - the instance's second loopback address.
- **Remnants of the old manager area and scheduled runs:** `manager-lock` (the read-only kind "manager"), `teardown-relocations`
  and the `scheduled-*` files; an old store is seeded through `managing-old-seed.mjs`. Appointments stand at gates of the agent
  harness, never at a clock.
- **Golden suite:** scenarios recorded from real runs, compared per scenario in `golden-runs.test.js`; ids are normalized through an
  id table, machine paths (`<node>`, `<repo>`) before it; `<duration_ms>` in the completion message is normalized too.

## Rules, each from a failure

- **A `.test.js` NEVER imports another.** Its tests would run twice. Shared code belongs in a `.mjs`.
- **An open connection belongs in `finally`.** `server.close()` waits for every SSE reader; a test that unsubscribes only on the
  success path turns the first real failure into a silent hang until the 900 s deadline. `withServer` therefore calls
  `closeAllConnections()` BEFORE `server.close()`.
- **A running child process keeps the event loop open.** In `finally`: stop runs, close connections, kill own children hard.
- **`waitFor` must THROW when the deadline expires.** Returning the last seen value reports a factual failure where only the clock
  ran out.
- **A test must not fail at cleanup** (`ENOTEMPTY` from children still writing) - catch and warn, do not throw.
- **A promise needs the path that breaks it.** A loop over a list that is empty in the run passes without measuring anything; an
  `assert.ok(list.length)` before it is the minimum, a real case is better.
- **After an in-process restart `fetch` hands out a dead socket.** `server.close` + `startServer` on the same port: the pool still
  holds the connection to the OLD server and the next request ends in `ECONNRESET`. Test helpers send `Connection: close`.
- **A guard for "children killed hard" needs a process the chat stop does NOT reach** - a long runner in its own process group that
  does not read stdin. Without it the stop already cleans everything up and the guard is green without a statement. The harness
  cleanup WAITS (`endChildrenAndWait`) until every target is gone or a zombie.
- **After `ctx.restart()` every converted instance stands on `start`** (with an operating marker `startServer` sets it BEFORE
  listening; only the post-start brings it to `ready` - and the harness switches that off). A turn in a converted project then waits
  at the lock forever and the harness's quiet never comes. `ctx.restart({ instancesReady: true })` puts them on `ready` after the
  start (in-process only).
- **Never create a project without an instance row in operation via `POST .../projects`:** with an operating marker the route creates
  the project WITH an instance row and starts its setup. The way is `ctx.projectWithoutInstance({ name, path })` of the agent
  harness (directly over the store, folder created, NO service scan; via IPC with `opts.childProcess`). Without an operating marker the route
  is still right.
- **`agentsOf(chat)` sees only the NEWEST core of a chat.** An agent outlives its turn in an older core; a test that counts via
  `agentsOf(...).rows()` goes red depending on timing. Count via `liveAgents()` (or `agentsList`), filtered by `chatId`.
- **A fake CLI that processes lines in the middle of a turn in parallel measures a different program.** The real CLI queues them;
  fakes queue stdin. The stdin behaviour is bound to a real measurement: a line that arrives AFTER the last tool boundary during the
  LAST model request of the turn becomes a turn of its own (measured against the real CLI, guard in
  `agent-harness.test.js`).
- **A git temp repo gets its configuration from the ENVIRONMENT** (`GIT_CONFIG_COUNT`, plus `core.excludesFile` and
  `core.attributesFile` on `/dev/null`) - `GIT_CONFIG_GLOBAL=/dev/null` alone does not cover those two, and a foreign machine
  colours the test (pattern: `agent-level-repo.test.js`).
- **The pid order is NOT the spawn order** (macOS wraps after 99,999). The golden harness counts at the `spawn()` call of the server
  process itself (`countSpawns`, `afterSpawnTally` - a pid without a number throws).
- **A look into the server's memory is not a look into the stream.** What `liveAgents()` already shows, the SSE reader may not have
  yet under load - a cut at `events.length` counts an old event as new. Put the cut BEHIND the stream barrier (`ctx.barrier(stream)`,
  `quiet.mjs`) and, where possible, count by CONTENT instead of position.
- **A test's aftermath is not "wait 500 ms" and not `runs === 0`.** After the turn come one-shots, un-awaited hooks, verdicts, queued
  messages - `waitForQuiet(base)` waits for the field `quiet` of `/api/runs/active` (computed in `runs/routes.js:openWork`); what
  waits on a CLOCK (waiting line at the limit, alarm, ticks) deliberately does not count there.
- **A bare pause can only become fewer.** `clock-counts.test.js` counts every pause (`await sleep(N)`, `new Promise((r) =>
  setTimeout(r, N))`) outside a wait loop - across `server/backend/test`, `web/test`, `web/test/streams` and `tools/check` -
  against `fixtures/pauses-allowed.json` (file, number, reason); new, risen, not shrunk along or without a reason is red.
- **A log that the fake CLI is still writing ends in the middle of a line.** `readJsonl` returns only completed lines; a
  `split("\n").map(JSON.parse)` throws at the half one.
- **An absence ("the tick did NOT wake") needs occasions, not a duration.** Count how often the tick has checked, then
  `waitForQuiet` - a tick that did wake would then be visible as a run row.
- **An in-process test with an unhandled rejection HANGS** instead of going red - `node:test` swallows it, the server in the test
  process lives on. Whoever wants to check that a path does NOT end the process (or does) runs the server as a process of its own
  (`opts.childProcess` + `crash()`) or the sandbox as a child (`dynworkflows-harness.mjs`).
- **Never poll the RUNNING child server with `ctx.db()` for long.** The writer waits up to 5 s (`PRAGMA busy_timeout`, guard
  `db-lock.test.js`) - but SYNCHRONOUSLY: while it waits the whole event loop of the server stands, and the test's own reading
  connection has no such value and fails at once when the server is writing. Read once, or read a copy.
- **The fake CLIs recognise a completion message by `includes("<task-notification>")` and parse script JSON up to the end of the
  text.** What the server appends to a user message (ultracode prefix, silent hint) belongs BEFORE it and must not carry the
  completion marker.
- **A SKIPPED test counts as passed for `node --test`.** `# skipped N > 0` is RED in the gate (`tools/check/lib/test-output.mjs`).
- **A project test that goes red must not leave an instance row in a working state** (`relocation`, `create`, `start`, `recreate`):
  it counts in `/api/runs/active` (`projectInstances`), and `withAgentsServer` waits for quiet at the end - without deadline, so
  forever. A halt belongs cleaned up in `finally`, a closed gate of a fake sequence opened.
- **Test doubles read prompt wordings.** `web/test/streams/fake-cli.cjs`, the fakes in `agent-harness.mjs` and single tests recognise
  roles and values by words of the prompt (`/Channel id: .../`, `"[Goal gate]"` ...). Whoever changes a text to the model greps for
  its key words in these files and updates the double, then runs the matching golden scenario
  (`node server/backend/test/golden-harness.mjs --only <name>`).

## Re-recording anchors

- **The administration-git anchor:** `fixtures/projectbox-git/argv-without-instance.json` is the log of the scenario
  `projectbox-git-scenario.mjs` (every exported function of `git.js`, argv/folder/environment features per git call) - "without an
  instance as before". Re-record only with the CURRENT `server/backend/electron/server/git.js`:
  `node server/backend/test/projectbox-git-scenario.mjs <git.js> > server/backend/test/fixtures/projectbox-git/argv-without-instance.json`.
  New steps only at the END of the scenario so that the old part stays byte-equal. `projectbox-git-worktree.test.js` runs the same
  tool without anchor: worktrees of subagents, graph workflows and the delete path in the fake project container.
- `golden-runs.test.js` and `code-scopes.test.js` rewrite their fixtures when `CBASE_GOLDEN_RECORD=1` or
  `CBASE_CODE_SCOPES_RECORD=1` is set. **Only with a READ `git diff --stat`** - on a pure move `sse`/`db`/`spawn` must never change.
  `./check` strips both switches from the child environment: a gate that writes its own anchors checks nothing.
- One anchor of the dynamic workflows hangs on the **Claude pin** (`server/backend/Dockerfile`) and is redone at every jump:
  - `fixtures/dynworkflows-journal/<pin>/` - a REAL journal of the pinned CLI:
    `node server/backend/test/fixtures/dynworkflows-journal/generate.mjs [<version>]` runs `script.js` with the CLI binary from the
    npm platform package against an API mock and writes `journal.jsonl`,
    `script.js`, `stamp.json`. Never an anonymized foreign journal - every replacement would change the hashes. The gate never
    calls the generator.

## Not here

Web tests (`web/test/*.mjs`, own README), checks in a real browser (by hand, NOT in the gate), the tests of the
deploy tool (`tools/check/*.test.mjs`), the XCUITests (`mobile/CbaseMobileUITests/`).
