# `components/git-bar/` — building blocks of the git bar

The git bar itself is `components/GitSidebar.tsx` (chat bar, panel 280–640 px, and the 272 px column of the code tab; sections in the style
of the VS Code Source Control view). This folder holds its parts that carry a file of their own.

| File | What |
|---|---|
| `GitGraph.tsx` | The content of the "Graph" section: all local and remote branches and tags in one graph (or only HEAD with its upstream). One 22 px row per commit with an SVG strip (lanes, forks, merge curves; HEAD a hollow ring, a merge a ring with a core), subject, author, ref badges, "+n" when tight. Plus `useGraphExtent` (the choice "All" / "Current Branch", localStorage `cbase-git-graph-extent`) and `GraphExtentChoice` (the choice button in the section header). A click EXPANDS a commit: below it one indented row per changed file (icon by file type, name, folder dimmed, status letter in the colors of "Changes", deleted struck through), beside it all lanes run through, the own one as a bar from the dot to the last file row. Several commits may be open at once; the list is fetched on first expand and kept per hash (after an error or "unknown" the next expand loads again). A merge shows the files against the FIRST parent and says so in a hint row. A click on a file opens its diff IN THIS commit through the bar (`onDiff` with the source — a diff tab in the chat, otherwise the diff modal; badge = short hash, title = path or "old → new"); the whole commit stays reachable through the button on the right of the row (on hover or focus; the row makes room for it). Keyboard: Enter/Space toggle, right arrow opens, left arrow closes; the row carries `aria-expanded`. The dot of the hovered or focused row grows by 2 px (pure CSS, `.cb-git-dot` in `app/globals.css`, target per circle as `--point-large`; the lanes are not recomputed) and the card from `CommitCard.tsx` hangs on the row; the native `title` of the row is gone. |
| `CommitCard.tsx` | The hover card of a commit, like VS Code: `useCommitCard` (stable listeners for the memoized rows, the clocks, the per-hash store) and the card itself, via portal on the body with `cb-kit` + `cb-pop`. Content: author (accent), relative time and full date with time, the whole message (line breaks kept, scrolls), hairline, "1 file changed, 92 insertions(+), 79 deletions(-)" in the colors of "A"/"D" (a merge: "· against the first parent"), hairline, short hash (accent) and a button that copies the FULL hash. Appears after 400 ms of rest on the row (only then is the server asked; a fast sweep asks nothing), the next one after 150 ms, stays 250 ms so the mouse can move in; not during a drag in the bar (the `locked` flag from the stack in `GitSidebar.tsx`), not over file rows; press, Escape, scrolling and a new window size close it; keyboard: with visible focus, `aria-describedby`. |

Pure computations (with counter-tests in `web/test/git-graph.test.mjs`): `lib/git-graph.ts` — `computeLanes` (swim lanes after VS Code
`scmHistory.ts`), `laneGeometry`/`graphMaxPx` (width per lane, capping with a collector column), `badges`, `loadMore`, `graphState`,
`readExtent`, `continuousLanes` (which lanes continue below a row and which of them is the own one — the columns of the file rows). File
rows: `lib/git-files.ts` (a leaf without imports) — `KIND_COLOR`/`KIND_LETTER` (ONCE; "Changes" in `GitSidebar.tsx` reads them there too),
`commitStatusDisplay` (letter M/A/D/R/C/T/U → color, letter, word like `classify` in `git.js`, bound in the test), `fileKind` (icon by file
type), `partsPath`, `diffPath` (a path with a leading `-` goes as `./-name`). Card: `lib/git-card.ts` (leaf without imports) — the clocks,
`relativeTime` (steps like VS Code, always with a number), `fullDate`, `cardsData` (only the answer for THIS hash), `countsParts`/
`countsText` (singular/plural, zero parts drop), `cardsSituation` (left of `[data-git-bar]`, otherwise below/above, never outside the
window); counter-tests in `web/test/git-card.test.mjs`.

Data (server `electron/server/git.js`, whitelisted reads in `lib/api/git.ts`):
- `POST …/git/log` with `graph: "all" | "current"` (`gitGraphLog`), read only via `normGitGraphLog`.
- The files of a commit and the diff per file are OPTIONS of `POST …/git/show` (no new route): `{ repo, hash, files: true }` and `{ repo, hash, file, old? }`, read only via `normGitCommitFiles` / `normGitCommitFileDiff`. An old server answers both with the whole commit (`{hash, diff}`): then "not available" shows, never an empty list.
- The card asks the same route with `{ repo, hash, info: true }`; the answer fields are ONE list `COMMIT_INFO_FIELDS` in `git.js` (server test: the route sends exactly these; `web/test/git-card.test.mjs`: the web reads exactly these), read only via `normGitCommitInfo`. An old server is "unknown": the card shows what the graph knows, without the counts line, and the bar stops asking.

Colors: the lane of the HEAD branch is cobalt (`--color-accent`), the others `--git-lane-0…4` (`app/globals.css`, light and dark).

Data attributes for test rigs (all `data-git-…`, see the sources): list and extent (`graph-list`, `graph-extent*`), per row `commit`, `graph-kind`
(`head` | `merge` | `node`), strip/point/core/column/through/progress-bar, per badge `ref`/`ref-kind`/`ref-more`, `more` ("Load more"),
`graph-cap`, `graph-clipped-lanes`, `graph-linear`; expanding: `commit-row` (with `data-open`), `commit-whole`, `commit-files*`,
`commit-against`, `commit-file*`, `file-kind`; card: `data-card` on the row while its card shows, `commit-card*` (page `left` | `below` |
`above`).

Three typical questions:

- **Why does the graph not reload although another branch got a commit?** It has no polling of its own (guard in `git-graph.test.mjs`): it reloads with the state of the shown repo from the shared tree (`graphState`: last commit, branch, upstream, ahead/behind), on "Refresh" in the header and on choosing the extent.
- **Why is a line dashed?** More lanes side by side than fit at 6 px per lane into just under a quarter of the bar: the right ones merge into a collector column, and above the list it says from which one.
- **Why does the graph show a single line and the hint "Linear"?** The server does not know `graph` yet (the answer carries no parents) — a full deploy rolls out the web before the server.
- **Why does an expanded merge show fewer files than the merge "had"?** It is compared against the first parent (like VS Code) — what you see is what the merge brought into the branch. The button on the right of the row shows the whole merge.
- **Why does the card show no counts line?** The server does not know `info` yet, or the answer is still pending or did not pass the whitelist — then the card shows only what the graph knows (commit time instead of author time, only the subject). Never "0 files".

Not here: the section header with repo choice and actions (`GitSidebar.tsx` `GraphSection`), the history sheet with cherry-pick (`GitSidebar.tsx` `HistoryModal`, linear, without `graph`), the large git overview per project (`components/projects/git/`).
