# `timeline/` — the timeline per project

**What lives here:** the domain side of the timeline — what REALLY happened in a project, with evidence. Written solely by
the timeline agent (outer loop, `../outerloop/`) from its tools and the chat — no mechanical source; read by the agent and by
the human (web/iOS), by nobody else (no read tool in the coding catalog).

**Terms:**
- **Event** — kind (`code` · `git` · `test` · `communication` · `ops` · `other`), title, time (= time of the citation),
  citation, optional git anchor, tags, optional agenda item.
- **Citation** — the evidence: a tool call that succeeded ("executed", `tool`), otherwise a message ("reported", `message`).
  `row` = `messages.id` (the same as in `cbase_chat_analysis`), `from` = `''` (main chat) or `subagent:<id>`. A citation
  carries at most one event.
- **Collection** — an ordinary event with parts (one level); **dismissing** — a row that greys the event out.
- Everything is **append-only** (SQL triggers, `../store/timeline.js`); the only deletion path is the project.

| File | What | Called by |
|---|---|---|
| `routes.js` | `timelineRoutes` — sub-slice of `../projects/routes.js projectRoutes`: `GET/PUT …/timeline`, `POST …/timeline/:eid/dismiss`, `POST …/timeline/:eid/revision`, `GET …/timeline/proofs?chat=`, `GET/POST …/timeline/agent` | dispatcher |
| `agent.js` | the timeline agent's path: marker (`checkTimelineMarker`, 403 NO_RUN), switch (409 OFF), `enter`/`collect`/`dismiss`/`revise`, reading `search`/`event`; `isTimelineAgent` (the trait `timeline === true` on the agent); `reportTimeline` (SSE `timeline`) | `routes.js` |
| `check.js` | the checks with their codes: kind, citation, read tool, no evidence (cbase bookkeeping, role of the message, command of the user), failed, anchor (`../git.js commitInProject`, in the project container), duplicate, level, dismissing | `agent.js`, `routes.js` |
| `tool-index.js` | `toolIndex` and `readCitation` — tool calls of main chat AND subagents from `messages`, without what is no evidence (`isNoProof`) | `read.js`, `check.js` |
| `read-tools.js` | the tools that are no evidence: read tools (`READ_TOOLS`) and cbase's own bookkeeping (`INTERN_TOOLS`) — ONE computation `isNoProof` for index and check | `tool-index.js`, `check.js` |
| `revisions.js` | new revisions of title/text: ONE check for agent (`revise`, justification required) and human (`…/revision`), codes BODY/JUSTIFICATION/UNKNOWN/DISMISSED/UNCHANGED/TOO_MANY, caps from `check.js` | `agent.js`, `routes.js` |
| `references.js` | the links: remotes of the code repos through the file system (`../git.js readGitFile`, `remoteLocation` — the URL never leaves the file), repo of the anchor, GitLab/GitHub addresses, identifiers in title/text as chunks (`!n`, `#n`, "Pipeline #n", SHA; prefix only if unambiguous) | `read.js` |
| `read.js` | the event shape (`eventForms`; the effective revision with `revisions`, for the human `links`/`references`/`agendaItem`), `timelineList` (GET), `timelineProofs`, and for the agent: `timelineMostRecent`, `toolIndex`, `searchTimeline`, `timelineEvent` — ONE import path | `routes.js`, `agent.js`, `../outerloop/` |

**Where the subagents' calls live:** in the history OF THE CHAT — `../runs/agents.js underEvent` writes every `tool_use` of a
subagent as a row `tool` with `parent` (call block or `agent:<id>`) into `messages`, its result as `tool_result`. The block
becomes the agent id through the subagent records (`parentToolUseId`). `subagent_history` is the runtime's continuation store
(without `row`) and no citation; the agents of a dynamic workflow with its own sink do not write into the chat.

**What does NOT live here:** the tables with their triggers and the project's timeline switch (`../store/timeline.js`), the
deletion with the project (`../store/workspaces.js`), the agent itself — template, seed, waking, input, follow-up
(`../outerloop/`) —, its tools `cbase_timeline`/`cbase_timeline_write` (`../../mcp/tools/timeline.js`), the fence rows
`project-timeline-agent` and `project-timeline` (`../projectbox/fence-table.js`), the UIs (`web/`, `mobile/`).

**Three typical questions:**
- *Why does the server refuse an entry?* `check.js` — the response's `code` says which rule (file header); a call without a
  result is `FAILED` (unknown is no evidence), an anchor that cannot be checked `ANCHOR_UNCHECKABLE` (409).
- *Why is a push or merge missing?* Git events are recorded only by the timeline agent, and only if it sees them in the chat
  (Bash `git push`, `glab`/`gh`, a report in a message) — what happens outside the chats does not enter the timeline.
- *Why is an event not in the list?* It is part of a collection (the list shows only the top-level ones, the parts inside)
  or older than the page (`further`).

Guards: `server/backend/test/timeline.test.js`, `timeline-link.test.js` (revisions, links, proofs).
