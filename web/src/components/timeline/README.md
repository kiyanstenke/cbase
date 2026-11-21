# `components/timeline/` — the timeline per project

What **really happened** in a project: entered solely by the timeline agent (outer loop), append-only on the server
(`server/backend/electron/server/timeline/`). A human reads, switches it on/off per project and dismisses — a human cannot
enter events. A human can also reword: "Edit …" (⋯ of the row and detail card) creates a new revision of title/text
(`RevisionSheet` in `TimelineRow.tsx`) — no new event, the old one stays unfoldable in the card. The card shows identifiers
in title/text as links (`chunks`, built by the server), the row "Links" (MR, commit, branch in GitLab/GitHub, "Git
overview" → Projects → Git with the branch as search) and the row "Agenda" (jump through `lib/agenda-jump.ts` into the
agenda of the chat). The evidence per agenda item is shown by `chat/AgendaPanel.tsx`.

| File | Content |
|---|---|
| `Timeline.tsx` | The component for BOTH places. Large in the tab "Timeline" of the project view (`projects/ProjectsPane.tsx`, list `PROJECT_TAB` in `projects/ProjectView.tsx`): kit `Header` with the project toggle (`Toggle`, `PUT …/timeline { active }`), filters kind (`Segments`), chat (`Menu`, the chats from the loaded pages) and tag (`Search`, Enter), "Load older" through `further`. `compact` in the section "Timeline" of the right chat rail (`chat/ChatRightSidebar.tsx`, button only for a chat with a project): without filters and toggle, below "Show all" → `showProjectTimeline` (`lib/project-jump.ts`). Newest on top, day dividers in the browser's wall time, rows separated by hairlines, no surface around the list. The stream `timeline` `{ projectId }` reloads (as many as are shown); only the latest request writes. |
| `TimelineRow.tsx` | One row as a time line: clock time right-aligned · round node with the kind symbol on the vertical line (per day from the first to the last node, two pieces per row — the line never lies under the node) · title; in the tab the citation below in small type. Collective event = node in the accent color, unfolds its parts (one level, smaller nodes on an own line); dismissed = dashed gray node, struck-through title. ⋯ (on hover) → "Dismiss …" opens `DismissSheet` (kit `Modal`, reason mandatory ≤ 500, server codes in words). |
| `TimelineCard.tsx` | The detail card on hover (`useTimelineCard`, timers of the commit card from `lib/git-card.ts`; click/Enter on the node shows it immediately, touch too): kind, full date, title, description (`text`), citation (button: main chat → row in the chat, subagent → "Background Tasks"), git anchor, tags, parts, dismissal reason. Through a portal on the body, no click catcher; position `lib/timeline-bar.ts timelineCardsSituation` (rail: to the left, tab: below/above the row). The citation lives here. |
| `TimelineForm.tsx` | ONE table kind → word + symbol (`KIND_FORM`, stroke of the coding pages, no emojis), the mark of the timeline itself (`TIMELINE_SYMBOL`, also tab and rail), day dividers (`byDays`, `dayWord`: Today · Yesterday · date), `clockTime`, `citationWord`, `subagentOf`, `anchorParts`. |

The pure computations of the time line (dimensions, line, role of the node, position of the card) are in
`lib/timeline-bar.ts`. The wire is in `lib/api/timeline.ts` (shape E with a default per field, `timelineError`).

Three questions:

- **Why is the section "Timeline" missing in the rail?** The chat has no project — the rail shows the button only with
  `gitProjectId`. A remembered section then shows the sentence instead of the list.
- **Why does the citation not jump exactly to the tool call?** Scrolling goes to the BUBBLE that carries the row (`data-row` =
  its first log row); a tool call stands in the response that began before it. A bubble that arose live does not know its row.
- **Why does the list show fewer chats in the chat filter after filtering?** It does not: the choice remembers every chat that
  ever appeared in a loaded page.

Not here: entering and collecting (only the agent, `mcp/tools/timeline.js`), the check of the citation (server).
Guard: `web/test/timeline-web.test.mjs`.
