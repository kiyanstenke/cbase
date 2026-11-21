// Guards for the detail and the file diff of the git overview — gitView/detail.js and gitView/merge-request.js mergeRequestFor over
// the real routes of a real server (agent-harness.mjs), the fake docker (fake-docker.mjs, `exec` LOCAL), real git and a fake GitLab
// (http, API v4 at the host of a `gitlab_accounts` account — the same host as the remote).
//
// What it proves, each with the sabotage that breaks it:
//   (1) Detail: the commits the branch is ahead of `main` (newest first, `t` in ms), the files from numstat `<main>...<branch>`
//       (binary => plus/minus null), `row` the row of the large view (from the same reading, overview.js rowFor — shape ROW_FIELDS,
//       group, user), `clipped` null. A branch with more than DETAIL_COMMITS_MAX commits shows exactly that many and says
//       `clipped.commits: {shown, total}`. Sabotage: `clipped.commits` only from `count > shown + 9` => (1) red; `git log` without
//       `-n "$max"` => (1) red.
//   (2) Origin: a cbase branch with a row from the table (user.js), without a row the reflog, a local branch of the reflog
//       ("branch: Created from main"), a remote branch without reflog `unknown`. Sabotage: originFromReflog always null => red; the row
//       from user.js skipped => red.
//   (3) MR per situation: no account for the remote's host `no-gitlab` (a GitHub remote is no GitLab); an account without token
//       `no-access`; remote without GitLab path (local folder) `no-gitlab`; empty list `none`; hit with pipeline from the single MR;
//       GitLab 404 `no-gitlab`; 401 `no-access`; 500 `error`. Asked with the project path from the remote URL (encoded), the source
//       branch of the upstream, `state=opened`, the account's token as PRIVATE-TOKEN — and the remote URL with its token appears in
//       NO response. Sabotage: 404 not evaluated => (3) red (`error` instead of `no-gitlab`); the first account taken without
//       comparing the host => (3) red (the account of another host answers); the remote URL with token in a field of the response
//       => (3) red.
//   (4) Diff: `<main>...<branch> -- <file>`, path literal; cut at DIFF_MAX on a line boundary with `clipped: true`; without a main
//       branch 409 NO_MAIN_BRANCH (and in the detail commits/files null, `failed` null); unknown branch 404, invalid name 400.
//       Sabotage: no cut at the line boundary => (4) red.
//   (5) The dangerous paths: `file=--output=<path>` is a path, not an option — no file written (sabotage: `--` struck from DIFF_SCRIPT
//       => red, the file was there); `file=:(glob)*` is literal — empty diff (sabotage: `--literal-pathspecs` struck => red, the diff
//       of all files); a textconv and an external diff driver from `.git/info/attributes` + repo config do NOT run, neither in the
//       diff nor in the detail (sabotage: `--no-ext-diff --no-textconv` struck from DIFF_SCRIPT => red, the driver's marker was there).
//   (6) Failing is not "unknown": a deadline in the MIDDLE of the script (before the `ref` section, a git wrapper that hangs there) is
//       504 READ_TIME with `reason: "time"` in detail and diff, never 404 BRANCH_UNKNOWN (sabotage: the old order `!l.ref` before the
//       deadline => red, 404); a failed `git diff --numstat` makes `files` null AND `failed.files` the reason (sabotage: without
//       `failed` => red).
//   (7) The MR waits at most MR_DEADLINE_MS: a GitLab that never answers gives `{ state: "error" }` with the deadline's
//       wording (knob CBASE_GIT_VIEW_MR_MS = 500). Sabotage: without mrWithDeadline => red (only after 35 s, with the abort text).
//   (8) `repo`: a folder INSIDE the repo that is no code repo itself (`app/under`), and an unknown one are 404 UNKNOWN_REPO for detail
//       and diff — the same check as the large view (repos.js repoChoice). Sabotage: the old path check => red (200 with the data of
//       `app`).
// No time limit: waits for answers, never for a duration.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { DETAIL_COMMITS_MAX, DETAIL_FIELDS, ROW_FIELDS } from "../electron/server/gitView/contract.js";
import { DIFF_MAX } from "../electron/server/gitView/detail.js";
import { withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { realGit, gitLocation, createRepo } from "./projectbox-git-scenario.mjs";

async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const ops = (fd, o) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200", GIT_TERMINAL_PROMPT: undefined, CBASE_GIT_PROJECTS: path.join(o.location, "git-projects") });
function containerStart(fd, o, name) {
  const env = { ...o.containerEnv, PATH: o.env.PATH };
  execFileSync(fd.bin, ["run", "-d", "--name", name, ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
}
const TOKEN_IN_REMOTE = "SECRET-GU6-remote";
const READ_TOKEN = "read-gu6";

test("(1)–(4) detail, origin, MR per situation and diff of the git overview", async () => {
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-gu6-");
  // The fake GitLab (API v4): `mode` decides the answer, `seen` records the requests.
  let mode = "empty";
  const seen = [];
  const service = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push({ path: u.pathname, ...Object.fromEntries(u.searchParams), token: req.headers["private-token"] });
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (mode === "hangs") return undefined; // (7): never answers
    if (mode === "401") return send(401, { message: "401 Unauthorized" });
    if (mode === "500") return send(500, { message: "broken" });
    if (mode === "404") return send(404, { message: "404 Project Not Found" });
    if (mode === "hits" && /\/merge_requests\/42$/.test(u.pathname)) return send(200, { iid: 42, head_pipeline: { status: "success", web_url: "https://gitlab.example/p/1" } });
    if (mode === "hits") return send(200, [{ iid: 42, title: "Build login", target_branch: "main", web_url: "https://gitlab.example/gruppe/app/-/merge_requests/42" }]);
    return send(200, []);
  });
  await new Promise((r) => service.listen(0, "127.0.0.1", r));
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws } = ctx;
      const P = path.join(ctx.root, "workspace", "gu6");
      const A = path.join(P, "app");
      const R = path.join(o.location, "remote.git");
      createRepo(A, o.env, { remote: R });
      const g = (...args) => realGit(A, args, o.env);
      // feature/login: three commits from main — a change, a new file, a binary one —, with upstream.
      g("checkout", "-q", "-b", "feature/login", "main");
      fs.writeFileSync(path.join(A, "a.txt"), "geändert\nzwei\n");
      g("commit", "-q", "-am", "one");
      fs.writeFileSync(path.join(A, "fresh.txt"), "n\n");
      g("add", "fresh.txt"); g("commit", "-q", "-m", "two");
      fs.writeFileSync(path.join(A, "bin.dat"), Buffer.from([0, 1, 2, 0, 255, 0]));
      g("add", "bin.dat"); g("commit", "-q", "-m", "three");
      g("push", "-q", "-u", "origin", "feature/login");
      // many: DETAIL_COMMITS_MAX + 2 commits; large: a file over DIFF_MAX; two cbase branches; a remote branch without a local one.
      g("checkout", "-q", "-b", "many", "main");
      for (let i = 0; i < DETAIL_COMMITS_MAX + 2; i++) g("commit", "-q", "--allow-empty", "-m", `c${i}`);
      g("checkout", "-q", "-b", "large", "main");
      fs.writeFileSync(path.join(A, "large.txt"), `${"x".repeat(99)}\n`.repeat(Math.ceil(DIFF_MAX / 100) + 5000));
      g("add", "large.txt"); g("commit", "-q", "-m", "large");
      g("branch", "cbase/agent-x1", "main");
      g("branch", "cbase/agent-without", "main");
      g("checkout", "-q", "main");
      g("push", "-q", "origin", "feature/login:spike");
      g("fetch", "-q", "origin");
      const detachedSha = g("rev-parse", "--short=7", "feature/login~1").trim();
      // A second repo without main/master: no main branch.
      const O = path.join(P, "without");
      fs.mkdirSync(O, { recursive: true });
      realGit(O, ["init", "-q", "-b", "trunk"], o.env);
      realGit(O, ["commit", "-q", "--allow-empty", "-m", "t"], o.env);

      const p = await ctx.projectWithoutInstance({ name: "Git overview", path: P });
      store.rememberSubagent(ctx.chat.id, { agentId: "x1", name: "Isolated reviewer", state: "finished" });
      await withEnvironment({ ...o.env, ...ops(fd, o) }, async () => {
        const main = `cbase-p-${p.id}`;
        containerStart(fd, o, main);
        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: main });
        const texts = [];
        const read = async (kind, q) => {
          const r = await fetch(`${base}/api/projects/${p.id}/gitView/${kind}?${new URLSearchParams({ repo: "app", instance: "main", ...q })}`, { headers: { Connection: "close" } });
          const text = await r.text();
          texts.push(text);
          return { status: r.status, body: JSON.parse(text) };
        };

        // (1) Detail without GitLab access.
        const d = await read("branch", { name: "feature/login" });
        assert.equal(d.status, 200, JSON.stringify(d.body));
        assert.deepEqual(Object.keys(d.body).sort(), [...DETAIL_FIELDS].sort());
        assert.equal(d.body.failed, null);
        // The row of the large view (sabotage: rowFor skipped => null => red).
        assert.deepEqual(Object.keys(d.body.row).sort(), [...ROW_FIELDS].sort());
        assert.equal(d.body.row.name, "feature/login");
        assert.equal(d.body.row.instance, "main");
        assert.equal(d.body.row.group, "branches");
        assert.equal(d.body.row.remote, "origin/feature/login");
        assert.deepEqual(d.body.row.toMain, { ahead: 3, back: 0, merged: false });
        assert.equal(d.body.row.commits.count, 3);
        assert.deepEqual(d.body.commits.map((c) => c.subject), ["three", "two", "one"]);
        for (const c of d.body.commits) {
          assert.match(c.sha, /^[0-9a-f]{40}$/);
          assert.ok(Number.isSafeInteger(c.t) && c.t > 1e12, `t in ms: ${c.t}`);
          assert.equal(c.author, "cbase Test");
        }
        assert.deepEqual(d.body.files.sort((a, b) => a.file.localeCompare(b.file)), [
          { file: "a.txt", plus: 2, minus: 1, binary: false }, { file: "bin.dat", plus: null, minus: null, binary: true }, { file: "fresh.txt", plus: 1, minus: 0, binary: false }]);
        assert.equal(d.body.clipped, null);
        assert.deepEqual(d.body.mr, { state: "no-gitlab" }, "a remote without GitLab path (local folder): no-gitlab, even without access");
        const many = await read("branch", { name: "many" });
        assert.equal(many.body.commits.length, DETAIL_COMMITS_MAX);
        assert.deepEqual(many.body.clipped, { commits: { shown: DETAIL_COMMITS_MAX, total: DETAIL_COMMITS_MAX + 2 }, files: null });
        assert.equal(many.body.commits[0].subject, `c${DETAIL_COMMITS_MAX + 1}`, "newest first");

        // (2) Origin.
        const cbaseBranch = await read("branch", { name: "cbase/agent-x1" });
        assert.deepEqual(cbaseBranch.body.origin, { source: "cbase", state: "ended",
          user: { kind: "subagent", name: "Isolated reviewer", chatId: ctx.chat.id, agentId: "x1", childChatId: null, instance: null } });
        const withoutRow = await read("branch", { name: "cbase/agent-without" });
        assert.equal(withoutRow.body.origin.source, "reflog");
        assert.equal(withoutRow.body.origin.from, "main");
        assert.equal(d.body.origin.source, "reflog");
        assert.equal(d.body.origin.from, "main");
        assert.ok(Number.isSafeInteger(d.body.origin.at), JSON.stringify(d.body.origin));
        const spike = await read("branch", { name: "origin/spike" });
        assert.equal(spike.status, 200, JSON.stringify(spike.body));
        assert.deepEqual(spike.body.origin, { source: "unknown" });
        const detached = await read("branch", { name: `detached @ ${detachedSha}` });
        assert.deepEqual(detached.body.commits.map((c) => c.subject), ["two", "one"]);

        // (3) MR: a remote whose host has no GitLab account => no-gitlab (not no-access), GitLab is not asked.
        const gitlabUrl = `https://oauth2:${TOKEN_IN_REMOTE}@127.0.0.1/group/app.git`;
        g("remote", "set-url", "origin", gitlabUrl);
        assert.deepEqual((await read("branch", { name: "feature/login" })).body.mr, { state: "no-gitlab" }, "without an account for the host: no GitLab");
        // An account on another host does not count.
        store.createGitlabAccount({ id: crypto.randomUUID(), label: "Other", host: "https://gitlab.elsewhere.example", token: "other", createdAt: Date.now(), updatedAt: Date.now() });
        assert.deepEqual((await read("branch", { name: "feature/login" })).body.mr, { state: "no-gitlab" }, "the account of another host was taken");
        // An account for the host without a token => no-access (not "none").
        const accountId = crypto.randomUUID();
        store.createGitlabAccount({ id: accountId, label: "Fake", host: `http://127.0.0.1:${service.address().port}`, token: "", createdAt: Date.now(), updatedAt: Date.now() });
        assert.deepEqual((await read("branch", { name: "feature/login" })).body.mr, { state: "no-access" }, "an account without token: no-access, not none");
        store.updateGitlabAccount(accountId, { token: READ_TOKEN });
        // With the account, but the remote is a local folder => no-gitlab.
        g("remote", "set-url", "origin", R);
        assert.deepEqual((await read("branch", { name: "feature/login" })).body.mr, { state: "no-gitlab" });
        assert.equal(seen.length, 0, "GitLab is asked neither without an account nor without a GitLab path");
        g("remote", "set-url", "origin", gitlabUrl);
        mode = "empty";
        assert.deepEqual((await read("branch", { name: "feature/login" })).body.mr, { state: "none" });
        assert.deepEqual(seen.at(-1), { path: "/api/v4/projects/group%2Fapp/merge_requests", state: "opened", source_branch: "feature/login", per_page: "5", token: READ_TOKEN });
        mode = "hits";
        assert.deepEqual((await read("branch", { name: "feature/login" })).body.mr, { iid: 42, title: "Build login", target: "main",
          pipeline: { status: "success", url: "https://gitlab.example/p/1" }, url: "https://gitlab.example/gruppe/app/-/merge_requests/42" });
        assert.equal(seen.at(-1).path, "/api/v4/projects/group%2Fapp/merge_requests/42");
        // A remote branch asks with its name on the remote.
        await read("branch", { name: "origin/spike" });
        assert.equal(seen.filter((x) => !/\/42$/.test(x.path)).at(-1).source_branch, "spike");
        mode = "404";
        assert.deepEqual((await read("branch", { name: "feature/login" })).body.mr, { state: "no-gitlab" });
        mode = "401";
        assert.deepEqual((await read("branch", { name: "feature/login" })).body.mr, { state: "no-access" });
        mode = "500";
        const broken = (await read("branch", { name: "feature/login" })).body.mr;
        assert.equal(broken.state, "error", JSON.stringify(broken));
        assert.ok(broken.error, "error carries the text");
        for (const t of texts) assert.ok(!t.includes(TOKEN_IN_REMOTE) && !t.includes("oauth2"), `the remote URL appeared in a response: ${t.slice(0, 200)}`);

        // (4) Diff.
        const df = await read("diff", { name: "feature/login", file: "a.txt" });
        assert.equal(df.status, 200, JSON.stringify(df.body));
        assert.equal(df.body.file, "a.txt");
        assert.equal(df.body.clipped, false);
        assert.match(df.body.diff, /^diff --git a\/a\.txt b\/a\.txt$/m);
        assert.match(df.body.diff, /^\+geändert$/m);
        assert.match(df.body.diff, /^-a$/m);
        const gr = await read("diff", { name: "large", file: "large.txt" });
        assert.equal(gr.status, 200, JSON.stringify(gr.body).slice(0, 300));
        assert.equal(gr.body.clipped, true);
        assert.ok(Buffer.byteLength(gr.body.diff) <= DIFF_MAX && gr.body.diff.length > DIFF_MAX / 2, `length ${gr.body.diff.length}`);
        assert.ok(gr.body.diff.endsWith("\n"), "cut at a line boundary");
        const grRows = gr.body.diff.split("\n");
        assert.match(grRows[5], /^@@ -0,0 \+1,\d+ @@$/, grRows.slice(0, 6).join(" | "));
        assert.ok(grRows.slice(6, -1).every((z) => z === `+${"x".repeat(99)}`), "every line whole — no half one at the end");
        const withoutMain = await fetch(`${base}/api/projects/${p.id}/gitView/diff?${new URLSearchParams({ repo: "without", instance: "main", name: "trunk", file: "x" })}`, { headers: { Connection: "close" } });
        assert.deepEqual([withoutMain.status, (await withoutMain.json()).code], [409, "NO_MAIN_BRANCH"]);
        const withoutDetail = await fetch(`${base}/api/projects/${p.id}/gitView/branch?${new URLSearchParams({ repo: "without", instance: "main", name: "trunk" })}`, { headers: { Connection: "close" } });
        const od = await withoutDetail.json();
        assert.deepEqual([withoutDetail.status, od.commits, od.files, od.failed], [200, null, null, null], JSON.stringify(od));
        const foreign = await read("branch", { name: "exists-not" });
        assert.deepEqual([foreign.status, foreign.body.code], [404, "BRANCH_UNKNOWN"]);
        for (const name of ["-x", "a..b", "a b", "x@{1}"]) {
          const r = await read("branch", { name });
          assert.deepEqual([r.status, r.body.code], [400, "NAME_INVALID"], name);
        }
        const withoutRepo = await fetch(`${base}/api/projects/${p.id}/gitView/branch?instance=main&name=main`, { headers: { Connection: "close" } });
        assert.deepEqual([withoutRepo.status, (await withoutRepo.json()).code], [400, "REPO_INVALID"], "a missing repo is no statement");

        // (5) The dangerous paths: `--output=…` is a path, `:(glob)*` literal, drivers do not run.
        const output = path.join(o.location, "x-output.diff");
        const opt = await read("diff", { name: "feature/login", file: `--output=${output}` });
        assert.equal(opt.status, 200, JSON.stringify(opt.body));
        assert.equal(opt.body.diff, "", "`--output=…` matched a file");
        assert.equal(fs.existsSync(output), false, "`--output=…` was read as an option: git wrote the diff to a file");
        const glob = await read("diff", { name: "feature/login", file: ":(glob)*" });
        assert.equal(glob.status, 200, JSON.stringify(glob.body));
        assert.equal(glob.body.diff, "", `\`:(glob)*\` was a pattern: ${glob.body.diff.slice(0, 200)}`);
        const marker = path.join(o.location, "driver.marker");
        const driver = path.join(o.location, "driver.sh");
        fs.writeFileSync(driver, `#!/bin/sh\necho "$0 $*" >> '${marker}'\ncat "$1" 2>/dev/null\n`, { mode: 0o755 });
        fs.writeFileSync(path.join(A, ".git", "info", "attributes"), "*.txt diff=xdriver\n");
        g("config", "diff.xdriver.textconv", driver);
        g("config", "diff.xdriver.command", driver);
        try {
          const withDriver = await read("diff", { name: "feature/login", file: "a.txt" });
          assert.equal(withDriver.status, 200, JSON.stringify(withDriver.body));
          assert.match(withDriver.body.diff, /^\+geändert$/m, "the diff did not come from git itself");
          const detailDriver = await read("branch", { name: "feature/login" });
          assert.equal(detailDriver.status, 200, JSON.stringify(detailDriver.body));
          assert.equal(fs.existsSync(marker), false, `a diff driver ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : ""}`);
        } finally {
          fs.rmSync(path.join(A, ".git", "info", "attributes"), { force: true });
          g("config", "--remove-section", "diff.xdriver");
        }

        // (6) Failing: the git wrapper hangs before the `ref` section (branch "slow-motion") or makes numstat fail (branch "broken").
        g("branch", "slow-motion", "feature/login");
        g("branch", "broken", "feature/login");
        const wrapper = path.join(o.bin, "git");
        const wrapperPrior = fs.readFileSync(wrapper, "utf8");
        fs.writeFileSync(wrapper, wrapperPrior.replace("#!/bin/sh\n", `#!/bin/sh
case "$*" in
  *"refs/heads/slow-motion^{commit}"*) exec sleep 120 ;;
  *"--numstat"*"refs/heads/broken"*) echo "numstat broken (guard)" >&2; exit 128 ;;
esac
`), { mode: 0o755 });
        try {
          await withEnvironment({ CBASE_GIT_VIEW_DETAIL_MS: "3000" }, async () => {
            for (const kind of ["branch", "diff"]) {
              const z = await read(kind, { name: "slow-motion", file: "a.txt" });
              assert.deepEqual([z.status, z.body.code, z.body.reason], [504, "READ_TIME", "time"], `${kind}: ${JSON.stringify(z.body)}`);
            }
          });
          const k = await read("branch", { name: "broken" });
          assert.equal(k.status, 200, JSON.stringify(k.body));
          assert.equal(k.body.files, null);
          assert.deepEqual(k.body.commits.map((c) => c.subject), ["three", "two", "one"]);
          assert.equal(k.body.failed?.commits, null, JSON.stringify(k.body.failed));
          assert.match(String(k.body.failed?.files), /numstat.*128/, JSON.stringify(k.body.failed));
        } finally { fs.writeFileSync(wrapper, wrapperPrior, { mode: 0o755 }); }

        // (7) The MR waits at most the deadline: the service never answers.
        mode = "hangs";
        await withEnvironment({ CBASE_GIT_VIEW_MR_MS: "500" }, async () => {
          const h = await read("branch", { name: "feature/login" });
          assert.equal(h.status, 200, JSON.stringify(h.body));
          assert.equal(h.body.mr.state, "error", JSON.stringify(h.body.mr));
          assert.match(String(h.body.mr.error), /0\.5 s/, JSON.stringify(h.body.mr));
        });
        mode = "empty";

        // (8) `repo`: only a code repo of the project.
        fs.mkdirSync(path.join(A, "under"), { recursive: true });
        for (const repo of ["app/under", "nonexistent"]) {
          for (const kind of ["branch", "diff"]) {
            const r = await read(kind, { repo, name: "feature/login", file: "a.txt" });
            assert.deepEqual([r.status, r.body.code], [404, "UNKNOWN_REPO"], `${kind} ${repo}: ${JSON.stringify(r.body).slice(0, 200)}`);
          }
        }
      });
    });
  } finally {
    service.closeAllConnections();
    await new Promise((r) => service.close(r));
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});
