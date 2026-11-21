// Fixture routes: git (stage/unstage/commit/diff, behind them the startsWith(git/) catch-all), the git overview, the graph, /fixture/git.
import { S, projectId, workspace, json, gitTree, gitGraph, gitCommitPart, body, resetGit, gitViewRows, gitViewResponse, NEXT } from "./state.mjs";

// The git overview: the switch turns the fixture project into a converted one with a repo (the big view exists only there) and the
// server into one in server mode (`/api/projectCreation/rules` with `mode: "container"`).
// `reset-run` calls `resetGitView` — otherwise a test that sets the switch and fails would let every later one start with an instance row.
function gitViewToggle(on) {
  S.gitView = !!on;
  S.gitViewFetches = [];
  S.gitViewRetrievals = 0;
  const project = workspace.projects.find((p) => p.id === projectId);
  if (!project) return;
  if (S.gitView) {
    project.instance = { state: "ready", converted: true, identifier: `${projectId}/main` };
    project.repos = 1;
  } else {
    delete project.instance;
    delete project.repos;
  }
}
export function resetGitView() { gitViewToggle(false); }
// The git sheet's switches, which a failing test would otherwise pass on to the next one (`continueAfterFailure = false` skips every
// `defer`): the fetch delay, the second repo and the recorded graph requests. `reset-run` calls it before every start.
export function resetGitSheet() {
  S.gitSlow = 0;
  S.gitSecond = false;
  S.gitLogRequests = [];
  S.gitShowRequests = [];
}

export async function routesGit(ctx) {
  const { req, res, url, path, method } = ctx;
    // ── The project's git (for the git button in the chat header) ──
    // Enough of the real contract to check visibility, counters, staging and commit.
    if (path === `/api/projects/${projectId}/git` && method === "GET") {
      // Failure switch: a failed fetch must not appear in the app as
      // "no repository" (otherwise the git icon in the chat disappears too).
      if (S.gitFail) return json(res, 500, { error: "Fixture failure" });
      if (S.gitSlow > 0) await new Promise((finished) => setTimeout(finished, S.gitSlow));
      return json(res, 200, gitTree());
    }
    if (path === `/api/projects/${projectId}/git/stage` && method === "POST") {
      const request = await body(req);
      for (const file of S.gitFiles) {
        if (!request.all && !(request.files || []).includes(file.path)) continue;
        // Only what is in the working directory moves into the index; what is already staged
        // stays staged (otherwise "stage all" would undo it).
        if (!file.y.trim()) continue;
        file.x = file.y === "?" ? "A" : file.y;
        file.y = " ";
      }
      return json(res, 200, gitTree());
    }
    if (path === `/api/projects/${projectId}/git/unstage` && method === "POST") {
      const request = await body(req);
      for (const file of S.gitFiles) {
        if (!request.all && !(request.files || []).includes(file.path)) continue;
        if (!file.x.trim() || file.x === "?") continue;
        // An untracked file falls back to "??", not to "unstaged A".
        if (file.code === "?") { file.x = "?"; file.y = "?"; } else { file.y = file.x; file.x = " "; }
      }
      return json(res, 200, gitTree());
    }
    if (path === `/api/projects/${projectId}/git/commit` && method === "POST") {
      const request = await body(req);
      S.gitCommitted.push(String(request.message || ""));
      S.gitFiles = S.gitFiles.filter((file) => !file.x.trim() || file.x === "?");
      return json(res, 200, gitTree());
    }
    if (path === `/api/projects/${projectId}/git/diff` && method === "POST") {
      const request = await body(req);
      return json(res, 200, {
        path: request.file,
        staged: !!request.staged,
        diff: `--- a/${request.file}\n+++ b/${request.file}\n@@ -1,2 +1,2 @@\n-old line\n+new line`,
      });
    }
    // ── Git overview: the big view, its detail, the file diff and the fetch — without the switch 404 like without the server-mode marker.
    if (path.startsWith(`/api/projects/${projectId}/gitView`) && !S.gitView) return json(res, 404, { error: "only in server mode" });
    if (path === `/api/projects/${projectId}/gitView` && method === "GET") {
      S.gitViewRetrievals += 1;
      return json(res, 200, gitViewResponse(url.searchParams.get("search") || ""));
    }
    if (path === `/api/projects/${projectId}/gitView/branch` && method === "GET") {
      const instance = url.searchParams.get("instance") || "main";
      const name = url.searchParams.get("name") || "";
      const row = gitViewRows().find((z) => z.instance === instance && z.name === name);
      if (!row) return json(res, 404, { error: "Branch not found." });
      const now = Date.now();
      return json(res, 200, {
        row,
        commits: (row.commits.points || []).slice().reverse().map((p, i) => ({ sha: `c0ffee${i}0000000000000000000000000000000`.slice(0, 40), t: p.t, author: row.last?.author || "", subject: i === 0 ? row.last?.subject || "" : `Step ${i}` })),
        files: [{ file: "src/till.ts", plus: 12, minus: 3, binary: false }, { file: "src/prices.ts", plus: 4, minus: 1, binary: false }],
        mr: { state: "no-access" },
        origin: { source: "reflog", from: "main", at: row.branchPoint ?? now },
        clipped: null,
      });
    }
    if (path === `/api/projects/${projectId}/gitView/diff` && method === "GET") {
      const file = url.searchParams.get("file") || "";
      return json(res, 200, { diff: `--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,2 @@\n-old till\n+new till` });
    }
    if (path === `/api/projects/${projectId}/gitView/fetch` && method === "POST") {
      const request = await body(req);
      S.gitViewFetches.push({ repo: request.repo, instance: request.instance, auto: request.auto });
      return json(res, 200, { skipped: request.auto === true, remoteState: { at: Date.now() - 60_000, source: "fetch-head" } });
    }
    if (path === "/api/projectCreation/rules" && method === "GET" && S.gitView) {
      return json(res, 200, {
        mode: "container",
        omit: { folder: [], files: [] },
        limits: { depth: 4, repos: 25, skip: [], dependencies: [] },
        names: { forbidden: [], prefix: "" },
      });
    }
    if (path === "/fixture/gitView" && method === "POST") {
      const request = await body(req);
      gitViewToggle(request.on !== false);
      return json(res, 200, { on: S.gitView });
    }
    if (path === "/fixture/gitView" && method === "GET") {
      return json(res, 200, { on: S.gitView, fetches: S.gitViewFetches, retrievals: S.gitViewRetrievals });
    }
    // The git sheet's graph: `log` with `graph` and `show` with `files`/`file` — BEFORE the catch-all, which would otherwise answer the
    // tree (to the app an old server: linear, "files not available"). Every request is recorded (`GET /fixture/git`).
    if (path === `/api/projects/${projectId}/git/log` && method === "POST") {
      const request = await body(req);
      S.gitLogRequests.push({ repo: request.repo ?? null, limit: request.limit ?? null, graph: request.graph ?? null, chat: url.searchParams.get("chat") });
      if (S.gitFail) return json(res, 500, { error: "Fixture failure" });
      return json(res, 200, gitGraph(String(request.repo || ""), request.graph, request.limit));
    }
    if (path === `/api/projects/${projectId}/git/show` && method === "POST") {
      const request = await body(req);
      S.gitShowRequests.push({ repo: request.repo ?? null, hash: request.hash ?? null, files: request.files ?? null, file: request.file ?? null, old: request.old ?? null });
      const part = gitCommitPart(String(request.repo || ""), request);
      return part ? json(res, 200, part) : json(res, 404, { error: "Unknown commit" });
    }
    if (path.startsWith(`/api/projects/${projectId}/git/`) && method === "POST") return json(res, 200, gitTree());
    // No repository in the project: the git button must disappear then.
    if (path === "/fixture/git" && method === "POST") {
      const request = await body(req);
      // Modes, so that tests run independently of each other:
      //  • {fail}          — only flip the failure switch (mid-test),
      //  • {repo} (or empty) — reset EVERYTHING: repo question, files, failure off.
      // The latter matters because `continueAfterFailure = false` in the test suite skips the
      // `defer` rollback of a failed test.
      //  • {slow: ms}      — only the delay of the git fetch (pull to refresh, see state.mjs `gitSlow`).
      //  • {second: bool}  — only the second repo "frontend" ("Repositories" section, see state.mjs `gitSecond`).
      if ("fail" in request && !("repo" in request)) {
        S.gitFail = !!request.fail;
      } else if ("slow" in request && !("repo" in request)) {
        S.gitSlow = Math.max(0, Number(request.slow) || 0);
      } else if ("second" in request && !("repo" in request)) {
        S.gitSecond = !!request.second;
      } else {
        S.gitHasRepo = request.repo !== false;
        S.gitFail = false;
        resetGitSheet();
        resetGit();
      }
      return json(res, 200, { repo: S.gitHasRepo, fail: S.gitFail, slow: S.gitSlow, second: S.gitSecond, committed: S.gitCommitted });
    }
    if (path === "/fixture/git" && method === "GET") {
      return json(res, 200, {
        repo: S.gitHasRepo, fail: S.gitFail, committed: S.gitCommitted, files: S.gitFiles,
        second: S.gitSecond, logRequests: S.gitLogRequests, showRequests: S.gitShowRequests,
      });
    }
    return NEXT;
}
