# Stream recorder (`web/test/streams/`)

Records, against the **real server** (`server/backend/electron/server`) with a **fake CLI** per scenario, what a client
of a chat gets to see — as the basis of the gate test for the streaming reducer and as the template of the golden
harness (`server/backend/test/golden-harness.mjs`).

Per scenario three files under `web/test/fixtures/streams/`:

| File | Source | Content |
|---|---|---|
| `<name>.sse.jsonl` | `GET /api/chats/:id/stream` | every event of the chat stream, one JSON row per event, in order of arrival |
| `<name>.events.jsonl` | `GET /api/events` | the global stream in the same period (sidebar: `run`, `notice`, `chat_title`, `limit_wait`) |
| `<name>.log.json` | `GET /api/chats/:id/log` | the persisted history after quiet (rows with `id`, `role`, `text`, `ts`, `attachments`) |

The recordings are **normalised** (below), so that two runs are byte-equal. The **order** of the events stays untouched —
it is the proof.

## Usage

```sh
node web/test/streams/record.mjs                       # all ten scenarios → fixtures/streams/
node web/test/streams/record.mjs --only run,tool        # a selection
node web/test/streams/record.mjs --target /tmp/probe     # elsewhere (flakiness probe: twice, then diff -r)
node web/test/streams/record.mjs --target /tmp/raw --raw # UNnormalised — shows what the normalisation catches
node --test web/test/streams.test.mjs                       # the gate test (reads only the fixtures, < 100 ms)
```

By hand, **not in the gate**: the recorder starts a server per scenario (port from `freePort`, never 7718), about 14 s
for the plain ones; the limit scenario waits out the measured reset. Every scenario runs in its **own child process**
(`--single`): the server keeps state at module level (running chats, queues, limit timers, the running number of the
bell) — in one process a scenario would depend on the previous one and `--only` would change the recording. The child gets
the gate deadlines `CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000` (as in `tools/check/targets/check.mjs`).

Re-recording means: replace the fixtures in the tree, read `git diff`, gate test green. A difference is a behaviour
difference of the server or a gap in the normalisation, never "adjust it to get green".

## Files

| File | Role |
|---|---|
| `record.mjs` | runner: arguments, one child per scenario, seed (workspace, chat, title), open streams, wait for quiet, normalise, write, report |
| `scenarios.mjs` | the table `SCENARIOS` — per scenario `name`, `purpose`, `run(ctx)`, optional `quiet(ctx)` and `streamLater`, optional `role` (the fake CLI's role if named differently from the scenario) and `rules` (opt-in rules of the normalisation); `record.mjs` and the browser recorder of the drawn bubbles both use it |
| `fake-cli.cjs` | the fake CLI (stream-json like the real Claude CLI); role via `CBASE_STREAM_SCENARIO`, marker files via `CBASE_STREAM_DEPOSIT`. Spawn log to `CBASE_STREAM_SPAWN` (per start `argv`, `cwd`, parsed MCP config; per oneshot the prompt; per chat turn every stdin row), real MCP calls against the cbase MCP server (`mcpCall`), file counters across process boundaries (`count`), and the golden roles (channel, workflow, graph start, native/background subagent, schedule, approval, target gate, ingest, curate) with oneshot answers for gate, target, routing, curator and title prompts |
| `server.mjs` | `withStreamServer` (server + fake CLI + isolation; options `{ webDir, role, env, prefix }`, `ctx.dataRoot`/`ctx.spawnLog`) and `openStream` (SSE reader with `waitFor`) |
| `normalize.mjs` | `newTable`, `normalize`, `normalizeJsonText`, `normalizeLogLine` — pure. Two OPT-IN extensions of the table: `known` (further ids by role) and `rules` (`timeKey`, `msKey`, `replacement`, `upfront`, `texts`, `epochInText`) |
| `../streams.test.mjs` | the gate test of the recordings |
| `../reducer.test.mjs` | the gate test of the streaming reducer — plays `<name>.sse.jsonl` through `chatBubbles.ts` against `fixtures/bubbles/<name>.reducer.json` |
| `../fixtures/bubbles/` | the bubble fixtures (below) |

Reused from `server/backend/test/server-harness.mjs`: `freePort`, `json`, `ok`, `waitFor`, `waitForIdle`, `stopAllRuns`. The
shell is its own because it needs a DIFFERENT fake CLI. The event shapes of the fake CLI come from the green backend tests:
`chat-stream-join` (deltas, join), `ask-card` (question via `POST /ask`), `auto-continue` (limit wording with reset),
`chat-compact` (compact prompt at `=== HISTORY ===`), `usage-tally` (`message_start`/`message_delta`), and
the built-in Agent tool with `parent_tool_use_id`.

## Scenarios

| Name | Trigger | What the stream shows | Harness events (chat stream) | sse / events / log |
|---|---|---|---|---|
| `run` | one message | text in three deltas: `system/init` → `message_start` → `content_block_start` → 3× `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop` → `assistant` → `result` | `connected` → `user_message` → `run_started` → `run_done` | 15 / 4 / 3 |
| `tool` | one message | `tool_use` (Bash) with `input_json_delta`, `user` with `tool_result`, second API call with text (two `message_start`) | like `run` | 23 / 4 / 5 |
| `subagent` | one message | built-in `Agent` tool: 17 child events with `parent_tool_use_id`; history: `tool` with `parent`, `sub_text` — NO assistant row for the subagent text | like `run` | 40 / 4 / 8 |
| `question` | message → `POST /ask-answer` | `tool_use mcp__cbase__cbase_ask` → `ask_request` (from the route, BEFORE the tool_result) → turn ends → `ask_resolved` → `user_message` → second run with `resume:true`; bell `question` with `requestId` | `connected` → `user_message` → `run_started` → `ask_request` → `run_done` → `ask_resolved` → `user_message` → `run_started` → `run_done` | 39 / 7 / 10 |
| `limit` | one message; the CLI dies with "Claude usage limit reached · resets at <ISO>" | `limit_line` (kind wait) → `limit_wait null` → `limit_wait {…}` → after the reset `limit_line` (kind resume) → `limit_wait null` → `run_started` (resume:false — the CLI died without a session) → answer → `limit_wait null` → `run_done`. **The parked run has NO run_done and NO run_error**; global: `run running:false answered:false`, two `notice`, `limit_wait waiting:true/false` | `connected` → `user_message` → `run_started` → `limit_line` → `limit_wait` → `limit_wait` → `limit_line` → `limit_wait` → `run_started` → `limit_wait` → `run_done` | 22 / 12 / 5 |
| `compaction` | message → `POST /compact` → message | `compacting` → (oneshot with the compact prompt) → `compacted {chars, auto:false, percent:0}`; history: `meta` with `compacted:true` between two run metas; the run afterwards `resume:false`, the user row carries the text, the prompt the summary | `connected` → `user_message` → `run_started` → `run_done` → `compacting` → `compacted` → `user_message` → `run_started` → `run_done` | 31 / 6 / 7 |
| `join` | message (the CLI pauses after two deltas) → second message (queued) → **then** open the stream → release | `connected` with `running:true`, `streamText` = the two deltas, `queued:[{id,text,controllable}]`; **no backlog** (no `user_message`, no `run_started`); after the first turn's `result` `message_injected` (the queued message, `queued:[]`), second turn in the SAME process (second `system/init`, second `result`), ONE `run_done` | `connected` → `message_injected` → `run_done` | 20 / 4 / 5 |
| `background` | one message; the main agent starts `cbase_agent` without `run_in_background` (background is the default) and ends its turn | `background` AFTER `run_done` carries the surviving agent (`status: running`); only then the scenario sets `sub-free`, its end comes WITHOUT a turn (`background` without it), the completion notice (`<task-notification>`, `systemNotice: true`) becomes a run of its own; stored under the role `user` | `connected` → `user_message` → `run_started` → `background` → `run_done` → `background` → `user_message` → `background` → `run_started` → `run_done` | 47 / 6 / 10 |
| `dynworkflow` | one message in ultracode mode; the main agent calls `cbase_dynamic_workflow` with two `agent()` and ends its turn | in the chat stream ONLY the start marker (`workflow_marker`, phase start), the turn ends; only after `sub-free` the end marker (phase end, status finished) and the completion notice as a run of its own; no row per workflow agent | `connected` → `user_message` → `run_started` → `workflow_marker` → `run_done` → `workflow_marker` → `user_message` → `run_started` → `run_done` | 39 / 6 / 10 |
| `approval` | one message WITHOUT ultracode and without keyword → `POST /dyn-workflows/approval` with "reject" | the card (`workflow_approval`), the turn ends — the card holds no turn; after the decision `workflow_approval_decided`, the rejection arrives as a system notice (`user_message` with `systemNotice`) and becomes a run of its own | `connected` → `user_message` → `run_started` → `workflow_approval` → `run_done` → `workflow_approval_decided` → `user_message` → `run_started` → `run_done` | 39 / 6 / 10 |

What the server actually sends in the chat stream, measured over the scenarios — kinds `harness` (`connected`,
`user_message`, `run_started`, `run_done`, `ask_request`, `ask_resolved`, `limit_line`, `limit_wait`, `compacting`,
`compacted`, `message_injected`, `background`, `workflow_marker`, `workflow_approval`, `workflow_approval_decided`),
`system` (init), `stream_event`, `assistant`, `user`, `result`; in the global stream `init`, `chat_title`, `run`,
`notice`, `limit_wait`. Not recorded (no scenario triggers them): `run_error`, `run_aborted`, `run_waiting`/`run_busy`,
`message_queue` (comes BEFORE the stream on join), `title` (the chat is titled by hand), `permission_*`, `monitor`,
the `workflow_*` events of the graph workflow, `channel_message`, and `dynwf_tree`/`dyn_workflow`.

Two seed decisions shape the stream: the chat is **titled before the first message** (`PATCH {title}` ⇒ `titled=1`),
otherwise the auto-title oneshot would run after the turn and its `title` event would sit before or after `run_done`
depending on process start — so the global stream has a `chat_title` before the first run. And the chat hangs on **no
project**, so no curator runs (`curateAfterRun` returns at once without a `projectId`).

## Normalisation (`normalize.mjs`)

Rule: what depends on chance, clock, machine or process gets a placeholder — nothing else.

| What | How | Placeholder |
|---|---|---|
| chat id, workspace id | known from the seed | `<chat-1>`, `<ws-1>` |
| all other UUIDs (requestId, queue entry, `collapseId` of the bell) — also **inside** strings (the report of `cbase_ask` carries the requestId as JSON text) | order of first occurrence per recording | `<id-N>` |
| row id of the history (`id` of a log row) | order | `<msg-N>` |
| epoch milliseconds (2020–2033) as a number; the time keys `ts`, `at`, `createdAt`, `updatedAt`, `dueAt`, `resetsAt`, `startedAt`, `wakeupAt`, `resolvedAt` (only if > 0 — `wakeupAt: 0` means "no alarm" and stays) | | `"<t>"` |
| ISO timestamps in text (`resets at 2026-…Z`) | regex | `<iso>` |
| clock texts of the server (`clockText` in `runs/limit-gate.js`: "17.09., 00:54" / "17/09, 00:54") | regex | `<clock>` |
| `secs` of a run meta (run duration in seconds, `Math.max(1, …)` — 2 instead of 1 under load) | key | `"<secs>"` |
| temp root of the server (`/var/folders/…` AND its `/private/…` resolution — the fake CLI reports `cwd` resolved) | string | `<path>` |
| base URL, `127.0.0.1:<port>` | string | `<basis>`, `<port>` |
| `pid`; `version`, `claude_code_version` | key | `"<pid>"`, `"<version>"` |
| JSON in the `text` of a history row (`tool`, `meta`, `limit`, `ask`, …) | parsed, normalised, serialised again | as above |

Deliberately **not** normalised: token counts (the fake CLI sends fixed ones), `contextTokens` (computed from them),
the running number of the bell notice (`notice.id`, from 1 per server process — a scenario is one process), `attempts`,
`num_turns`, the ids of the blocks (`msg_N`, `toolu_…` — the fake CLI issues them fixed, counted through both runs of a
scenario).

What flakes without normalisation (`--raw`, two runs): `chatId`/`workspaceId` in every global event, `ts` of every history
row, `cwd` in `system/init`, `queued[].id` and `message_injected.id`, `requestId` in `ask_request`/`ask_resolved`/bell/
tool_result text/`ask` and `ask_answer` rows, `notice.at` and `notice.collapseId`, `line.at/dueAt/resetsAt` and
`wait.createdAt/updatedAt/dueAt/resetsAt` in the limit, `at` of the compaction marker. The **order** never flaked — not
even under load.

Two time traps the recorder catches itself: on the first turn the server pre-warms the Playwright MCP via `npx -y …`
(`NPX_BIN` points to a no-op) and downloads the embedding model from huggingface.co if the empty HOME has no cache
(`CBASE_EMBED_OFFLINE=1`). HOME is empty so that the limit path without credentials falls back to the reset hint in
the message (as `auto-continue.test.js`, `isolateCredentials`) — otherwise the scenario would depend on the developer's
account.

## The gate test (`web/test/streams.test.mjs`)

Without a server, < 100 ms: table and fixtures agree (ten scenarios, three files each); per scenario parsable, minimum
counts, `run_started` before `run_done` (on join: `connected` with `running:true` before `run_done`), the measured
harness sequence in order, only the known kinds in the chat stream, one run end per run start in the global stream, the
run meta as the last history row; plus one test each for `join` (`connected` with queue, no backlog), `compaction`
(`meta` with `compacted`, two kinds under `meta`), `question`, `limit`, `subagent`, `tool`, `run`, `background` (the agent
lives on in the stream after `run_done`, its end without a turn, the completion notice marked), `dynworkflow` (exactly two
markers of their own role, live and in the history, nothing per workflow agent) and `approval` (card and decision under
their own roles, the rejection a system notice); and the normalisation as a promise (no raw UUID, epoch time, temp path or
port in any file; placeholders in order).

Counter-test map: `run_done` removed from `run.sse.jsonl` ⇒ 1 red; one `<id-1>` replaced by a raw UUID ⇒ 2 red;
`compacted:true` → `false` in `compaction.log.json` ⇒ 1 red.

## The bubble fixtures (`web/test/fixtures/bubbles/`)

The same streams, turned into bubbles TWICE — once in the browser, once in the reducer:

| File | Source | Content |
|---|---|---|
| `<name>.json` | the browser recorder (headless Chrome, run by hand, against `web/out`, same server and fake CLI as here, `withStreamServer` with `webDir`) | the drawn DOM of the coding chat after quiet: per child of `.cb-chat-in` `role`, `text`, `markers` and the tree (classes, `data-*`, `aria-*`, tool names, result markers, cards, dividers) — normalised as above, plus `<status>` (the random status word of the indicator), `<verb> für <secs>` (the summary) and `<dur>` |
| `<name>.mid.json` | likewise, mid-scenario | `join`: after the `connected` with a running turn (one user bubble + indicator); `question`: the open card before the answer; `limit`: the wait row |
| `recording.json` | the recorder | `{commit, workingTree, recorded}` |
| `<name>.reducer.json` | `web/test/reducer.test.mjs` with `CBASE_BUBBLES_RECORD=1` | `start` (`[]`, on join `buildBubbles(history up to the join)`), `history` (per event kind, bubble count, stream state) and `bubbles` (the list at the end) |

The DOM files are the proof of "no behaviour change": `bubbles-record.mjs --compare` draws them byte-equal. The reducer
files are the reference afterwards — a difference there is an intended, named change of the reducer or a bug, never
"adjust it to get green". The reducer test replays the shell (laps start, token counter, "joined" per event like
`ChatPane.onEvent`), translates the placeholders back (`"<t>"` → a fixed epoch number, `"<secs>"` → 1), freezes input and
ctx (a mutation throws) and holds `streamAfterEvent == apply().stream` per event. Two findings, not repaired: the
`connected` carries `streamText` while the web client reads `streamedText` — the "missing beginning" never arrives in the
web (`join.mid.json`: only the user bubble); and in the `limit` scenario an empty answer bubble with `streaming:true`
stays (`limit.json`, row 2). No scenario streams a `thinking_delta` (the fake CLI has none) — a candidate for another
scenario. `approval` has only `approval.reducer.json`, no DOM file (the recording's `role`/`markers` do not know
`data-workflow-approval`).

## The second user: the golden harness

`server/backend/test/golden-harness.mjs` + `golden-scenarios.mjs` use the **same recorder** — shell, fake CLI,
normalisation — with two more sources per scenario: the **DB rows** of the touched tables (`db.json`) and the **spawn
arguments with stdin/prompt bytes** of the fake CLI (`spawn.json`, in pid order = spawn order of the server); fixtures
under `server/backend/test/fixtures/golden/<scenario>/`, gate test `server/backend/test/golden-runs.test.js` (records
again and compares byte-equal). The scenario table, the golden rules of the normalisation and the flakiness/sabotage
probes are in the head of the harness. Rule for both users: a change to `server.mjs`, `normalize.mjs` or
`fake-cli.cjs` must leave the web fixtures here AND the golden fixtures there byte-equal
(`record.mjs --target … && diff -r`, `golden-harness.mjs --target … && diff -r`).
