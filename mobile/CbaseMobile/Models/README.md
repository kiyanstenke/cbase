# `CbaseMobile/Models/`: the data models of the iOS app

All models mirror the TypeScript types of the web client (`web/src/lib/api/*.ts`) and the server routes one to one. Every decoder is
tolerant: a missing or `null` field becomes a fallback instead of a decoder error (a synthesized `Decodable` would require EVERY
key), and `nil` means "not delivered", never "empty".

| File | Content |
|---|---|
| `Models.swift` | The chat models: `Project`, `Chat`, `ChatFolder`, attachments, artifacts, the log (`LogEntry`, `LogDelta`), providers (`Provider`, `ProviderModel`), `EffortLevels` (see below), the timeline rows and cards (limit, question, approval, capture, workflow), `QueuedMessage` |
| `AppState.swift` | The app state: tabs, active workspace, entered project, category, the two drawers (`DrawerFlags`), chat selection and draft, the global event stream. Categories and kinds are bound to `lib/coding-tabs.ts` by `web/test/coding-tab.test.mjs` |
| `ContextModels.swift` | Workspace overview, workspace and project context, credentials and variables, MCP servers |
| `WorkflowModels.swift` | Graph workflows (nodes/edges, runs, triggers) and the library of dynamic workflows (`DynWorkflowSummary`, `DynWorkflowEntry`) |
| `ServiceModels.swift` | Project services, resources of running services, preview links (`PreviewMode`, `PreviewLink`, `NgrokAccess`; the bodies encode `nil` EXPLICITLY as `null`; bound to `server/backend/electron/server/preview/contract.js` in `web/test/preview-binding.test.mjs`) |
| `CodeModels.swift` | Files/code, debugger, language-service diagnostics |
| `GitModels.swift` | Git, including the small overview (`GitRepo.branchesRunning`/`counter`) |
| `GitViewModels.swift` | The large Git overview: `GitViewContract` (the lists of `server/backend/electron/server/gitView/contract.js`, verbatim; bound in `web/test/git-view-binding.test.mjs`), `GitViewRow`, `GitViewResponse` (`mainBranchSupplied` tells "none detected" from "not delivered"), `GitViewDetail` |
| `TimelineModels.swift` | The project timeline (events, kinds with word and SF Symbol ONCE, `ProjectTimelineModel`); reloaded on the SSE event `timeline`. Not to be confused with `ChatTimelineStage`/`TimelineItem` (a chat's history) |
| `AccountModels.swift` | Providers, account, settings (`ProviderInfo.defaultEffort`, `ProviderInfoResponse.effortCatalog`) |
| `UsageModels.swift` | Provider usage: `UsageContract` (constants of `server/backend/electron/server/account/usage-contract.js`), the usage answers (an amount without a value is `nil` and shows as "—", never "$0"), `OpenRouterAccessBody`, `ModelPrices`; bound as text in `web/test/usage-binding-ios.test.mjs` |
| `AppModels.swift` | Server environment, notifications, port conflicts, terminal/browser |
| `OuterLoopModels.swift` | The outer loop: `OuterLoopAgent`, `OuterLoopInventory` (catalog and limits), `OuterLoopRun`/`OuterLoopSet`, `OuterLoopNote`, `OuterLoopChatAgent`, `OuterLoopProjectAgent`, the agenda keeper's `OuterLoopUpkeepTally`/`OuterLoopRunUpkeep` (only on the keeper, otherwise `false`/`nil`; bound to the web in `web/test/outerloop-set-binding.test.mjs`); bodies with explicitly encoded fields; the paths in `OuterLoopAPI`. Counterpart `web/src/lib/api/outerloop.ts` |
| `SkillModels.swift` | `SkillEntry`, `SkillCatalog`, `SkillLocation`, the paths as an `APIClient` extension (read tolerantly but without claims: a missing field means "unknown") |
| `SkillHistoryModels.swift` | Skill history with undo, deletion requests, the per-workspace switch, `SkillWriteResult` (the result of `cbase_skill_write`), `SkillEvents` (a shared counter for the `skills` event, since chat cells do not inherit `AppState`), `skillErrorText` |
| `ScheduledModels.swift` | Scheduled jobs: `ScheduledContract` (verbatim from `server/backend/electron/server/scheduled/contract.js`; bound in `web/test/scheduled-binding.test.mjs`), `ScheduledJob`, `ScheduledRun`, `ChatJob` (the `job` field of `GET /api/chats`), the bodies, the words (`ScheduledWord`) |
| `AdministrationModels.swift` | The administration: `AdministrationContract` (constants of `server/gateway/administration-contract.js`), resources/actual/consumption/container/user, bodies encoded by hand; bound as text in `web/test/administration-binding.test.mjs` |
| `ArchiveModels.swift` | The archive: prechecks, `ArchiveHint`, responses, `ArchiveGroups`, and two pure calculations that `web/test/archive-binding.test.mjs` EXECUTES with `xcrun swift` against `web/src/lib/archive.ts`: `ArchiveQuestion.folderDelete` (the deletion question with the server's numbers) and `ArchiveNotices` (whom the archive notices named, per id with a counter value) |
| `ApiContract.swift` | The app's side of the API contract (VERSIONING.md "API level"): the ONE level the app speaks (`ApiContract.level`), the outcome of a server range `{ level, oldest }` (`compatibility`: `needsNewerApp` / `olderServer` / `compatible`; no `api` = an old server = level 1), the header `X-Cbase-Client: ios/<version> (<build>); api=<n>` and the `User-Agent` that `APIClient.makeRequest` sets on EVERY request, the App Store address. The part above `// MARK: - Bundle` is pure and EXECUTED by `web/test/ios-api-contract.test.mjs` with `xcrun swift`. `GatewayInfo` (`Models.swift`) decodes the server's side (`build`, `commit`, `release`, `api`, `gatewayVersion`, all optional) |
| `SSERows.swift` | The line separator of BOTH stream readers in `APIClient`: split only at LF, CR, CRLF, like the browser. `AsyncBytes.lines` would also split at U+2028, U+2029 and U+0085, which `JSON.stringify` leaves raw; `web/test/sse-rows-ios.test.mjs` runs it with `xcrun swift` |

The data layer itself lives here too: `APIClient.swift` (the HTTP client; `makeURL` encodes the path ITSELF, never encode before it),
`JSONValue.swift`, `DecodeHelpers.swift`, `SessionStore.swift` (sign-in, server address, token, the last `/gw/info` as
`gatewayInfo` — every read goes through `apply`, which judges the API range and switches to the phase `.needsNewerApp` —, the memory of the older-server notice) and `UsageStore.swift`. A Swift
module has no imports between its own files; a model that two areas need simply lives in one of them. New models go into the file of
their topic, never into a new catch-all file; the counterpart on the web is `web/src/lib/api/<topic>.ts`.

Not here: the chat's loading logic (`Chat/ChatViewModel.swift`); only its data types live here.

**`EffortLevels` in `Models.swift` is the ONE source of the reasoning levels** for all effort pickers and for `/effort`. There are five
levels. They come per model from `ProviderModel.efforts` (optional; an EMPTY list means "no levels", `EffortLevels.noLevels`; if
missing, `EffortLevels.preset` applies); an empty model is the PROVIDER DEFAULT, not "unknown". `fallback` computes the same clamp as the
server (`effortFallback` in `workflows.js`) and the web: **the highest supported level that is NOT ABOVE the requested one**, or the lowest
supported one if none is below. It clamps DOWN, never up, because one more level costs thinking tokens against the subscription limit.
The ORDER is `EffortLevels.stages` (a copy of `EFFORT_LEVELS`); `preset` next to it is the fallback, not an order. Both hang in the
gate: `web/test/effort.test.mjs` reads the `preset` line BY PATH and holds it against `CLAUDE_EFFORTS`, and
`web/test/effort-ios.test.mjs` cuts the whole `enum EffortLevels` block out of this file, EXECUTES it with `xcrun swift` and computes it
pair by pair against the server. The pickers are ONE block, `Kit/EffortSelection.swift` (empty entry per place + `EffortLevels.selection`).
`EffortLevels` also carries `effectiveProvider(_:active:)` (an empty provider calculates with the globally active one),
`withoutSelection`/`withoutSelectionText` (no picker if `caps.effort` is off or the model has no levels), `standard` and `standardLabel`
(the provider's default level clamped to the model; the variant `asChat:` for a workflow's run level) and the word `ultracode` (only
the word with which `/effort ultracode` flips the toggle). Besides it, only `/effort` (`Chat/ChatViewModel+Slash.swift`) asks the levels
directly.

**The three most common questions:**
- How do I call a route, and why never encode before the path? → `APIClient.swift:APIClient` with `get`/`post`/`put`/`delete`/`send`; `makeURL(_:query:)` sets the path through `URLComponents.path`, which percent-encodes ITSELF: a pre-encoded `%2D` becomes `%252D` and the server answers 404.
- How do I decode a new model tolerantly? → `DecodeHelpers.swift:KeyedDecodingContainer.str(_:_:)` and `int(_:_:)`: missing or `null` fields become the fallback instead of a decoder error.
- Where are app state and sign-in? → `AppState.swift:AppState` (tab, workspace, project, `enterProject`) and `SessionStore.swift:SessionStore` (server address, token, sign-in).
