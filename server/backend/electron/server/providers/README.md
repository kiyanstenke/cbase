# `providers/` — providers (ports & adapters)

**What lives here:** the adapter core through which the whole app talks to every LLM. The guard of this folder is the
contract (`contract.js`), not a byte proof.

## Files

- `contract.js` — the **port**: the provider-neutral run spec, the Claude-shaped `stream-json` event schema with its
  event builders (`ev`, `withParent`), the connector shape with `caps`, the canonical tool names and the validators.
  PURE: no state, no I/O, no imports. `normalizeCaps` knows the capability `prefixCache` ("does the provider read an
  identical prompt start from the cache?"): true for Claude and Codex, false for the built-in OpenRouter. Only then
  does a dynamic workflow stagger similar agents (`../dynworkflows/cap.js:createStagger`). `ev.usageStart` carries an
  optional upstream provider (the provider BEHIND a router that delivered the round) — display only, the calculation
  keeps using the catalog number.
- `index.js` — the **registry and the dispatch**: `registerConnector` (exactly the three providers of the contract in
  `../account/usage-contract.js` — claude, codex, openrouter; any other identifier THROWS; `foreignProviderIn(ref)`
  tells the routes that store a reference `provider::model` whether it names a provider that does not exist → 400),
  the built-in OpenRouter (`connectors/openrouter.js`, access per call from `store.openRouterAccess`), its SHORTLIST
  for system prompt and tool descriptions (`agentHosts`: default model plus the ones used within `SHORTLIST_DAYS`,
  plus `catalog: true`) and `modelSelectable` (checked against the whole catalog; an empty one is unknown), the
  mirrored view `PROVIDERS` (the same object reference, refilled at every registration — `account/` reads from it),
  the active provider (`getActiveProviderId`, `providerForChat`), the resolution of `provider::model`
  (`parseModelRef` → `resolveModelRef`, `resolveModelFor`), the material axes (`materialCapabilities`, `canVision` —
  "can look at images" is NOT "takes a PDF"), the **start gate at the spawn layer** (`setStartGate`, asked in
  `runOnce` and, via `startGateVerdict`, by the subagent core BEFORE every agent start with the provider of the
  SUBAGENT; a locked start is a tool error, not a start), the **visibility per account kind**, **"which effort level
  really runs"** (`effortRunning`) and the **default model and default level per provider** (`defaultModelFor` with
  `DEFAULT_MODEL_FALLBACK` lives HERE — the way back from `account/providers.js` would be a cycle; that module
  re-exports it). The index does NOT hold the model catalogs: it imports `CLAUDE_MODELS` and `CODEX_MODELS` from
  their connectors.
- `connectors/` — one file per wire format.
  - **Native** (`caps.ownsAgentLoop: true`, bring their own agentic loop): `claude.js` (`claude -p`, `CLAUDE_MODELS`
    with `efforts` and `catalogLevel` per model, `buildClaudeChatArgs`, `claudeEfforts`/`mapClaudeEffort`) and
    `codex.js` (`codex exec --json`, `CODEX_MODELS` with `context`/`efforts`/`catalogLevel`/`onlyApiKey`,
    `buildCodexChatArgs`, `codexEfforts`/`codexEffortFallback`, the alias `haiku|sonnet|opus|fable`, reading tokens and
    limits from the session file). `claudeEfforts`/`codexEfforts` return `null` for a model outside the catalog
    (unknown — the level passes through) and an EMPTY list for a model with `efforts: []` (no levels — no flag).
  - **Completion** (`ownsAgentLoop: false`, delivers ONE round): `openai-chat.js` is the factory of the wire; it
    builds exactly one provider, the BUILT-IN OpenRouter (`openrouter.js`: fixed identifier `openrouter`, base from
    the contract — only `CBASE_OPENROUTER_BASE` overrides it, the test seam —, models from `../openrouter-catalog.js`,
    `reportsCost` always true). The default model comes through the callback `defaultModel` = `defaultModelFor` (ONE
    default model, the same function as every run).
  - **Codex flags** (all measured against the pinned version, scripts in the private CLI measurement scripts): the tool list of
    a subagent definition goes per foreign MCP server as `-c mcp_servers.<name>.enabled_tools=[…]` (an empty list
    locks the server entirely); the cbase server is cut via `CBASE_TOOLS`; Codex's built-ins (shell, patch, web
    search) cannot be cut one by one. `CODEX_WITHOUT_OWN_TOOLS` (no goal tools, no `request_user_input` — cbase
    keeps goals itself and asks via `cbase_ask`) stands in EVERY exec; `CODEX_WITHOUT_FILE_ACCESS` builds on it
    (`--disable shell_tool --disable unified_exec --disable view_image`) and is appended when the spec carries
    `codexWithoutFileAccess`; `codexToolCut` gives every run exactly one of the two lists. EVERY exec also carries
    `CODEX_WITHOUT_SELF_READ` (`-c project_doc_max_bytes=0`): Codex would otherwise read AGENTS.md in addition to
    cbase's project memory (`../runs/system-prompt.js`). Secrets never stand in the argv: the headers of an HTTP MCP
    server go as `env_http_headers` and the instance token as `env_vars=["CBASE_TOKEN"]`, the VALUES travel through
    `mcpSecretEnvironment` in the environment of the Codex process. Without an instance every stdio server gets the
    names of the backend's package caches in `env_vars` and its PATH via `withGitWrapperFront`.
    **Trap:** Codex's MCP tools never stand in the model request (they are deferred sub-tools of code mode) — a look
    at the request falsely reports "no tool"; measure through real calls.
  - Both native connectors attach `controlCbase(text)` to their child, the engine to its handle — the message to a
    RUNNING subagent (Claude via stdin at the next tool boundary; Codex has none: there the message becomes a
    continuation after the end).
- `preset-levels.js` — which level the wire sends, stated ONCE: `explicitLevels` (the levels a model entry with
  `efforts` names EXPLICITLY, otherwise `null`) and `wireLevel` (the clamp before it). Default: all five levels go
  out as such (OpenRouter maps them itself).
- `engine.js` — the generic **loop engine** that drives completion providers to a full run: tool loop, built-in
  tools, MCP, approvals, skills, token accounting in Claude form, resume from the transcript. It is neutral;
  everything provider-specific is in the connector. Details below.
- The building blocks of the engine: `tool-runtime.js` (the built-in file/shell tools, with the same names and input
  shapes as Claude's — otherwise the clients render them differently), `mcp-client.js` (in-process MCP over stdio,
  http/sse best effort), `permission-gate.js` (permission enforcement for the completion path; `requestPermission`
  comes from `runs/permissions.js`), `monitor-runtime.js` (monitors for all providers; throttle for every monitor, the total event cap only for one with a time limit — a persistent watch has none; a kept `taskId` for the resume after a restart, `runs/monitors.js`), `transcript.js` (persisted
  history → neutral messages; the memory of every stateless provider), `hook-run.js`.
- `agent-runtime.js` — the provider-neutral **subagent core**; the owner per chat is `../runs/agents.js`. Details below.
- `agent-wait.js` — the deadlines of waiting (leaf): foreground deadline `FOREGROUND_DEFAULT_MS`, the wait edge of an
  MCP request, and "the main agent never waits" (`MAIN_AGENT_WAIT_DEFAULT_MS` = 0).
- `stall-watchdog.js` — a leaf without imports: `createStallWatchdog(…)`. The clock stands while a tool call is open
  (`tool_use` until the `tool_result` of the same id; Codex `item.started`/`item.completed`), every event is progress,
  Codex's thinking phase is silent and counts against the deadline. `adjustableClock` lets a test ADVANCE the clock
  instead of waiting.
- `connectors/consumption.js` — the **consumption of a one-shot call** and the sums of the core (leaf without
  imports). `reportConsumption(callback, {…})` calls `opts.atConsumption` safely (a throw — also a rejected promise —
  does not topple the call); EVERY `runOnce` reports. `index.js:runOnce` wraps the callback, fills provider/model
  from its resolution and sets the billing kind from the provider kind (`ownsAgentLoop` ⇒ `subscription`, otherwise
  `metered` — the connector never guesses it). `bookingCounts(v)` gives the numbers of the usage row in the shape of
  its kind (metered in the engine contract, subscription with `cached` = read + write — otherwise the subscription
  report would count the read cache twice). Reported cost (OpenRouter): a missing amount means NOT REPORTED, never 0;
  `combinedCost(a, b)` is all or nothing (one round with tokens but without an amount makes the whole run null — a
  half-reported sum would look complete); `costMissing: true` marks a part that did cost but whose amount is unknown
  (a round without a usage chunk, every error AFTER the response head). `consumptionPlus` and `tokenIncrease` (never
  negative) are the sums of the subagent core. The return value stays text; the caller books.
- `openrouter-endpoints.js` — the endpoint fetch of OpenRouter (leaf without imports): `fetchEndpoints` (cached 1 h
  per process and base, an HTTP error THROWS and is not cached; an alias "~…" asks the endpoints of its target),
  `endpointsMedian` (a heuristic for the context number), `windowOf(endpoints, name)` (the window of the provider that
  delivered the last answer; 0 = unknown), `priceSpan` (null = unknown, "0" is a real price), `isOpenRouterBase(url)`.
- `openrouter-catalog.js` — the **model catalog of the built-in OpenRouter**: `GET <base>/models`, stored in
  `<data>/openrouter-catalog.json`, renewed every 6 h, at start at once from the file (`startCatalog`); an error or an
  empty answer leaves the last state standing, a state of another base does not count. Only entries with `tools` are
  selectable (`catalogList`). Empty means UNKNOWN (`catalogKnows` → null), not "does not exist".
  `CBASE_OPENROUTER_OFFLINE=1` blocks the network to the real base; the test seam is `setCatalogSourceForTests`.
- `hook-run.js` — running the agent hooks: `matchingHooks`, `executeHook` (process via `inProject`, LFS environment,
  own group, deadline `CBASE_HOOK_DEADLINE_MS`), `fireAgentHook` (events without an effect back). ONE path for the
  hooks of the loop engine and the "SubagentStop" that `../runs/agents.js` fires at the end of EVERY subagent.
- `kind-stdin.js` — the ONE way to write to or close a child's stdin (`writeStdin`, `closeStdin`, `stdinOpen`; leaf).
  It registers the error handler BEFORE writing: `child.on("error", …)` only catches the SPAWN error, an EPIPE on the
  stdin STREAM is an unhandled exception without a listener — the death of the server process. A `try/catch` around
  the write does not help: the stream error arrives asynchronously.
- `codex-builtins.js` — Codex's built-ins in stages (leaf): `CODEX_WRITES` and `codexIntersectionOfTheBuiltins` —
  the tool list of a Codex subagent: without built-ins ⇒ `codexWithoutFileAccess` and read-only; only reading ones ⇒
  read-only sandbox (the shell stays); with a writing one ⇒ the mode of the caller.
- `retired.js` — retired models and their successor: ONE table for the migration and for the runtime (leaf).

## The loop engine (`engine.js`)

- **Always offered:** `ALWAYS_ON` holds `cbase_ask`, `cbase_monitor`, `cbase_wakeup`, the messenger
  `mcp__cbase__StructuredOutput`, and start AND stop of the cbase families (`cbase_agent`, `cbase_dynamic_workflow`,
  `cbase_monitor` and their `_stop`). Rule: a family whose stop is always visible shows its start too — a model that
  sees only the stop calls it to start something. The remaining members stay deferred; what the server does not
  offer (`../../mcp/visibility.js`) does not exist here either.
- **One tool per purpose, the same for every provider:** the engine does NOT provide `Task`, `Monitor`, `TaskStop`
  and `ScheduleWakeup` (`ENGINE_NOT_PROVIDED` — locked at the offer AND at execution; a resumed history can still
  name them). They were doubles of the cbase tools. A `cbase_agent` of the engine carries its call id as
  `_meta["cbase/toolUseId"]`. The tool allowlist of a subagent (`spec.agentTools`) also carries MCP names
  (`mcp__<server>__*` = whole server) and also applies EMPTY; the depth limit of delegating is drawn by the MCP
  server (`AGENT_DEPTH_MAX`).
- **Tools loaded via ToolSearch stay loaded for the whole RUN** (`activated`) and are rebuilt from the transcript in
  a new run (`activateFromHistory`; the same rule as live: `select:` names and `<function>` hits only of a ToolSearch
  whose result was not an error; a DIRECT call of a deferred tool loads nothing). Limit: the rebuild only knows what
  STANDS in the transcript — after a cbase compaction the run starts again with the core set plus `ALWAYS_ON`, and a
  keyword ToolSearch with large schemas is cut when stored.
- **The prompt cache at the turn boundary:** the first request of a new run begins with the bytes of the last one of
  the previous run — same tool list, same system prompt, the messages before it byte-equal. For that the engine
  stores assistant text in `messages` the way `transcript.js:buildTranscript` builds it later (`asHistoryText`:
  trimmed, pure whitespace falls away); the events to the user stay raw. Not covered: the trimming and caps of the
  transcript, prefixes that only exist in memory (hook context, images), cbase compaction. Guard "turn boundary" in
  `server/backend/test/engine-harness.test.js`.
- **Call as text instead of a function call:** the slip stays as an assistant message in the history, the harness
  hint travels ONLY in the one followed-up request (`followUpHint`). If the followed-up round calls without text of
  its own, its calls hang on the slip's message — as `transcript.js` puts tool rows on the assistant entry before.
  **Exception thinking blocks:** if the connector delivers signed thinking blocks (`thinkingBlocks`), slip and hint
  stay PERMANENTLY in the run's history and nothing is merged — the signature of a thinking block binds the prefix
  before it.
- **"Thought, not acted":** if the connector reports `thinkingWithoutResponse`, the engine follows up ONCE in a row —
  only with offered tools and only if the thinking names a tool of this run as a whole word (`namesTool`); the cap
  `MAX_NUDGES` is shared with the text-instead-of-call follow-up. The hint hangs on the last user message if that is
  pure text (`attachUserTextTo` — never two user roles in a row) and only in that ONE request. If the followed-up
  round delivers nothing, the thinking of the FIRST round is the answer — following up never yields less than the
  state before. If the thinking names no tool, `thinkingAsResponse` applies at once. Both paths and MCP servers that
  did not connect are written by `diagnosticRow` to stderr AND the server log.
- **Tool start in the stream:** `complete` reports via `onDelta`, besides `{text}` and `{thinking}`, also
  `{toolStart: {id, name}}` — ONCE per call, as soon as id AND name stand in the stream, with the id under which
  `toolCalls` returns the call at the end (no id in the stream ⇒ NO start). The engine turns it into
  `ev.toolUseStart(id, name)`; a subagent forwards it with `parent_tool_use_id`. It is display ONLY: requests,
  history and DB rows stay byte-equal; the stall watchdog counts it as progress. **After a start the round is not
  repeated** (`completeWithRetry`): the repeated round would assign a new id and the old row would never get input
  and result. The clients match a start only to an OPEN block — Codex counts its item ids anew per process.

## The subagent core (`agent-runtime.js`)

- **Background is the default.** What the MAIN AGENT starts always runs in the background, and `cbase_agent_output`
  does not wait for it. Only a call by a subagent that delegates itself waits in the foreground, at most
  `FOREGROUND_DEFAULT_MS`, and then changes to the background. There is ONE transition `toBackground(rec, reason)` —
  for deadline, button (`intoTheBackground`), parking, turn end and the end of the parent agent.
- **Messages:** `message(id, text)` hands a living agent a message (the report of a grandchild to its parent,
  `GRANDCHILD_REPORT_SET` in the frame). `send()` to an agent that has already ended needs `folderForResumption(rec)`:
  an unchanged worktree was removed at its end, so `send()` creates a fresh one at the same place before the new
  process — or rejects with a reason. `control()` (messages to workflow agents) NEVER resumes a finished agent: it
  answers delivered (mid-turn), after the end (Codex), noted (its first process does not stand yet: `rec.beforeStart`;
  parked: at the input of the resumption) or null (it no longer lives). A restart of the turn appends what was
  delivered into the killed attempt (`rec.controlled`) to the input of the new one — the session from before the
  turn does not know it.
- **Stall and restart:** every run has a stall watchdog; a stall ends as `failed`, not as stopped. The rule is a
  parameter of the core: `stallRule` (default `subagentStallRule` = deadline, zero repetitions; the agents of a
  dynamic workflow run `workflowStallRule` with restarts). A restart starts the same turn with the same input and the
  session from before the turn (loop in `drive()`); `restart(id)` by the human takes the same path and is only
  allowed mid-attempt (`rec.inTurn`). Stall restarts and hand restarts are counted separately; the repetition limit
  only knows the stall.
- **Consumption:** the core sums the consumption of EVERY attempt of a turn and keeps two states: `rec.usage` across
  all turns and the open amount since the last booking, which `settle` hands to `onFinish`. An agent that ends
  MID-turn books exactly once: `settle` folds its counter (`counterFold`), and what the process only reports AFTER
  settle is booked via `atLateConsumption`.
- **Output file** (`writeOutputFile`): if writing fails, the core warns, sets `outputMissing`, appends the sentence
  "Output file not written (<code>): <path>" once to the notes, and report and list name `outputFile: ""` — never a
  path that does not exist.
- **Worktree:** `selectRepo` asks `../git.js:isProjectRepo` — the root of the project repo counts as "no repo", and
  `isolation:"worktree"` branches off the code repos of the project (`repoCandidates`). With an instance EVERY git of
  the worktree section runs in the project container, through the owner's callback `gitFor(identifier)` (the core
  knows no container); `makeWorktree` is then asynchronous and stands in `start()` BEFORE the await-free section, and
  a rejected start hands the fresh worktree back as a teardown order (`worktreeBack`). At the turn end `turnEnd`
  awaits the teardown before `settle` writes the report; stop and close hand it over as an order
  (`releaseWorktree`). Unchanged it falls together with its branch, changed it stays. WITHOUT an instance the core
  never asks `gitFor` — the synchronous path in the backend is byte-equal. `unregisterWorktree({ dir, repo })`
  deregisters an agent worktree in the repo (the branch stays).
- **`confirmSession`:** if the spec carries it (the factory moved the session of a resumed subagent into another
  home), the core calls it after a successful, not stopped turn with the session id of the result — only then do the
  old copies fall.
- **Background commands of the Claude CLI:** `claude -p` waits after stdin closes for open tasks and then runs a
  follow-up turn. `connectors/claude.js:runChatClaude` (`cbaseEndInput`) stops them itself first (`stop_task` per
  task, stdin closed only after the last answer); a one-shot runs without background tasks. If a command ends only IN
  the last model request, the CLI runs its notice as a turn of its own right after the result: the chat takes it as
  the continuation of the same run, a subagent keeps the report of the FIRST result (`makeForward`). Guard
  `server/backend/test/background-end.test.js`.

## In the project container

The run spec carries the instance (the mapped instance row of a relocated project, or `null`, fixed at the turn start
in `../runs/do-run.js`). EVERY process a run starts goes through `../runtime/inProject.js:inProject(instance, …)` —
without an instance exactly `spawn`: the turn process of both native connectors, in the loop engine the Bash tools
(`tool-runtime.js`), the hooks (`hook-run.js`), the stdio MCP servers (`mcp-client.js`) and the monitor
(`monitor-runtime.js`; `killProcessTree` asks the mark `child.inProject` and then calls `child.kill` —
`process.kill(-pid)` would only hit the group of the docker child in the backend). The core keeps the identifier per
agent, and the start gate of an agent gets it (`instanceOf(agentId)` names it — from it `../runs/agents.js` computes
the project whose lock applies). The one-shots stay in the backend — except the service detection
(`runOnce(…, { instance, projectId })`, read-only form); `runOnceCodex` rejects an instance before it starts
anything. Guards `server/backend/test/inProject.test.js` and `in-project-start-places.test.js` (the table of all
start places and of the allowed child processes of this folder).

**Git LFS in the agent shells:** five start places pass their options through
`../runs/lfs-environment.js:withLfsEnvironment(instance, { … })` — the turn process of both native connectors, the
hooks, the engine's Bash (foreground and background) and the monitor. With an instance they carry the LFS variables
only as `-e NAME`, the values in the environment of the docker child; without an instance it is THE SAME options
object. NOT: the service detection and the stdio MCP client. The stored access is fetched only by the git credential
helper `server/backend/cbase-lfs-access`, and only when git-lfs asks.

**File tools and network paths of the engine:** the engine runs in the backend even when its Bash runs in the project
container. With an instance the file tools check the REAL place (`tool-runtime.js:resolveInSandbox`,
`../runtime/real-path.js:realLocation`: realpath of the deepest existing ancestor) against the real place of the roots
— a symlink the agent creates in the container does not lead into the neighbouring project. The ROOTS count only via
the trusted anchors (`../runs/runtime-limit.js:anchorOfTheInstance`), and Read, Write, Edit, MultiEdit, NotebookEdit,
Glob and Grep access through a CHECKED DESCRIPTOR (`areaOf(ctx)`: open first, then check the place of what was opened,
then read or write via the fd — a path part that turns into a link between check and access leads nowhere). WebFetch
(`fetchText`), the WebSocket monitor and an HTTP MCP server (`HttpClient`) connect `localhost`, 127/8, `::1` and
`0.0.0.0` to the IP of the instance (`../runtime/target.js`: URL, host header and SNI stay, redirects by hand, every
hop mapped anew); every other host goes through the guard (never an address of the backend); the WebFetch cache
separates by instance. Without an instance every place has the plain call. In a COPY `areaOf(ctx)` is
`runtime-limit.js:areaInB`: its project folder does not count as a root in the backend (the backend would see the
main instance there). Guards `tool-runtime.test.js`, `tool-runtime-copy.test.js`, `network-target.test.js`,
`engine-in-project.test.js`.

**Codex rollouts in the project homes (`connectors/codex.js`):** `codexSessionRoots` — the roots of all three rollout
readers — adds the Codex homes of the projects with an instance row. The source comes via `setCodexHomeSource(fn)`
from `server.js`; a connector does not ask the store. A file under a PROJECT home counts as written by a stranger
(the container writes there): opened via `../runs/runtime-write.js:openFromRuntimeFolder` (no link, no FIFO), only
the END is read (`ROLLOUT_END_MAX`), a file with an mtime in the future falls away entirely — it would otherwise win
every "newest" choice forever — and the NUMBER is capped per home. For the limit gate only the OWN thread counts
from project homes.

**The prefix of a Codex run (`connectors/codex-prefix.js`):** the defaults (for Claude `--append-system-prompt`) and
the NAMES of the run's MCP tools stand as ONE block with a version (hash) before the input — only if the thread is
new or its rollout does not carry this block verbatim as its LATEST block. The search is only in the home of THIS run
(`codex.js:rolloutOfTheThread`). The measured Codex version (`MEASURED_ON_CODEX`) is bound to the pin of the
Dockerfile. Emergency switch `CBASE_CODEX_PREFIX_EVERY_TURN=1`. Guard `server/backend/test/codex-prefix.test.js`.

## Visibility and effort level (`index.js`)

**Visibility per account kind:** `visibleModels(providerId, models)` is the ONE place for "may this account run this
model?". A ChatGPT account rejects some Codex models with HTTP 400 — hence the mark `onlyApiKey` in `CODEX_MODELS`; it
never goes out, it is a measurement and not a contract with the client. The account kind comes via a **setter** that
`GET /api/providers` fills at every fetch (`setAccountKind`), and it **survives the restart**. The default is
explicitly an ANSWER and not a gap: unknown means show EVERYTHING. An EMPTY account kind deletes nothing; whoever
wants to forget says so (`forgetAccountKind`, called at the Codex logout). `agentHosts()` hangs at the same place and
with it every path that NAMES subagent models — a lock cannot be bolted on, it belongs at the one place everybody
passes.

**Which level really runs:** `effortRunning(providerId, model, set)` is the ONE resolution of every run — the set
level, otherwise the provider's default level (`effortStandard`: chosen under `DEFAULT_LEVEL_SETTING` → on the
fallback MODEL the fallback level `DEFAULT_EFFORT_FALLBACK` → otherwise `effortCatalogLevel` of the default model, the
level the CLI runs it with WITHOUT `--effort` → otherwise `medium`), then the clamp to the model via `effortFallback`.
The step before the clamp is `effortDesired(providerId, set)`; a subagent inherits exactly this wish of the parent
chat and clamps it to ITS model. Ultracode is a switch of the chat, not a level, and never goes onto the wire as a
value of its own. `runOnce` resolves the level itself as well. The model's levels come from the connector
(`connector.efforts(model)`; without `efforts` = unknown, the level passes through). The clamp at the spawn stays in
the connector and is a no-op afterwards (`effortFallback` is idempotent). The counterpart when STORING is
`../workflows.js:effortSavable`. No place filters against the level order by itself;
`server/backend/test/effort-core.test.js` holds that.

**Routes:** none. This folder has no `routes.js` — it is used by `account/routes.js` (picker, default model, login
status), `runs/do-run.js` (run and subagent) and about twenty `runOnce` callers.

**What does NOT live here:** the login status and usage numbers of the Claude account (`../account/usage.js`), the
limit detection in a run's output (`../limits.js`), what the start gate decides (`../runs/limit-gate.js`; here it only
says THAT it is asked), whom a subagent belongs to and what remains of it (`../runs/agents.js`, stock
`../store/subagents.js`), which tools a subagent gets (`../runs/agent-set.js`, depth table `../../mcp/visibility.js`),
which levels a chat may store, their order and the one calculation of the clamp
(`../workflows.js:EFFORT_LEVELS`/`effortSavable`/`effortFallback` — the only module outside this folder the connectors
import) and the MCP configuration per chat (`../toolchain/mcp-config.js`).

**Terms → file:** contract, event schema, capabilities (`caps`), canonical tool names → `contract.js` · tool start in
the stream (`toolStart` → `ev.toolUseStart`) → `connectors/openai-chat.js` and `engine.js` · registry, active
provider, model reference, start gate, visibility/account kind, agent hosts, default model, default level, catalog
level → `index.js` · model catalog, context window, effort levels per model, alias → `connectors/codex.js` and
`connectors/claude.js` · which level runs → `index.js:effortRunning` · which level the wire sends →
`preset-levels.js` · retired models and their successor → `retired.js` · loop engine, built-in tools, approvals,
monitors, transcript → `engine.js` and its neighbours · subagent core, readjusting, restart of an agent, stall rule
per kind → `agent-runtime.js` · foreground deadline, wait edge of the MCP request, "the main agent never waits" →
`agent-wait.js` · stall watchdog → `stall-watchdog.js` · prefix cache (`caps.prefixCache`) →
`contract.js:normalizeCaps` · the built-in OpenRouter → `connectors/openrouter.js`, its catalog →
`openrouter-catalog.js`.

**The most common questions:**
- A model is not selectable in the picker — catalog or account? → `CODEX_MODELS` / `CLAUDE_MODELS` (if it is not in
  there at all, it is selectable nowhere; the picker knows no free text) / `index.js:visibleModels` (if it is in there
  and still missing, it carries `onlyApiKey` and the logged-in account is a ChatGPT subscription).
- Which reasoning level really runs when the chat carries one the model does not have? → `index.js:effortRunning`.
  The calculation stands ONCE, in `../workflows.js:effortFallback` next to the order `EFFORT_LEVELS`
  (`low < medium < high < xhigh < max`); all clamps at the spawn call it too. The rule: the highest supported level
  that is NOT ABOVE the desired one — downwards, never upwards, because a level more costs thinking tokens against
  the subscription limit. What is not in `EFFORT_LEVELS` is not a level and falls away everywhere (no flag, no
  field). Web and iOS recompute the same rule (`web/src/lib/effort.ts`, `Models.swift`), so that the surface names the
  level that then thinks.
- A provider run dies and the whole server process with it (`write EPIPE`, `uncaughtException`)? → Somewhere a
  child's stdin is written past `kind-stdin.js`. The static part of `server/backend/test/stdin-epipe.test.js` names
  every place under `electron/server/`.
- A Claude run with a background command does not end, or a subagent reports the text of a second turn instead of
  its report? → see "Background commands of the Claude CLI" above.
- How is a new provider added? → Not through the surface: the contract `../account/usage-contract.js` names exactly
  three, and `index.js:registerConnector` throws for any other identifier (guard
  `server/backend/test/only-three-provider.test.js`). A fourth would need a decision, a `connectors/<x>.js` following
  `contract.js` and an entry in the contract. An OpenRouter model needs nothing: the catalog loads itself.
- Why does a stopped subagent still book exactly once? → see "Consumption" above; guard
  `server/backend/test/abort-booking.test.js`.
