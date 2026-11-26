# `agenda/` — the agenda per coding chat

**What lives here:** the domain side of the agenda. Every coding chat keeps exactly one: a short title, a description
(Markdown: goal, plan, context) and a TREE of items — each item a heading (≤ 80 characters) with a note (Markdown, ≤ 2,000),
a status `open` · `in_work` · `done` and sub-items of any depth; an item WITH sub-items has no status of its own, it is
computed from its leaves ("2/5"). Top-level items may carry a project of the workspace. If a chat pursues several
undertakings, the model makes one top-level item per undertaking (fixed sentence in the system prompt), otherwise the agenda
stays flat. It is written ONLY by the chat's main agent (MCP `cbase_agenda_write`) and read by it, its subagents of any
depth, the agents of its dynamic workflows, other chats of the same workspace (`cbase_agenda` with `chatId`/`list`) and the
human (right rail on the web, button `chat-agenda` on iOS). The UI edits nothing.

**Open, done, archive.** The agent reads by default only what is not finished (`?open=1`: a point stays if its COMPUTED
status is not done, filtered on the response so a kept parent keeps the done/total of its whole subtree; `hidden.done` counts
the finished leaves left out); the turn block does the same. The clients get the whole active tree and hide finished items
themselves (toggle "n done"). A finished subtree leaves the active tree with `archive` (main agent, any depth) or by the sweep
(`auto-archive.js`: top-level items finished for 7 days, hourly and once after the start; a subtree with `restoredAt` waits 7
days) and becomes ONE row of `chat_agenda_archive` (store/agenda.js) — written in the same transaction as the agenda.
`restore` brings it back to its old place (old parent, behind the old sibling; otherwise the end of the level or the top
level). The cap (500) counts the active tree only; the archive is unbounded.

| File | What | Called by |
|---|---|---|
| `operations.js` | PURE (no database, no clock): `applyOps(alt, input, now, { projects, archiveEntryOf, by })` — title, description and the operations `fresh`/`change`/`move`/`erase`/`arrange`/`archive`/`restore` on a copy (`archive` only on a computed-done subtree, a parent left childless gets `done`; the archive rows go out as `archive`/`restore` for the store); `openOnly`, `subtreeOf`, `searchAgenda` (read views) (target through `under`/`after`; `erase` takes the subtree and reports it in `deleted`; `status` on an item with sub-items is an error; `project` only on top-level items, id or name; a deleted project does not keep an item on top on `move`, it drops), the preorder checked after EVERY operation (`store.agendaPreorder`), all or nothing, `AgendaError` with one sentence for the model; `AGENDA_CAP` (title 120, description 8,000, items 500 in the active tree, text 80 — only for texts sent —, note 2,000; every error text names the cap and the number sent), `AGENDA_OPERATIONS`, `findProject` (id or name, case-insensitive — also for the read filter), `agendaCounter` and `nextStep` (leaves only), `onlyProject`, `agendaResponse` (the outgoing shape: preorder, `depth`, computed `status`, `subitems`, `done`/`total`, `project` at read time) | `routes.js`, tests |
| `change.js` | the ONE write path: `changeAgenda(chatId, workspaceId, input, { now })` — `applyOps` in ONE transaction (`store.agendaChange`), then the event `harness/agenda` (`sse(id, { type: "harness", subtype: "agenda", chatId, agenda })`), unless the computation gave the same state; response `{ agenda, unchanged, deleted, archived, restored, touched, fresh }` (`fresh` = the ids of the created items, `touched` = every point whose stored form changed — the tools answer with only these). `projectListOf(workspaceId)` (the projects for `project` on fresh/change; an unknown workspace is `null`, not "none"). It does NOT check WHO may write — that sits at the route; errors of the computation (AgendaError) and of the store (`code` chat_missing, no_agenda, archived) are thrown on | `routes.js` (PUT), `../workflows/gates.js` (the item "request review" of the review gate) |
| `routes.js` | `agendaChatRoutes` (sub-slice of `chats/routes.js chatRoutes`): `GET /api/chats/:id/agenda` (the chat's own; `?chatId=` another one by `communication/visibility.js:readableReason`, 403 with the reason; `?project=` only the subtrees of one project, response with `filter`, unknown 400; `?list=1` the overview, capped at `AGENDA_OVERVIEW_CAP` = 30 with `additional`/`hint`; `?open=1` only the unfinished points with `hidden`; `?point=<id>` one subtree, also from the archive), `GET /agenda/archive` (entries newest first, `before`/`limit`, `q` = search hits over active tree and archive with path), `PUT` (only `senderOf(…) === "coding"`, otherwise 403 with `role`; a chat without agenda 409; an error of the computation 400; archived 409; writes through `change.js:changeAgenda` — event and projects come from there), `POST /agenda/upkeep` (the agenda keeper, through `upkeep.js`) | dispatcher through `chats/routes.js` |
| `auto-archive.js` | the sweep: `dueForArchive` (pure) and `sweepAgendaArchive({ now })` through `changeAgenda` (originator `server`, `by: "auto"`); timers on the server run in `../server.js` | `../server.js` |
| `upkeep.js` | the agenda keeper's write path (below): `maintainAgenda(chat, body)` — body (400 `BODY`), run marker `checkUpkeepMarker` (403 `NO_RUN`), quiet `upkeepQuietReason` (409 `CHAT_WORKING` + `reason`), then WITHOUT await the transaction with originator "keeper" (codes from `operations.js AGENDA_UPKEEP_CODES`), then the silent hint `upkeepHintText` (source "agenda-keeper") | `routes.js` |

### The agenda keeper

A built-in outer-loop agent per workspace (seed, toolset, frame and abort at `turnStart` in `../outerloop/`) brings up to date
what the main agent forgets. It may ONLY: create items, set a LEAF's status forward, set title and description while they are
empty — never erase, move, arrange, or change text or note. Three writers share ONE transaction (`change.js:changeAgenda`,
`originator`): `main` (default, the PUT route), `server` (review gate, `../workflows/gates.js`), `keeper`. Against races:
- **Version instead of clock:** the keeper reads the `version` with `cbase_agenda` and sends it as `base`; if it differs in
  the transaction ⇒ 409 `STALE` (without the current number — it is to read again), nothing written.
- **Only in a quiet chat:** no turn (no compacting either), no queued input, no background work, no open question — checked
  right before the transaction with no `await` in between (`upkeep.js:maintainAgenda` stays synchronous); the same check
  (`upkeepQuietReason`) already holds back the start of a run (`../outerloop/run.js:keeperWaiting`).
- **Measured on the tree:** `fresh` only under an item that already has sub-items (`NO_SHEET`), and after all operations of
  a call no existing item goes backward in its computed status or onto its lock (`operations.js:recheckUpkeep`, `BACKWARD`
  or `REVERTED` — through sub-items too).
- **The ring stays:** the mark `upkeep` stays after every other writer; only a later change by the keeper replaces it. It
  goes out with `afterwards` = the outcome of the log row of THE SAME change (run, item, kind, time —
  `operations.js:upkeepAfterwards`; `open`/`confirmed`/`corrected`/`outdated`, outdated before the outcome; without a row
  `null` = unknown), read through `change.js:agendaView` (route, event, tool — the rows only if an item is marked,
  `store.agendaUpkeepHistory`). If the main agent changes only what a ring explains (the same status as the keeper), that is
  a new revision (`newRevision` on `store.agendaChange`: version + 1, event).
- **The main agent takes precedence:** it closes per open ROW: `status` `corrected` if the computed status lies below the
  row's `stage` (the keeper's), `fresh` only if the item is gone, otherwise `confirmed`; title/description only when it
  changes the field. When it sets the status, it locks, out of every STANDING row (open or confirmed), the lowest stage it
  fell below (`upkeepLock`, 409 `REVERTED`) until it sets that stage or a later one itself. If it sets the status to the stage
  of such a row or further, the row is OUTDATED (`outdated_at`, outcome unchanged): the stage is its own decision, the row
  never locks again — not even on a later reopening. A confirmation through text or note makes nothing outdated. The server
  closes nothing, locks nothing and outdates nothing. `upkeepLock` never goes out (`agendaResponse` emits only `upkeep` with
  `afterwards`, `null` without a mark).
- **Log:** `../store/agenda-upkeep.js` (table `agenda_upkeep` with `stage` and `outdated_at`, registration "agenda-upkeep"),
  written INSIDE the transaction; tally per agent and per run, the corrected rows for the keeper's frame. Goes with chat,
  workspace and agent; a fork copies no row — `store.copyAgenda` therefore drops the marks from the copy and keeps the locks
  (without rows in the fork, `afterwards` would stay unknown there forever).
- **The main agent learns of it** as a silent hint in the next turn (`../runs/hints.js`), never as a turn of its own.

Outside this folder:
- the data layer `../store/agenda.js` (table `chat_agenda`, ONE row per chat, the items as a flat JSON list in preorder —
  `parent` null = top level, an old row without the field is flat —, `next_seq` — ids are never reused —, `version`;
  `agendaPreorder` (the ONE rule: the reader repairs, `applyOps` checks) and `agendaTree` (the computed status, ONE version for
  response and turn block); `chatKeepsAgenda(chat)` = kind `normal` without a special role; `agendaChange` checks chat, kind
  and archive in ONE transaction; registration "chat-agenda" at the end of `../store.js`, read through the facade);
- the closing path `../chats/erase.js` (`store.deleteAgenda` in `tidyUp`, all seven deletion paths) and the fork
  `../runs/routes.js` (`store.copyAgenda` — state, ids and locks go along, the keeper's marks do not; afterwards each keeps
  its own);
- the run `../runs/agenda-block.js` (fixed sentence in the system prompt through `buildSystemPrompt(…, { agenda })`, the
  content as a fenced block `<cbase-agenda>` before the input of the first turn WITHOUT a resumed session — indented, two
  spaces per level, `- s3 [in_work 2/5] Text {Project: X}` —, never in the system prompt, never in the history);
- the MCP tools `../../mcp/tools/agenda.js` (LAST group in the catalog), their visibility in `../../mcp/visibility.js`
  (`alwaysLocked`, `WORKFLOW_AGENT_INDIVIDUAL`, `OUTER_LOOP_LOCKED`, `ONLY_CODING_MAIN_RUN`) and `../../mcp/offering.js`;
- the fence rows `chat-agenda`/`chat-agenda-write` in `../projectbox/fence-table.js`.

**Terms:**
- **Main agent** — the run of the coding chat itself, depth 0, without a profile, workflow or outer-loop marker. The MCP
  server sets the markers AFTER the model's arguments (`ofProfile`, `workflowAgent`, `outerLoop`).
- **Revision** — `version` counts every change; clients take only a NEWER one (load response and event cross each other).
- **Empty** — no title, no description, no step: no block in the turn, no entry in the overview, the empty state in the rail.

**Typical questions:**
- Why does a subagent not see `cbase_agenda_write`? → `../../mcp/visibility.js:VIEW_BY_DEPTH.alwaysLocked`; the server would
  answer 403 anyway (`routes.js`, `writeRefusal`). What should change belongs in its report.
- Why is the agenda not in the system prompt? → Cache: it changes almost every turn, and every change to the system prompt
  costs the cache of the whole history. The sentence is fixed, the content comes once as a block
  (`../runs/agenda-block.js:agendaPreamble`).
- Why does `change` refuse a status? → The item has sub-items: its status is computed from the leaves
  (`../store/agenda.js:agendaTree`), the leaves get checked off. Clients do NOT recompute it.
- Why 409 instead of 403 for a manager chat? → it keeps no agenda (kind), not "it may not"; `chatKeepsAgenda` is the ONE
  version of this question for route, prompt sentence and block.

**What does NOT live here:** the UI (`web/src/components/chat/AgendaPanel.tsx`, `chatAgenda.ts`, `web/src/lib/agenda.ts`,
`web/src/lib/api/agenda.ts`; iOS `mobile/CbaseMobile/Chat/AgendaSheet.swift`, `ChatViewModel+Agenda.swift`). Guards:
`server/backend/test/agenda.test.js` (computation, block, sentence, visibility on the real run kinds, main seam, run),
`web/test/agenda.test.mjs`.
