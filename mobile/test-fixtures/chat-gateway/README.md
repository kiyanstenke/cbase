# `mobile/test-fixtures/chat-gateway/` — the fixture gateway of the iOS tests

The entry point is `../chat-gateway.mjs` (port 17718, prints `CBASE_MOBILE_FIXTURE_READY`). It owns the HTTP server, the router order
(`ROUTERS`, first match wins), the 404 and the shutdown. State, seeds and the routers live here. The fixture speaks the backend's wire
contract closely enough for the UI tests; **a fixture that mirrors the contract wrongly tests its own invention** — copy values from the
real catalogs instead of choosing them.

All state lives in one object, `S` (`state.mjs`): every file reads AND reassigns `S.x` (an imported ESM binding could not be reassigned).
Because a never-assigned `S.x` reads as `undefined` instead of throwing, the module order in `state.mjs` is meaningful (`extraChats` reads
`S.chat` immediately).

| File | What |
|---|---|
| `state.mjs` | ids (`workspaceId`, `chatId`, `projectId` …), `export const S = {}` with every state field, containers (`extraChats`, `chatStreams`, `browserState`, `terminalState`), tables, seed functions, format helpers (`json`, `event`, `chatEvent`, `globalEvent`, `body`, `schedule`, `clearRun`, `publicQueue`), the archive helpers (`archiveEmpty`, `archivePage`, `matchesArchive`, `withArchive`, `finalSet`, `archiveOpen`), the git seed (`gitTree`, `gitGraph`, `gitCommitPart`, `gitViewRows`, `gitViewResponse`), and **`NEXT`** |
| `showcase.mjs` | the opt-in **showcase mode** for the App Store screenshots (`ScreenshotUITests`): only with `CBASE_FIXTURE_SHOWCASE=1` at startup. `applyShowcase()` rewrites the seed in place once (workspace "Demo", project "storefront", six English chat titles, the history of the main chat with tool rows, a code block, a table and an open approval card, the code-tab files), and `routesShowcase` — FIRST in `ROUTERS`, `NEXT` when the mode is off — answers account, usage rings and the project's git (tree, graph, commit files, diffs). Without the variable the default data stays exactly as the UI tests expect it; do not run UI tests against a showcase fixture |
| `seeds.mjs` | the histories (`seededHistory`, `MARKDOWN_SHOWCASE`, `mainHistory`), `startFixtureRun` (the run simulation with its `schedule` closures), the workflow marker/approval histories and `dynTreeSeed` |
| `routes-settings.mjs` | gateway info (the server's version and API range, variant picked by `POST /fixture/server-api { variant: "current" \| "old" \| "newer" \| "older", build? }`, reset by `reset-run`; `GET /fixture/client` returns the `X-Cbase-Client` and `User-Agent` of the app's last request, recorded by `recordClient` in the entry), account self-deletion (`POST /gw/account/delete`, answer picked by `POST /fixture/account-delete { mode: "202" \| "403" \| "409" }`, reset by `reset-run`), push, `/gw/host`, adjust, autocompact, TTS, web search, permission rules, auto-continue, credit gate, hooks, GitLab accounts, notify, env, logout, health, agent models and default effort, dynamic-workflow cap/size, and the administration (`routesAdministration`: users, resources, password, start/restart/stop) |
| `routes-usage.mjs` | providers and usage: `GET /api/usage/*` in the shapes of the usage contract, `GET/PUT/DELETE /api/openrouter`, `PUT /api/default-model`, OpenRouter prices, the `POST /fixture/openrouter` switch |
| `routes-scheduled.mjs` | scheduled jobs (`/api/workspaces/:ws/scheduled`, run, runs) and the job chats under `/api/chats/<id>`; own state, reset through `resetScheduled`; seed switch `POST /fixture/scheduled` |
| `routes-fixture.mjs` | `/fixture/state`, the seed switches (channel, approval, history, services, second workspace, foreign pinned chat), the code tab (files tree/read/download/upload), one-shot switches (subagent, background agent, waiting agent, ask, open call, group tools, native tasks), the archive switches (`/fixture/archive`), the reconciliation switches (`gap`, `row`, `run-stream`, `stream-silent`, `stream-abort`, `stream-flapping`, `image`, `reconcile`), the dynamic/graph workflow switches, and **`/fixture/reset-run`** (`launchApp` calls it before EVERY test) |
| `routes-workspace.mjs` | overview, workflows, vars, skills (routes of the skills contract, `/fixture/pages-skills`), project workflows, chat workflows/skills, the dynamic-workflow library |
| `routes-run.mjs` | review-wait, limit-wait, auto-continue, workflow run, background agents (`agent-after-run`, stop, background), services/events, `/fixture/notice`, project services and resources, port conflicts |
| `routes-git.mjs` | git (stage/unstage/commit/diff, then the `startsWith(git/)` catch-all), `/fixture/git`, the git overview behind the `POST /fixture/gitView` switch, the graph (`git/log`, `git/show`) |
| `routes-devtools.mjs` | `/fixture/settings` (read-out and reset), `GET /fixture/settings-ordering` (read from `web/src/components/settings/SettingsModal.tsx` on every request), `/fixture/gitlab`, browser, terminal (stream like the server: `id:`/`until`, resume via `Last-Event-ID` or `?from=`) |
| `routes-chat.mjs` | usage, providers (`caps` and `efforts` like the server, a third provider without effort), chat folders (archive, context, permanent delete), artifacts, `/api/chats`, `/api/events`, the main chat (GET/PATCH/DELETE, log, log/delta, stream, message, queue, control, stop, compact, attachments, agenda), dynamic and graph workflow routes, channels, the chat archive, and the catch-all over the extra chats |

**Router contract** (same as the backend dispatcher, `server/backend/electron/server/server.js`): every routes file exports
`async function routes<X>(ctx)`, its first line is `const { req, res, url, path, method } = ctx;`, its last line is `return NEXT;`.
Any other return value (also `undefined` from `json(res, …)`) means "answered"; only the `NEXT` symbol means "continue". Order matters in
two places: `startsWith(git/)` sits behind `git/stage`, `git/unstage`, `git/commit`, `git/diff` (all in `routes-git.mjs`), and the catch-all
over `extraChats` is the end of `routes-chat.mjs`, which is the last router.

**Where do new things go?**

- *A new route* — into the `routes-*.mjs` of its path area, as `if (path … && method …) {…}` with `return json(res, …)` (or `return;` after
  an SSE `res.write`); in `routes-chat.mjs` BEFORE the catch-alls, in `routes-git.mjs` BEFORE the `startsWith(git/)` catch-all. A new path area
  is a new file plus a line in `ROUTERS` (`../chat-gateway.mjs`) before `routesChat`.
- *New state or a test switch* — state as `S.x = …` in `state.mjs` (at its place in the order, not at the end, if a seed call writes to it),
  reset in `resetSettings` or `/fixture/reset-run` (`routes-fixture.mjs`); the switch itself as a `/fixture/<name>` route in
  `routes-fixture.mjs`; one-shot switches are consumed at the start of a run in `startFixtureRun` (`seeds.mjs`). Exception on purpose: a
  counter-probe toggle that no test sets and `reset-run` therefore does NOT clear (`/fixture/waiting-agent-counter-probe`; set from outside
  with curl, reverted with `{}`).
- *Why does a test see its predecessor's history?* — `reset-run` clears run, queue, one-shot switches and the seed, NOT `/fixture/history`
  (`S.seededHistoryCount` and others); whoever needs a specific length seeds it (`setFixtureHistory` in `CbaseUITestBase.swift`).

**Bound to the server:** `agendaTreeOf` (in `routes-chat.mjs`, switch `POST /fixture/agenda { tree: true }`) is exported and compared by
`server/backend/test/agenda.test.js` with the server's own computation of the same tree — change the tree before the computation, not the
other way round. `archivePage` is the server's, word for word (only a MISSING parameter means "without", `?archive=` is 400), and
`web/test/ios-archive.test.mjs` binds it. The fixture deliberately does NOT mirror: a write lock on archived chats (messages and `PATCH` on
an archived chat do not answer 409), `not_archivable`, and the extra sentence of the folder 409 from `chats/routes.js:folderLockSet`;
`contextFiles` is always a number, never `null`.

**Not here:** the tests (`../../CbaseMobileUITests/`), the app (`../../CbaseMobile/`), the web DOM probes (run by hand in a real browser against a real server).
A formatter breaks the layout of the routes bodies (4 spaces inside a function with a 2-space shell, like the backend). There is no
`package.json`: `.mjs` is ESM, imports carry the full extension.
