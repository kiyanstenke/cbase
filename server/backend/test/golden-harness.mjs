#!/usr/bin/env node
// Golden harness: records each scenario against the REAL server with the fake CLI (web/test/streams/fake-cli.cjs),
// four artifacts, normalized, under server/backend/test/fixtures/golden/<scenario>/:
//   sse.jsonl   all events of the global stream (GET /api/events) and the chat streams (GET /api/chats/:id/stream),
//               one block per stream in receive order, every line tagged `stream` ("global", "<chat-1>", ...)
//   db.json     the rows of ALL non-empty tables of the server DB after quiet, per table in rowid order
//               (FTS shadow tables excluded)
//   spawn.json  per fake-CLI spawn: kind (chat/oneshot), cwd, argv (with the full --append-system-prompt),
//               the parsed MCP config and every input (oneshot: the prompt; chat: every stdin row) - the
//               prompt BYTES are the proof
//   hooks.jsonl every firing of the hook register (runs/hooks.js observeHooks) in call order: hooks as
//               `{kind, name, index, wait, phase: "start"}` (an awaited hook additionally with `phase: "end"`),
//               switches as start/end with `takenOver`, plus the chat of the payload under its placeholder - the
//               ORDER of the consumers per scenario. The four boot kinds `restartGrace*` are left out:
//               resumeInterruptedWork runs 2.5 s after start on the wall clock (server.js), and whether a scenario
//               reaches that moment depends on its duration and the machine load - those lines would flutter
//               (the restart has its own test: restart-grace-hooks.test.js).
// The gate test server/backend/test/golden-runs.test.js re-records every scenario and compares byte-equal.
//
// Usage (by hand):
//   node server/backend/test/golden-harness.mjs                        all scenarios -> fixtures/golden/
//   node server/backend/test/golden-harness.mjs --only channel,schedule   a selection
//   node server/backend/test/golden-harness.mjs --target /tmp/x          elsewhere (flutter probe: three times, then diff -r)
//   node server/backend/test/golden-harness.mjs --target /tmp/roh --raw  UNnormalized - shows what the normalization absorbs
//
// Every scenario runs in its OWN child process (this file with --single): the server keeps state at module level
// (running chats, queues, limit timers, channel delivery marks, bell numbers), so in one process a scenario would
// depend on the previous one. The child gets the gate deadlines CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000
// (as tools/check/targets/check.mjs does).
//
// Same shell, same normalization and same fake CLI as the stream recorder of the composer split (web/test/streams/):
// ONE tool, two users - here extended by the DB page, the spawn log and the golden normalization rules. The server
// imports sit in `individual` (dynamic): the gate test imports this file only for `kind`, `FIXTURES` and `FILES`.
//
// -- Scenarios ------------------------------------------------------------------------------------------
// The fixtures are the truth; every recording prints its counts (`[golden] <name>: sse ... - db ... - spawn ... - hooks ...`).
// Each scenario takes seed and fake shape from the green backend test that already drives the path (in parentheses).
//   run            one message (chat-stream-join): connected, user_message, run_started, init, deltas, result, run_done;
//                  one chat process, argv with the full --append-system-prompt, one stdin row.
//   question       message -> cbase_ask -> POST /ask-answer (ask-card): ask_request BEFORE the tool_result, turn ends,
//                  ask_resolved, second run with resume; two processes, the second with --resume.
//   limit          the CLI dies on the limit wording (auto-continue): limit_line/limit_wait, after the booked reset
//                  (2 s gate deadline) run_started WITHOUT session, answer; two bells globally; two processes.
//   channel        two coding chats in a channel, message #2 DURING turn #1 (channel.test.js): two chat streams
//                  (<chat-1> coding, <chat-2> counterpart): channel_message, run_started, run_done, (hook "ende" ->
//                  "channel-delivery"), second turn, cbase_agent_send through the real MCP server, run of the
//                  counterpart (occasion channel); three coding processes.
//   workflow       graph Start -> Work (completion gate) -> After -> End (workflow-engine-e2e): workflow_step/workflow_run
//                  around every turn, three turns; workflow_run_steps 6 (verdict "the report is missing", then "done");
//                  five spawns - chat, gate oneshot (short argv, prompt on stdin), chat, oneshot, chat.
//   subagent       cbase_agent through the real MCP server (native-agent-e2e): background (started, done) with agentId
//                  <agentrun-1>, tool_result with the report; two spawns - main chat and the subagent with
//                  "SUBAGENT of cbase" (short argv, no --append-system-prompt of the main chat's length).
//   subagent-background the main agent starts a subagent without run_in_background and ends its turn (run_done while the
//                  subagent lives); its completion notice becomes a run of its own; three processes.
//   graph-start    graph workflow through `/workflow:<name>`: the start turn calls cbase_workflow_start, the workflow begins at
//                  the turn end and its only step is a turn of its own; graph_starts "gestartet" with run_id.
//   schedule       scheduled job, "run now" (scheduled-run.test.js): the chat is created with the job, its stream is open:
//                  user_message "Geplanter Lauf ..." then turn; global: geplant (created, running, ok), notice kind
//                  schedule; scheduled_jobs, scheduled_runs; one coding process with the block "# Geplanter Auftrag dieses
//                  Chats" and its instructions in the system prompt.
//   targetGate     PUT /api/autocompact 60 %, chat with a goal, first turn 150,000 input tokens (autocompact.test.js):
//                  run_done, compacting, compacted, goal_check (open), run_started without resume, run_done, goal_check
//                  (reached); five spawns - chat, compact oneshot, goal oneshot, chat, goal oneshot.
//   ingest         POST .../context/ingest { target: "workspace" } -> coding chat + job (projects/coding-jobs.js), first
//                  message = job + file path: built-in Read tool + text; one process WITHOUT a run-kind prompt.
//   curate         project chat, CURATOR_ENABLED=1, UNTITLED, message #2 as above. MEASURED: the title oneshot of a normal
//                  chat starts at the message route (BEFORE the run, condition title === "New chat"); maybeAutoTitle
//                  after the run is a no-op there. FIVE spawns in spawn order - title oneshot, chat, curator oneshot, chat
//                  --resume, curator oneshot; context_suggestions 2 (pending), chats titled=1; curator_suggestions x2,
//                  title, message_queue.
//   schedule-limit scheduled run by hand, the CLI dies at the limit (role `limit`), the slot parks (run row, run line
//                  "open"), DELETE /auto-continue discards it (scheduled-run-end (3)): hooks turnStart/geplant ->
//                  beforeRunBroadcast/scheduled-end (parked: no run end) -> ende -> afterLimitCancel/scheduled-end ->
//                  afterLimitCancel/workflow-end; scheduled_runs "abgebrochen", pending_resumes empty; ONE process.
//   scheduled-approval the job's chat in permission mode "default" (scheduled.test.js (4)): the ONLY chat process with
//                  --permission-mode default and --permission-prompt-tool mcp__cbase__cbase_permission_prompt; permission_request,
//                  notice "freigabe" (beforePermission/"scheduled-approval"), POST .../permission-decision, approval_ruling,
//                  permission_resolved, run "ok" with message; the scenario reads the bell after the decision
//                  (afterPermission/"scheduled-approval" resolves the notice without an event). Counter-proofs:
//                  permissionPromptTool hard off (runs/do-run.js) => spawn.json red; scheduledApprovalRuling without effect
//                  => "the approval notice is not resolved after the decision".
//   scheduled-dismissed the human holds the job's chat with an own turn (mark), "run now" queues the slot, DELETE
//                  .../message/queue/:id discards it (scheduled-run.test.js (2)): the only firing of inputDismissed/"geplant";
//                  geplant "eingereiht" -> "verworfen", message_queue with and without the slot; scheduled_runs "verworfen"
//                  with entry_id; ONE process (the slot never starts). Counter-proof: scheduledInputDismissed without
//                  effect => deadline (the run never reaches "verworfen").
//
// The tick is parked (CBASE_SCHEDULE_TICK_MS = 1 h, the tick of Geplant): what runs, runs through the manual routes -
// otherwise the recording would hang on the clock. All seeded chats (also the chat of a scheduled job, from creation)
// are titled BEFORE the first turn (no auto-title oneshot whose event would land before or after run_done depending on
// process start - same decision as the web recorder), EXCEPT curate: there the title oneshot is meant to run, and the
// fake CLI holds its answers at marks (curator -> title -> follow-up turn) so the event order stands while the server
// starts the spawns concurrently. The harness counts their order at the server's spawn() call (countSpawns).
//
// Without evidence carrier stay restartGraceAbandoned and chatClosed "geplant" (the restart runs on the wall clock, see
// hooks.jsonl above; no scenario deletes a chat). Also unseen: audit and curating in ONE run (a project chat has no
// audit) - the registration order of that pair has no evidence carrier (hook trace, see hooks.js).
//
// -- Normalization: the golden rules (RULES below) on top of the web rules ------------------------------
//   ids        known ones by role (<chat-N>, <ws-1>, <channel-1>, <workflow-1>, <workflow-run-1>, <job-1>, <project-N>,
//              <service-N>), all others <id-N>; the subagent id `a<8 hex>-<seq>` -> <agentrun-seq>.
//   times      epoch numbers also INSIDE strings (prompt bytes, JSON columns) -> <t>; the snake_case time columns of the
//              DB -> "<t>"; the situation block "YYYY-MM-DD HH:MM UTC" -> <situation>; wall-time texts of the schedule or
//              scheduled run ("Mi 17.09.2026 08:00", "Mi 17.09") -> <walltime>.
//   paths      the node binary -> <node>, the root of this working tree -> <repo>, as an `upfront` rule BEFORE all others,
//              also before the ids (a UUID in the working-tree path would otherwise become <id-1>, see machinePaths below).
//   durations  durationS/duration_ms/durationMs/totalDurationMs -> "<ms>" (also the fixed 1234 of the fake CLI).
//   hashes     ingest_landing.payload_sha256 -> "<sha256>" (the payload carries the workspace id).
//   DB cells   strings with JSON are parsed, normalized, re-serialized; BLOBs -> "<blob N B>".
// Deliberately NOT normalized: token counts, num_turns, bell numbers, rowid order, the ids of the fake blocks (msg_N,
// toolu_...).
//
// -- Flutter probe: record three times in a row, `diff -r` pairwise EMPTY; without normalization (--raw) many rows flutter
// (payload_sha256, the subagent id with totalDurationMs, workflow_run_steps.duration_ms were found only by the probe).
//
// -- Re-recording means ... ------------------------------------------------------------------------------
// ... setting the promise "this is how the server behaves" to a new state. The way: READ the `git diff` of the fixtures
// (every line is a behavior difference or a gap of the normalization), then
// `CBASE_GOLDEN_RECORD=1 ... node --test server/backend/test/golden-runs.test.js` (or this script without --target).
// Never to turn a red test green (snapshots are an alarm). Sabotage probes: `chatEvent("end", ...)` commented out in
// runs/do-run.js => exactly `channel` red ("event did not come ...: run_started (2) in the coding chat - the delivery after
// the run end"); `curateAfterRun` off => exactly `curate` red ("curator_suggestions (the curator suggested)").
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SCENARIOS } from "./golden-scenarios.mjs";
import { readJsonl as readJsonlValue } from "./jsonl.mjs";
import { GLOBAL, streamBarrier, waitForQuiet } from "./quiet.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ITSELF = fileURLToPath(import.meta.url);
export const FIXTURES = path.resolve(here, "fixtures", "golden");
export const FILES = ["sse.jsonl", "db.json", "spawn.json", "hooks.jsonl"];
// No fixed settle time after idle: the last events (bell, run end in the global stream, the usage_events row from
// the setImmediate) arrive "right after run_done". Instead two questions with one answer each instead of a duration
// (quiet.mjs): QUIET (the server does nothing on its own anymore - titles, curator, verdicts, oneshots included) and per
// stream the BARRIER (the reader has everything written up to then). The barrier mark does not enter the recording
// (web/test/streams/server.mjs openStream: `markers`).
// Deadline per scenario in the child process - the limit scenario waits out the booked reset (2 s + grace). 42 s so
// that all hanging scenarios in series stay under the 900 s deadline of the gate; the longest scenario (limit) needs
// about 5 s, a child that lives longer hangs in the product. The scenarios themselves wait WITHOUT a deadline
// (web/test/streams/server.mjs, server-harness.mjs; an `ms` in golden-scenarios.mjs is no longer read): this deadline
// is their emergency brake, and what a hanging scenario waited for is printed as a "[waiting] ..." line on the child's stderr.
const DEADLINE_MS = 42_000;

// -- The two paths that pin the MACHINE --------------------------------------------------------
// The MCP configuration of every run carries two absolute paths (toolchain/mcp-config.js -
// `{ command: process.execPath, args: [MCP_SCRIPT] }`), and both appear in EVERY spawn.json: the node binary and the
// script mcp/cbase-mcp.js, the latter with the root of THIS working tree. Measured on a CI runner: every scenario red
// with "spawn.json differs from the fixture" at the node path; the second path would have done the same three lines later.
// WHICH node binary starts the MCP server says nothing about cbase. WHICH script it starts does - so only the root
// falls away: "<repo>/server/backend/electron/mcp/cbase-mcp.js" stays readable and would turn red if the server ever
// started another script. Both rules apply on BOTH ways, because recording and comparing run through the same
// normalization (individual() writes, golden-runs.test.js compares the written bytes).
const REPO_ROOT = path.resolve(here, "..", "..", "..");
// Longest first - otherwise a prefix eats the rest; the realpath form comes along because a path shows up resolved or
// unresolved depending on the way (/var is a link to /private/var on macOS).
function machinePaths() {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const all = [];
  for (const [filePath, placeholder] of [[process.execPath, "<node>"], [REPO_ROOT, "<repo>"]]) {
    for (const form of new Set([filePath, real(filePath)])) all.push([form, placeholder]);
  }
  return all.sort((a, b) => b[0].length - a[0].length)
    .map(([form, placeholder]) => [new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), placeholder]);
}

// -- The golden rules of the normalization (on top of the web rules, see normalize.mjs) --
// Each one at a measured source of flutter.
const RULES = {
  // Time columns of the DB (snake_case) and further time keys in JSON columns - number > 0 -> "<t>".
  // (Epoch numbers in the range 2020-2033 are hit by the number rule anyway; the keys are the second safety.)
  timeKey: ["created_at", "updated_at", "started_at", "ended_at", "due_at", "resets_at", "wakeup_at", "resolved_at",
    "last_run_at", "next_at", "retry_at", "scheduled_at", "memory_at", "endedAt", "scheduledAt", "lastRunAt", "nextAt", "retryAt", "memoryAt", "lastTick", "lastCycle", "since", "until", "from"],
  // Durations (measured, not sent): step rows of the workflows, the subagent report (totalDurationMs).
  // `duration_ms` also hits the fixed 1234 of the fake CLI in the result event - acceptable, one rule.
  msKey: ["ms", "durationMs", "duration_ms", "durationS", "duration", "duration_ms", "durationMs", "totalDurationMs"],
  // A hash over volatile payload: ingest_landing.payload_sha256 also covers the workspace id.
  replacement: { payload_sha256: "<sha256>" },
  // The node binary and the root of this working tree (see above) - BEFORE all built-in rules, also before the id table
  // (normalize.mjs `upfront`): placed after it, a working tree under a folder with a UUID (worktrees under a scratch
  // directory) would turn the UUID in the path into <id-1> before the root is found - every scenario red at
  // "<repo>/server/backend/electron/mcp/cbase-mcp.js", and every further id shifted by one number.
  upfront: machinePaths(),
  texts: [
    // The id of a native subagent (providers/agent-runtime.js: `a${uuid.slice(0, 8)}-${++seq}`) - it appears in the
    // report, the agent bar, the path of its MCP config and the profile key.
    [/\ba[0-9a-f]{8}-(\d+)\b/g, "<agentrun-$1>"],
    // The cbase_agent report is JSON INSIDE a string (tool_result content) - the duration in it is reached by no key
    // rule, only by a text pattern.
    [/"totalDurationMs": \d+/g, '"totalDurationMs": "<ms>"'],
    // The same duration in the completion notice (runs/completionNotice.js): XML inside a string.
    [/<duration_ms>\d+<\/duration_ms>/g, "<duration_ms><ms></duration_ms>"],
    // The project situation at the turn (manager.js situationBlock): "2026-09-17 10:12 UTC"
    [/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g, "<situation>"],
    // Wall time of the schedules (cron.js wallTimeText, in the UI language): "Mi 17.09.2026 08:00", "Mi 17.09", "Wed 17/09/2026 08:00"
    [/\b(?:Mo|Di|Mi|Do|Fr|Sa|So) \d{2}\.\d{2}(?:\.\d{4})?(?: \d{2}:\d{2})?\b/g, "<walltime>"],
    [/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{2}\/\d{2}(?:\/\d{4})?(?: \d{2}:\d{2})?\b/g, "<walltime>"],
    // Wall time without weekday in lists of the MCP server ("created"): "2026-09-17 10:12"
    [/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/g, "<walltime>"],
    // The identifier per compaction on the history roles (runs/compaction-baseline.js historyFrame - random, so foreign
    // text does not know it): "[User·3f973b]" and "with the identifier 3f973b:".
    [/·[0-9a-f]{6}\b/g, "·<identifier>"],
    [/with the identifier [0-9a-f]{6}:/g, "with the identifier <identifier>:"],
  ],
  epochInText: true,
};

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
// The spawn log is written by the fake CLI, a child process - only completed lines (jsonl.mjs).
const readJsonl = readJsonlValue;

// -- DB rows: all non-empty tables, per table in rowid order ------------------------------
// Excluded: sqlite_*, the FTS5 tables with their shadows (_fts, _fts_data, _fts_idx, _fts_content, _fts_docsize,
// _fts_config) - their content is a function of the working tables. BLOBs are noted as a length: an embedding is no
// readable proof, its presence is.
// Columns that only a COPY of the stacks fills (project container stage 2): without a copy they stand empty, and the
// fixture should then stay byte-equal without a re-recording. When EMPTY the column is left out; if a golden run ever
// carried a value it would be in the fixture. Counter-proof: `COPY_COLUMNS = {}` => golden-runs.test.js "graph-start" red.
// `usage_events.cost_usd`, `.upstream_provider`, `.generation_id`, `.cost_origin`: only a provider that reports costs
// (OpenRouter) fills them - no golden scenario runs through it; left out when empty so that the fixtures with
// usage_events stay byte-equal. `chats.archive_reason`, `.restored_at`: only archiving and restoring fill them - no
// golden scenario archives. `chats.job_id`: only a scheduled job fills it. Counter-proof for each: the entry removed =>
// golden-runs.test.js red at every scenario with such a row. The two other usage columns (`cache_read`/`cache_write`)
// and `agent_id` on the subagent row are by contrast a statement of EVERY booking and stand in the fixtures.
const COPY_COLUMNS = { graph_starts: ["instance"], usage_events: ["cost_usd", "upstream_provider", "generation_id", "cost_origin"], chats: ["archive_reason", "restored_at", "job_id"] };
// Columns that are NOT NULL with a default other than "" and that only a path fills which no golden scenario takes: left
// out WITH the DEFAULT value (not with "" or null - 0 is a statement there, `usage_events.cost_usd` 0 a reported amount,
// hence a table of its own with the value per column). `chats.effort_own`: only a PATCH with a new grade sets 1 - no
// scenario picks one; without the entry every fixture would carry `"effort_own": 0` per chat. `chats.goal_paused`: only a
// PATCH with `goalPaused: true` sets 1 (the scenario "targetGate" sets a goal, the judge clears it with pause 0).
// Counter-proof: the entry removed => golden-runs.test.js red at every scenario (each has a chat row).
const DEFAULT_COLUMNS = { chats: { effort_own: 0, goal_paused: 0 } };
function dbRows(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map((r) => r.name).filter((n) => !/_fts(?:_|$)/.test(n));
  const out = {};
  for (const t of tables) {
    let rows;
    try { rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all(); } catch { continue; }
    if (!rows.length) continue;
    out[t] = rows.map((r) => {
      const z = {};
      for (const [k, v] of Object.entries(r)) {
        if (COPY_COLUMNS[t]?.includes(k) && (v === "" || v === null)) continue;
        if (DEFAULT_COLUMNS[t] && Object.hasOwn(DEFAULT_COLUMNS[t], k) && v === DEFAULT_COLUMNS[t][k]) continue;
        z[k] = v instanceof Uint8Array ? `<blob ${v.byteLength} B>` : v;
      }
      return z;
    });
  }
  return out;
}

// -- Spawn log: the fake-CLI lines into one entry per process ----------------------------------
// Order = order of the SPAWNS: every process writes its start line only after its boot - two concurrently started
// oneshots (curator and title in the scenario curate) would come in file order, sometimes one way, sometimes the
// other. The server process counts itself (countSpawns below): every pid gets the running number of its spawn() call, and
// the sort uses THAT - a pid counter wrap is no question anymore.
// Inputs are parsed as JSON when they are JSON (the stream-json lines of the server), otherwise raw - so the
// normalization applies inside them.
function spawnEntries(rows, tally) {
  const processes = [];
  const open = new Map(); // pid -> entry (the latest start of this pid)
  for (const z of rows) {
    if (z.kind === "start") {
      const e = { genus: z.genus, cwd: z.cwd, argv: z.argv, mcpConfig: z.mcpConfig, inputs: [], pid: z.pid };
      processes.push(e);
      open.set(z.pid, e);
      continue;
    }
    const e = open.get(z.pid);
    if (!e) continue;
    if (z.kind === "prompt") e.inputs.push({ prompt: z.prompt });
    else if (z.kind === "input") {
      let json = null;
      try { json = JSON.parse(z.row); } catch { /* roh */ }
      e.inputs.push(json && typeof json === "object" ? json : { raw: z.row });
    }
  }
  // By spawn number; the pid itself stays out (it differs per run).
  return afterSpawnTally(processes, tally).map(({ pid, ...e }) => e);
}

// The spawn count in the server process (the golden child): `child_process.spawn` is wrapped BEFORE the server import and
// `syncBuiltinESMExports()` updates the ESM bindings - `import { spawn } from "node:child_process"` in
// providers/connectors/claude.js sees the wrapper afterwards (measured on Node 22.17: even a binding imported BEFORE
// the wrapper points to it after the update; execFile calls past the export internally and does not count - the server
// starts the fake CLI only through spawn). The wrapper changes nothing about the call: same arguments, same child back.
// Returns pid -> list of spawn numbers (a list in case a pid is reissued within a scenario; the k-th start line of a pid
// takes the k-th number).
function countSpawns() {
  const cp = createRequire(import.meta.url)("node:child_process");
  const tally = new Map();
  let seq = 0;
  const original = cp.spawn;
  cp.spawn = function spawnCounted(...args) {
    const kind = original.apply(this, args);
    seq += 1;
    if (kind?.pid) tally.set(kind.pid, [...(tally.get(kind.pid) || []), seq]);
    return kind;
  };
  syncBuiltinESMExports();
  return tally;
}

// The processes (in order of their start lines, per `pid`) by their spawn number. A pid without a number THROWS: then a
// fake process did not come through the server's spawn(), and any order would be a guess.
export function afterSpawnTally(processes, tally) {
  const open = new Map([...tally].map(([pid, numbers]) => [pid, [...numbers]]));
  return processes.map((p) => {
    const seq = open.get(p.pid)?.shift();
    if (seq === undefined) throw new Error(`spawn log: pid ${p.pid} has no spawn number - the process did not come through the server's child_process.spawn`);
    return { p, seq };
  }).sort((a, b) => a.seq - b.seq).map(({ p }) => p);
}

// -- Child: record ONE scenario -------------------------------------------------------------
export async function individual(name, target, { raw = false } = {}) {
  const sz = SCENARIOS.find((s) => s.name === name);
  if (!sz) throw new Error(`unknown scenario: ${name}`);
  // The scenario environment BEFORE the server import: switches like CURATOR_ENABLED are read by settings/agent-models.js
  // when the module loads, not at start (withStreamServer sets them once more - for everything read at run time).
  for (const [k, v] of Object.entries(sz.env || {})) process.env[k] = v;
  // The spawn count BEFORE the server import (see countSpawns).
  const spawnTally = countSpawns();
  const { withStreamServer } = await import("../../../web/test/streams/server.mjs");
  const { newTable, normalize, normalizeJsonText } = await import("../../../web/test/streams/normalize.mjs");
  // The NAMESPACE, not `{ db }`: `db` is a `let` binding that initStore sets only at server start - destructured it
  // would be the value of NOW (undefined), through the namespace it is the live binding.
  const store = await import("../electron/server/store/db.js");
  // The observer of the hook register BEFORE server start: hooks.js is a leaf without imports, the same module instance as
  // the server's; `payload` is asked only for the chat - ids come later through the normalization (the hooks lines are
  // normalized LAST so they take no number from the <id-N> placeholders of the three other files).
  const { observeHooks } = await import("../electron/server/runs/hooks.js");
  const hooksRaw = [];
  // The four boot kinds stay out (wall clock, see header); everything else fires from the scenario itself.
  observeHooks((info, payload) => {
    if (info.kind.startsWith("restartGrace")) return;
    hooksRaw.push({ ...info, chat: payload?.chat?.id ?? payload?.chatId ?? "" });
  });
  await withStreamServer(name, async (ctx) => {
    // The global stream FIRST: it should see everything the scenario triggers (also chat_title).
    const global = await ctx.stream(`${ctx.base}/api/events`);
    await global.waitFor((e) => e.type === "init", { what: "init des globalen Stroms" });
    const seed = await sz.seed(ctx);
    const chats = {};
    for (const id of seed.chats) {
      chats[id] = await ctx.stream(`${ctx.base}/api/chats/${id}/stream`);
      await chats[id].waitFor((e) => e.type === "harness" && e.subtype === "connected", { what: `connected (${id})` });
    }
    const szCtx = { ...ctx, ws: seed.ws, chats, global, seed };
    // A failure in the run (a deadline expires - e.g. in the sabotage probe) writes the files ANYWAY so that one sees what
    // happened up to then; the child ends red afterwards.
    let error = null;
    let after = {};
    try {
      after = (await sz.run(szCtx)) || {};
      await ctx.waitForIdle();
      if (sz.quiet) await sz.quiet(szCtx);
    } catch (e) { error = e; }
    // Quiet, then the barrier per stream (instead of a fixed settle time). After a failure no quiet - the server may hang on
    // what the scenario failed at, and the files should be written anyway - but the barrier yes: it needs only a living
    // server, and the recording then shows everything up to here.
    if (!error) await waitForQuiet(ctx.base);
    await streamBarrier(global, GLOBAL);
    for (const id of seed.chats) await streamBarrier(chats[id], id);

    // Placeholders by role: workspace, the seeded chats (<chat-1>, <chat-2>, ...), what the seed and the run otherwise named.
    // All other ids become <id-N> in order of first appearance - in THIS file order: sse (global, then the chats), db, spawn.
    const known = { ...(seed.known || {}), ...(after.known || {}) };
    seed.chats.forEach((id, i) => { if (!known[id]) known[id] = `<chat-${i + 1}>`; });
    const table = newTable({ workspaceId: seed.ws?.id || "", root: ctx.root, base: ctx.base, known, rules: RULES });
    const norm = raw ? (e) => e : (e) => normalize(e, table);
    // DB cells: a string with JSON (history `text`, cursor, detail, settings) is normalized as JSON - otherwise ids and times
    // INSIDE it would get no placeholder.
    const normRow = raw ? (z) => z : (z) => {
      const out = normalize(z, table);
      for (const [k, v] of Object.entries(z)) {
        if (typeof v !== "string") continue;
        const json = normalizeJsonText(v, table);
        if (json !== null) out[k] = json;
      }
      return out;
    };
    const streamName = (id) => (known[id] || id);
    const rowsValue = [];
    for (const e of global.events) rowsValue.push({ stream: "global", ...norm(e) });
    for (const id of seed.chats) for (const e of chats[id].events) rowsValue.push({ stream: streamName(id), ...norm(e) });
    const dbRaw = dbRows(store.db);
    const dbNorm = {};
    for (const [t, rows] of Object.entries(dbRaw)) dbNorm[t] = rows.map(normRow);
    const spawnRaw = spawnEntries(readJsonl(ctx.spawnLog), spawnTally);
    const spawnNorm = spawnRaw.map((e) => norm(e));
    const hooksNorm = hooksRaw.map((e) => norm(e));

    const folder = path.join(target, name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "sse.jsonl"), rowsValue.map((z) => JSON.stringify(z)).join("\n") + "\n");
    fs.writeFileSync(path.join(folder, "db.json"), JSON.stringify(dbNorm, null, 2) + "\n");
    fs.writeFileSync(path.join(folder, "spawn.json"), JSON.stringify(spawnNorm, null, 2) + "\n");
    fs.writeFileSync(path.join(folder, "hooks.jsonl"), hooksNorm.map((z) => JSON.stringify(z)).join("\n") + (hooksNorm.length ? "\n" : ""));
    const dbCount = Object.values(dbRaw).reduce((n, rows) => n + rows.length, 0);
    console.error(`[golden] ${name}: sse ${rowsValue.length} · db ${dbCount} rows in ${Object.keys(dbRaw).length} tables · spawn ${spawnRaw.length} · hooks ${hooksRaw.length}${error ? " — INCOMPLETE (error below)" : ""}`);
    if (error) throw error;
  }, { role: sz.role || sz.name, env: sz.env || {}, prefix: "cbase-golden" });
}

// ── parent: one child per scenario ──────────────────────────────────────────────────────────────
// Returns { code, ms, stderr } - stderr for the gate test so that a red scenario names its reason
// ("event did not come (30000 ms): run_started (2) in the coding chat ..."), not just "exit 1".
export function kind(name, target, { raw = false, stderr = "inherit" } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [ITSELF, "--single", name, "--target", target, ...(raw ? ["--raw"] : [])], {
      stdio: ["ignore", "ignore", stderr === "inherit" ? "inherit" : "pipe"],
      // The gate deadlines of the test bench (tools/check/targets/check.mjs): otherwise the limit scenario would wait 45 s of
      // grace + 20 s minimum wait. And NO embedding model: locally the server loaded the model from the transformers cache and
      // wrote a vector, a machine without a model cache wrote null - the fixture could be byte-equal on only one of the two.
      // The golden proof concerns the RUN, not the model; the model has its own tests. "Offline" alone does not suffice (the
      // cache applies anyway, measured): a model name that exists nowhere fails equally on every machine - and offline so that it
      // does not try the network first.
      // The main agent waits at cbase_agent at most as long as this knob says (0 in production): the scenario "subagent" is
      // recorded with waiting, without the value its result would hang on the shell the run is started from.
      env: {
        ...process.env,
        CBASE_LIMIT_GRACE_MS: "2000", CBASE_LIMIT_MIN_WAIT_MS: "2000",
        CBASE_MAIN_AGENT_WAIT_MS: "3600000",
        // Chat browser and OpenRouter fetch off: otherwise the recording hangs on the shell the run is started from (without the
        // switch every turn starts a real headless Chrome, the child runs into the deadline and records differently).
        // The gate sets both anyway (tools/check/targets/check.mjs).
        CBASE_CHAT_BROWSER_OFF: "1", CBASE_OPENROUTER_OFFLINE: "1",
        CBASE_EMBED_OFFLINE: "1", EMBED_MODEL: "cbase/no-model-in-golden-run",
      },
    });
    let err = "";
    child.stderr?.on("data", (d) => { err += d.toString(); });
    const timer = setTimeout(() => { err += `\n[golden] ${name}: deadline ${DEADLINE_MS} ms expired - killing child`; child.kill("SIGKILL"); }, DEADLINE_MS);
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code: signal ? 128 : (code ?? 1), ms: Date.now() - t0, stderr: err }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, ms: Date.now() - t0, stderr: err + String(e) }); });
  });
}

const countLines = (file) => { try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length; } catch { return "-"; } };
const countDb = (file) => { try { const d = JSON.parse(fs.readFileSync(file, "utf8")); return Object.values(d).reduce((n, r) => n + r.length, 0); } catch { return "-"; } };
const countSpawn = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")).length; } catch { return "-"; } };

async function all() {
  const only = (argValue("--only") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const target = path.resolve(argValue("--target") || FIXTURES);
  const raw = process.argv.includes("--raw");
  if (raw && target === FIXTURES) { console.error("--raw only with --target: the fixtures in the tree stay normalized"); process.exitCode = 2; return; }
  const selected = only.length ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;
  const unknown = only.filter((n) => !SCENARIOS.some((s) => s.name === n));
  if (unknown.length) { console.error(`unknown scenarios: ${unknown.join(", ")} (known: ${SCENARIOS.map((s) => s.name).join(", ")})`); process.exitCode = 2; return; }
  const result = [];
  for (const sz of selected) result.push({ name: sz.name, ...(await kind(sz.name, target, { raw })) });
  console.log(`\nRecording to ${target}`);
  for (const e of result) {
    const o = path.join(target, e.name);
    console.log(`  ${e.code === 0 ? "ok " : "RED"} ${e.name.padEnd(14)} sse ${String(countLines(path.join(o, "sse.jsonl"))).padStart(3)} · db ${String(countDb(path.join(o, "db.json"))).padStart(3)} · spawn ${String(countSpawn(path.join(o, "spawn.json"))).padStart(2)} · hooks ${String(countLines(path.join(o, "hooks.jsonl"))).padStart(2)} · ${(e.ms / 1000).toFixed(1)} s`);
  }
  console.log(`  total ${(result.reduce((n, e) => n + e.ms, 0) / 1000).toFixed(1)} s`);
  if (result.some((e) => e.code !== 0)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === ITSELF) {
  const individualName = argValue("--single");
  if (individualName) {
    individual(individualName, path.resolve(argValue("--target") || FIXTURES), { raw: process.argv.includes("--raw") }).catch((e) => {
      console.error(`[golden] ${individualName}: ${e?.stack || e}`);
      process.exitCode = 1;
    });
  } else {
    all().catch((e) => { console.error(e?.stack || e); process.exitCode = 1; });
  }
}
