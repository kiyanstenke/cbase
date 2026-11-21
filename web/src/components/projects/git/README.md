# `components/projects/git/` — the big git overview

Coding → Projects → Project → **Git**: which branches are open, per repo as a timeline, read-only. The tab exists only for a
converted project with at least one repo (`ProjectsPane.tsx` `hatGitRepos`); the server answers 404 without server mode and 409
for a project not converted.

| File | What |
|---|---|
| `GitView.tsx` | The page: header (repo choice only with > 1 repo, window as kit `Segments`, kit `Search` → `search` to the server, a kit `FilterChip` per group, per instance "Remote state N min ago" with ⟳), notices above the list (`clipped`, unread instances with reason), kit `SplitPane` with `listWide`. Poll every 5 s only while the page is visible, `fresh=1` after `project/instance`/`project/copy` and after a fetch that ran; ONE request at a time (`lib/retrieval-airlock.ts`). On open ONE `fetch` with `auto: true` per repo and read instance (the server holds the throttle). Picks up the wish of a jump (`takeProjectGitTarget`: the repo). |
| `Timeline.tsx` | The SVG: axis, main line, group headers in the order of `GIT_VIEW_GROUPS`, per row name (fixed column) · lane · details. x in percent (no width measurement); calculation in `lib/git-view-time.ts`. Copy rows in their identifying colour (`--kit-copy-0…5`, `globals.css`) directly under the same-named main row (`arrangeRows`); "Ended (n)" collapsed in "From cbase"; no merge arc. |
| `GitViewDetail.tsx` | The detail of a row: state against main branch and remote (copy: since creation), commits ahead and files (+/−) with a cap, a file's diff in the existing diff sheet (`components/GitSidebar.tsx` `DiffModal`, no hunk staging), MR (no row for `no-gitlab`, "GitLab not connected" for `no-access`), origin, user with jump. |
| `GitWords.tsx` | Words (group, state, reason, user, instance, age) and jumps (subagent/workflow agent → `openAgent`, graph → child chat, copy → `showInstances`, running chats: one ⇒ jump, several ⇒ kit `Menu`). |

Data layer: `lib/api/gitView.ts` (lists of the contract `server/backend/electron/server/gitView/contract.js`, allowlist, routes);
the small view reads `branchesRunning`/counters on the repo from `GET …/git` (`lib/api/git.ts`) — no second poller.

Data attributes for test stands: `data-git-view` (page), `data-git-view-timeline`, `data-git-view-detail`, per row
`data-git-row=<name>`, `data-git-group=<group>`, `data-git-instance=<name>` and `data-active="1"` on the selected one, per group
`data-git-group-header`, plus `data-git-fetch=<instance>`, `data-git-ended=<n>`, `data-git-view-clipped`, `data-git-view-unread`.

Three typical questions:

- **Why does a row only say "not read"?** The view reads only ready instances and never wakes one; the reason is shown above the
  list (`instances[].read/reason` of the answer, `GitWords.tsx` `reasonWord`).
- **Where is it decided whether dots or a bar?** In the server (`commits.points === null` from `POINTS_MAX`); `lib/git-view-time.ts`
  `displayOf` only draws what arrives.
- **How does one get here from outside?** `showProjectGit` (`lib/project-jump.ts`) or the address `?git=<project>[&repo=…]`.

Not here: the git bar (`components/GitSidebar.tsx`), the tab itself (`ProjectsPane.tsx`, `ProjectView.tsx`), the git actions (commit,
push, checkout — they stay in the git bar and in the "Instances" tab).
