# `gitView/` — Git overview: which branches are open

Computes the branch overview of a project ONCE in the server; web and iOS only draw:

- **large** — `GET /api/projects/:pid/gitView?repo=&search=&fresh=1` for Coding → Projects → project → Git (branch
  timeline), only in server operation and for converted projects; reads every `ready` instance in the container and never
  wakes one (every other: `read: false` with a reason).
- **small** — the fields `branchesRunning` and `counter` per repo in `GET …/git` (`devtools/code-route.js`, wired via
  `setGitOverview` in `server.js`), so the git status hook stays the only git poller of the bar — only in server operation,
  also for projects without a project container (then the same read script in the backend).
- **`repos`** — the number of code repos per project in `GET /api/projects` and the workspace responses, `null` = not read
  yet.

Both views share ONE reading per (project, repo, instance): `cache.js`, at most 30 s, dropped at the end of every
turn in the project (hook "git-view" on `beforeRunBroadcast`, registered in `server.js` — also fires before a queued
follow-up turn), after every fetch that ran, and with every state change of the instance row (marker
`createdAt:updatedAt`); `fresh` always starts a new reading (generation per key). The large view waits for the reading, the
small one NEVER (`readingWithoutWait`: if a valid entry is missing, the fields are missing, and the reading starts in the
background). Chats (`checkedOut[].chats`) come fresh on every response, never from the cache. `repos.js repoChoice` checks
the parameter `repo` for all four routes.

| File | Content |
|---|---|
| `contract.js` | the seam to web and iOS as a leaf without imports (binding `web/test/git-view-binding.test.mjs`) |
| `mainBranch.js` | `origin/HEAD` → `main` → `master` → none: the pure choice `selectMainBranch` and the shell piece `MAIN_SH` of the read script from ONE list; compared against `origin/<b>` before the local `<b>` |
| `read.js` | the read script per (instance, repo) — ONE `sh -c` via `commandRun` with a fixed number of git calls (tips without common history with the main branch are detected by `WITHOUT_AWK` from S, they stay out of M), `parseReading` (pure: numbers against main/upstream, branch point, points, not fetched, worktrees, `sinceCreation` from the graph), `readInstance` (reasons `time`/`stopped`/`frozen`/`error`), `copyComparison` (refs from the copy's snapshot) |
| `groups.js` | `rowsFrom` — pairing via the upstream configuration, the four groups, copy rows only for new and moved branches (below the main row), dots/bar, search before the cap; `user`, `state`, `checkedOut[].chats` stay `null` (filled by `user.js`). `allRows` — the same rows without search and cap (detail, small view), `counterFrom` — rows per group. `lineFrom` — the main line |
| `cache.js` | the cache: `reading(proj, rel, inst, {fresh, valid})` — the ONE cached reading, awaited (30 s, tunable `CBASE_GIT_VIEW_STORAGE_MS`, clock seam `setStorageClock`, marker of the instance row, generation per project AND per key, shared runs except `fresh`); `readingWithoutWait` — the same without waiting (small view; background reading at most one per key, successor from half the validity on); `dismissReading` (fetch.js); test seams `setReadSeam`, `readingsFinished`; a copy reads with the refs of its snapshot; without an instance `runInB` (the read script in the backend, deadline on the process group). `gitViewTurnEnd` — the hook "git-view" |
| `overview.js` | `gitView` — the response of the large view (instances main + live copies, only `ready` ones read, `reasonOf` for the rest; main branch and line from main, else from the first read copy); `rowFor` — the `row` of the detail from the same readings |
| `small.js` | `smallView` — `branchesRunning` and `counter` per repo of `GET …/git` in the instance the route has chosen, from the cache (deliberately not in the argv bundle of `git.js`), WITHOUT waiting; an entry whose checked-out state does not match the fresh tree does not count; if something is missing (also: not read yet), both fields are missing (never empty lists) |
| `repos.js` | `reposInContainer` (the repos of a converted project over the file system, without git and without waking), `repoChoice` (the ONE check of `repo` for large view, fetch, detail and diff: 400 REPO_INVALID, 404 UNKNOWN_REPO), `repoCount`/`withRepoCount` (`repos` of the project lists: converted at once over the file system, else `projectRepos` in the backend in the background, `null` until then) |
| `routes.js` | `gitViewProjectRoutes` (sub-slice of `projectRoutes`, BEFORE `codeProjectRoutes`): only in server operation (404) and for converted projects (409); `GET …/gitView` (400 REPO_INVALID, 404 UNKNOWN_REPO), `POST …/gitView/fetch`, `GET …/gitView/branch`, `GET …/gitView/diff`; fence row `project-git-view` (rejected from the project networks) |
| `instance-choice.js` | the instance choice: seam name (`main` · `<copy>`) ↔ internal (`copy-<copy>`); `readyInstance` lets only a `ready` instance through (409 INSTANCE_NOT_READY, 404 UNKNOWN_INSTANCE) — reads only the DB, never wakes |
| `user.js` | user and state of a `cbase/*` branch from the existing sources (subagents, workflow agents from the journal, graph starts, stack copies), else `unknown`; `runningChats(project, instance)` fresh from the run state (guard `git-view-user.test.js`) |
| `color.js` | key color per copy (index 0..COLORS−1: hash slot, else the next least used one, in creation order; main `null`) |
| `fetch.js` | `fetch` per (project, repo, instance) with the throttle FETCH_GAP_MS for `auto: true` (clock seam `setFetchClock`), the same locks as the fetch of the code view through its functions, `remoteState` from FETCH_HEAD (guard `git-view-fetch.test.js`) |
| `detail.js` | detail of a branch (commits ahead, numstat, origin, MR via `merge-request.js mergeRequestFor` (GitLab directly with the account of the remote's host) with the deadline `MR_DEADLINE_MS` in parallel with the `row` via `overview.js rowFor`, `failed` per part) and diff of a file; deadline ⇒ 504 READ_TIME, failure ⇒ 409 READ_FAILED with `reason`, ONE `sh -c` each in the instance; the main branch rule comes from `mainBranch.js MAIN_SH` (guard `git-view-detail.test.js`) |
| `merge-request.js` | the open MR of a branch, asked directly at GitLab (API v4) with the `gitlab_accounts` account whose host is the remote's host; without one `no-gitlab`, 401/403 `no-access` (guard `git-view-detail.test.js`) |

What does NOT live here: the git actions (switch, commit, push …) — `git.js` and `devtools/code-route.js`; the reading of the
instances tree — `projectbox/instances-tree.js`. `runs/` never imports this folder.

Guard of the large and small view, the cache and `repos`: `server/backend/test/gitView.test.js`.
