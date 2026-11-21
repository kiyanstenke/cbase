# cbase — the backend per user

The backend of cbase: chat management, long-term memory, context archive, chat-bound file artifacts, workflows and project
containers. It runs headless (`headless.js`) in **one container per user** (`cbase-u-<id>`, Sysbox, inner Docker) behind the
gateway (`server/gateway/`, port 7719) and drives `claude -p` or `codex exec` **against the user's own subscription**.

| Layer | Technology |
| --- | --- |
| Entry | `headless.js` — PID 1 in the user container (image `server/backend/Dockerfile`, path `/app`) |
| Backend | pure-Node HTTP server (`electron/server/`) — **port 7718** (API + SSE) |
| Database | SQLite (`node:sqlite`, `<data>/automater.db` in the user volume) |
| Frontend | Next.js static export (`web/out`), served by the gateway |
| Claude / Codex | the CLIs pinned in the image (Dockerfile), logged in as the user |

The folder name `electron/` stayed (image path `/app/electron`, deploy tree hash); it no longer means Electron. Claude talks to the
API through the **cbase MCP server** (`electron/mcp/cbase-mcp.js`) — a stdio MCP server with typed tools (`mcp__cbase__*`), wired
in per run with `--mcp-config`.

**"Without an operating mark":** many comments contrast server operation (`projectbox/ops.js`: `CBASE_CONTAINER` AND `CBASE_DIND`)
with a backend without a container — the suites, browser checks by hand and a locally started server.

## Build and roll out

```bash
./build.sh                 # build the images (cbase-backend, cbase-projectbox) from a staged build context
npm ci                     # locally, for tests and tools (lockfile here; the image installs with --omit=dev)
```

A runtime dependency lives in three places: `package.json`, `package-lock.json` and the install line of the Dockerfile (guard
`tools/check/runtime-dependencies.test.mjs`).

## What it does

### Chats and runs
- Every chat belongs to exactly one workspace, optionally to a project. The CLI runs with the workspace (or project) path as `cwd`,
  one session per chat (`--resume`). Answers stream live over SSE (text deltas, visible tool use) and are stored in SQLite.
- **Titles at send time:** the first message sets a provisional title (its first 40 characters); a small model produces the real
  one in parallel. The chat text goes in as DATA inside `<chat>…</chat>` with a note to ignore instructions in it — otherwise the
  title model (a full agent with tools) follows them. A manually set title (`titled`) is never overwritten.
- **Wait phase instead of cutting off:** when a turn ends while background work is open, the process stays alive (stdin open) and
  the run enters the wait phase; messages are injected into the running process and the CLI starts the follow-up turn itself.
  Reasons that hold it open: monitor (no deadline), background agent (none), background bash (10 min idle), scheduled wake-up
  (wake time + 45 s). A finished background task whose evaluation has not arrived keeps stdin open for 30 s more. All deadlines are
  **absolute points in time**, never durations — `armDrain` recomputes on expiry and a relative duration would extend forever.
- **Running agents are visible:** foreground subagents (tool block without result) and background agents (their tool block is
  acknowledged at once, hence the extra SSE event `background`).
- **The context size survives a reload mid-run:** written continuously to `chats.context_tokens` and carried by the `connected`
  event of the chat stream.
- **Questions with a selection card (`cbase_ask`):** the tool does NOT block — it returns at once, the agent ends its turn, and the
  user's choice arrives as the next user message. State lives only in the history (`role='ask'` / `'ask_answer'`). A question is
  open only while unanswered AND no user message followed (`openAskOf`, computed identically on client and server); a second
  question is refused while one is open.
- **Auto-continue at a usage limit:** a run that hits the subscription limit is **parked** and resumed when the limit resets, also
  across restarts. The error text is matched against the verified CLI wordings; the server then fetches the provider's limit state
  and waits for the **blocking** window's reset plus 45 s grace — with several exhausted windows the LATEST reset wins. Credit or
  spend-cap exhaustion never waits. Caps: 12 continuations and 24 probes per chat. The decision logic is pure (`server/limits.js`:
  no network, no DB) so it is testable without a real limit.
- Tasks of the agent: the Claude CLI's own list is `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet`; clients derive the list state
  from the sequence of all calls and render it in a fixed bar above the composer (open items by task id, so ticking does not
  flicker). Not to be confused with `TaskStop`/`TaskOutput`, whose `task_id` is a BACKGROUND id.

### Workflows (node/edge graph the agent works through)
- Own tab on workspace and project level with the opt-in pattern of skills/agents/MCP. The graph is JSON in ONE column
  (`workflows.graph`), always loaded and saved as a whole. Node kinds: `trigger`, `start`, `instruction` (one turn), `condition`,
  `loop`, `parallel`, `ask`, `end`. The entry is optional (`entryNodeId`).
- **The driver sits on the server, not in the prompt** (`workflows/driver.js`): every instruction node is a turn of its own; after
  each successful turn the cursor advances at the same place the goal gate would act. Conditions and loop lists are judged by a
  small model — two attempts, then the run fails visibly instead of guessing. `parallel` = one turn with subagents. A question
  pauses the run (`status: waiting`); the next user message IS the answer. Context between steps is NOT in the prompt: every
  step is a turn of the same CLI session.
- **Round cap:** a cycle halts and ASKS. Visits are counted per node and loop iteration (`cursor.visits`); `maxVisits` on a step
  applies per cycle (default `CBASE_WORKFLOW_MAX_VISITS`, hard maximum 99), a step without its own value inherits the largest
  explicit cap of its cycle. The answer decides ("continue", "N more", "finish"); an unclear answer brakes. `capAuto` leaves the
  cycle through its first exit edge instead of asking, or ends the run if there is none. The step limit
  (`CBASE_WORKFLOW_MAX_STEPS`) stays the coarse backstop.
- **Edge sides are decided once and frozen** (`fromSide`/`toSide`); drawing only reads them. Meaningless for execution.
- **Runs are restart-fixed:** the cursor lives in `workflow_runs` (one row PER RUN, not per chat), and `resumeInterruptedWork`
  also resumes a run interrupted between two steps. `workflow_run_steps` is the append-only step log (the prompt is written BEFORE
  the turn, verdicts with the raw output of all attempts). A deleted chat does not take the history with it (`chat_gone`); the
  history is capped per workspace (`CBASE_RUN_HISTORY_CAP`).
- **Triggers start a workflow from outside** (GitLab): polled, not webhooks; the waterline is set to NOW when armed; events are
  de-duplicated by an event key; a cap that tears stays UNSEEN and is retried at the next tick. One lock per run (`workflow_locks`,
  scope `project` | `workflow` | `event` | `custom` | `off`) keeps two triggered runs out of the same working directory.
  Orphaned locks are reaped (`reapStaleLocks`). Details: `electron/server/workflows/README.md`.
- No `window.prompt` in `web/` — it throws in Electron; ask for names with `usePrompt()`.

### Workspaces, projects, context
- **Workspaces** are created with a path; the `.mcp.json` written into them gives manual `claude` calls the cbase tools. Removing
  never deletes the folder on disk. Skills are CRUD on the real `.claude/skills/` files.
- **Context Dumpster** (workspace context): free text is classified by `claude -p` into category/title/tags/summary → SQLite,
  searchable; Claude reads it via `cbase_workspace_context_search` (read-only).
- **Project context** (`project_context`): a fixed category set (`GET /api/project-context/schema`), any number of entries per
  category (title, markdown body, summary, tags, `valid_as_of`, `pinned`); `POST …/context/import-folders` reads
  `PROJECT_INFORMATION/` into it. The main model maintains it itself via `cbase_context_*`; only if it did not write during a
  project-chat run does a smaller curator model (`CURATOR_MODEL`) distil **suggestions** — nothing is applied automatically.
- **Chat-bound artifacts:** files under `data/artifacts/<chat-id>/<path>`; no metadata table (listing, MIME, size, SHA-256 come
  from the file system); writing is atomic, overwrite and delete require the previously read SHA-256; copied as a snapshot at
  chat fork. MCP access is confined to `CBASE_CHAT_ID` (`cbase_artifacts_list/read/write/delete`).
- **Instructions for agents:** sections per workspace and project, stored in the database (`store/instructions.js`) and carried
  into the system prompt of every main run, subagent and workflow agent (`workspaces/instructions-routes.js`, `toolchain/instructions.js`).
- **Apps and ports registry:** applications with services and ports across workspaces; ports are unique (409 with owner on
  collision); `GET /api/ports/running` scans natively by TCP connect against 127.0.0.1.

### Code viewer: download, upload, images
- Downloads are real anchor downloads (not fetch + blob) so the browser streams to disk. **Folders are zipped as a stream**
  (`server/zip.js`, dependency-free): data descriptors instead of up-front sizes, UTF-8 names and **ZIP64** as soon as a field no
  longer fits 32 bits (otherwise more than 65,535 entries silently give a broken archive). Symlinks leaving the folder are not
  delivered (`realpath` against the root), directory symlinks never; what was skipped is listed as `_CBASE-SKIPPED.txt` INSIDE the
  archive. `.git` stays out.
- Upload into a folder: `{dir, files:[{path, dataB64, append}]}` in ~3 MB chunks; `append` continues a large file; one function
  (`uploadFiles`) serves workspace and project level.
- Images are shown as a preview (`/files/read` → `{binary:true, image:true, mime}`, bytes via `…/files/download?inline=1`); SVG stays text.

## Where things live

Every folder under `electron/server/` has its own README (terms, the three questions, non-content, file map). The folder map:

| Folder | Holds |
|---|---|
| `server.js`, `store.js` | `startServer`, `ROUTES`, the dispatcher and hook registration; facade over `store/` (SQLite) |
| `runs/` | the run engine: do-run, queue, wait phase, auto-continue, limit gate, permissions, system prompt, resume |
| `chats/`, `workspaces/`, `projects/`, `settings/`, `account/` | chat, workspace, project, settings and account routes and rules |
| `workflows/`, `dynworkflows/`, `outerloop/`, `scheduled/` | graph workflows, dynamic (scripted) workflows, the outer loop, scheduled jobs |
| `channels/`, `communication/`, `agenda/`, `timeline/` | agent-to-agent channels and messages, per-chat agenda, timeline |
| `providers/` | Claude, Codex, OpenRouter adapters and the model catalog |
| `projectbox/` (+ `layout/`, `setup/`), `stacks/` | project containers, project setup and layout, stack copies |
| `devtools/`, `preview/`, `toolchain/`, `lsp/`, `gitView/` | browser/DevTools, preview links, toolchain and approval marks, language servers, git overview |
| `runtime/`, `store/` | HTTP/SSE serving, process watch, request origin and file access; the SQLite schema and per-topic store modules |
| `../mcp/` | the cbase MCP server, its tool groups (`tools/`) and the gate for external coding MCP servers |

```
headless.js               entry in the container: data folder, startServer
electron/server/          the server tree
electron/mcp/             cbase MCP server (stdio) and the airlock of coding MCP servers
test/                     the backend suites (gate: ./check)
Dockerfile, build.sh      image (stages base → projectbox → backend), build context
entry.sh, cbase-*         entry of the user container, wrappers and helpers in the image
```

The HTTP routes are documented next to the code that serves them (`routes.js` in each folder and its README); the MCP tool
catalog is pinned by `test/fixtures/mcp-catalog.snapshot.txt`.

## Tests

```bash
./check                                          # the gate (start it in the background, > 10 min) — never a bare node --test
cd server/backend && env -u NODE_TEST_CONTEXT CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 \
  CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000 CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 \
  node --test --test-reporter=tap test/workflow-locks-e2e.test.js   # one file, with the gate's deadlines
```

Kinds of tests, harnesses and rules: `test/README.md`. All tests drive the **real server** (`startServer` on port 0) against a
**fake CLI** and, where GitLab is involved, a fake GitLab server. Traps that cost time and are noted as comments in the files:

- A fake CLI must not decide by natural-language words: a word matched inside the judge prompt itself and made every condition
  answer "yes". Use unambiguous markers.
- The fake GitLab must return realistic paths (the project path of an event comes from `references.full`).
- `CBASE_WORKFLOW_MAX_STEPS` and `CBASE_WORKFLOW_MAX_VISITS` are read at module load; a test cannot change them.
- Tell prompt kinds apart by their opening sentence, not by keywords — the condition prompt embeds the step's last output.
- The auto-continue tests shield HOME and `security`; otherwise the Claude path would ask the developer's real account.

## Limits

- Subscription rate limits apply here too — meant for personal use.
- One run per chat at a time (further messages are queued).
