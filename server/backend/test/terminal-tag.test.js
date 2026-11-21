// The server side of the right chat rail: three branches that the recorded anchor of `code-scopes.test.js` does NOT vary - it sends
// `/terminal {cols, rows}` without a tag, `/git/commit {message, all}` without amend and `/git/discard {file}` without all. Without
// this file the gate would stay green on: a lost kill line at the chat or workspace DELETE (the login shells would run until the server
// restarts, unreachable for every client), a struck `--no-edit` (git waited for an editor) and a `discard all` that takes staged
// changes along.
//
// Three kinds: (1) PTY tags through the real server (server harness, fake CLI unused) - two shells with tag chat:A, one chat:B, one without
// a tag, one without a body, plus the side shells `ws:<id>` and `proj:<id>` => DELETE /api/chats/A kills only A; DELETE
// /api/workspaces/:id afterwards B, ws and proj - the second delete path of a chat. (2) Units on a throwaway repo for `gitCommit` (amend
// with and without a message stays ONE commit; without amend the empty message is the error) and `gitDiscard` with `all` (staged stays,
// unstaged goes back, untracked gone, ignored stays). (3) The route for it: `/git/commit {amend}` and `/git/discard {all}` reach the units.
//
// COUNTER-TESTS: kill line in chats/routes.js commented out => "a1 dead" red; the chat kill line in workspaces/routes.js commented out
// => "b1 dead after the workspace DELETE" red, the ws row => "ws shell dead" red; `--no-edit` struck in git.js => unit AND route red with
// "there was a problem with the editor 'false'" (GIT_EDITOR=false makes git fail at once instead of waiting six seconds for an editor -
// in the product `--no-edit` takes effect BEFORE the editor, the variable changes nothing on the green path); `clean -fd` struck => unit and
// route red at the status line (u.txt and fresh/ are still there).
//
// Two rules from the build: every PTY the test creates it ends in `finally` - a living login shell keeps the test process's event loop
// open, and a red would turn into a hang; and the git identity is in process.env because `gitCommit` takes no environment of its own.
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 node --test server/backend/test/terminal-tag.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { withServer, makeWorkspace, makeProject, makeChat, json, ok } from "./server-harness.mjs";
import { gitCommit, gitDiscard } from "../electron/server/git.js";

// The git environment of a throwaway repo: fixed identity, no configuration of this machine (including the two path settings that
// GIT_CONFIG_GLOBAL=/dev/null does not cover - see code-scopes), and an editor that fails at once: an `--amend` WITHOUT `--no-edit` would
// fail in milliseconds instead of hitting the 6 s deadline of `git()`.
const GIT_ENVIRONMENT = {
  GIT_AUTHOR_NAME: "Tester", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Tester", GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_CONFIG_KEY_1: "core.attributesFile", GIT_CONFIG_VALUE_1: "/dev/null",
  GIT_CONFIG_KEY_2: "commit.gpgsign", GIT_CONFIG_VALUE_2: "false",
  GIT_EDITOR: "false",
  LC_ALL: "C",
};

function withGitEnvironment(fn) {
  const prior = {};
  for (const [k, v] of Object.entries(GIT_ENVIRONMENT)) { prior[k] = process.env[k]; process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

/** A throwaway repo with a seed commit (README.md, a.txt, .gitignore for *.log). */
function seedRepo(root) {
  const g = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...GIT_ENVIRONMENT } });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# Seed\n");
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "*.log\n");
  g("init", "-q", "-b", "main");
  g("add", "-A"); g("commit", "-q", "-m", "Seed");
  return {
    g,
    commits: () => g("log", "--format=%s").trim().split("\n"),
    // Not `trim()` over the whole output: the first line " M README.md" starts with the space of the index column, and a trim would
    // turn it into "M README.md" - a staged change that is none.
    status: () => g("status", "--porcelain").split("\n").filter(Boolean).sort(),
    inHead: (file) => g("show", "--stat", "--format=", "HEAD").includes(file),
  };
}

test("Deleting a chat ends only the PTYs with its tag; deleting a workspace those of its chats and those of the terminal tab", async () => {
  await withServer(async ({ base, wsPath, projPath }) => {
    const ws = await makeWorkspace(base, "T", wsPath);
    const proj = await makeProject(base, ws.id, projPath);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);
    const all = [];
    const mk = async (body, apiBase = `${base}/api/workspaces/${ws.id}`) => {
      const r = body === null
        ? await fetch(`${apiBase}/terminal`, { method: "POST" }).then(async (res) => ({ status: res.status, body: await res.json() }))
        : await json(`${apiBase}/terminal`, { method: "POST", body: JSON.stringify(body) });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.available, true, `node-pty missing: ${JSON.stringify(r.body)}`);
      all.push(r.body.id);
      return r.body.id;
    };
    const alive = async (id) => (await json(`${base}/api/terminal/${id}/exists`)).body.exists;
    try {
      const a1 = await mk({ cols: 80, rows: 24, tag: `chat:${a.id}` });
      const a2 = await mk({ cols: 80, rows: 24, tag: `chat:${a.id}` });
      const b1 = await mk({ cols: 80, rows: 24, tag: `chat:${b.id}` });
      const without = await mk({ cols: 80, rows: 24 });
      const empty = await mk(null); // no body => readBody.catch, no tag, no error
      const lang = await mk({ cols: 80, rows: 24, tag: "x".repeat(500) }); // is cut to 120, matches nothing
      const wsShell = await mk({ cols: 80, rows: 24, tag: `ws:${ws.id}` });
      const projShell = await mk({ cols: 80, rows: 24, tag: `proj:${proj.id}` }, `${base}/api/projects/${proj.id}`);
      for (const id of all) assert.equal(await alive(id), true, `PTY ${id} lives after creation`);

      const d = await json(`${base}/api/chats/${a.id}`, { method: "DELETE" });
      assert.equal(d.status, 200, JSON.stringify(d.body));
      assert.equal(await alive(a1), false, "a1 dead");
      assert.equal(await alive(a2), false, "a2 dead");
      for (const [id, name] of [[b1, "b1"], [without, "no tag"], [empty, "no body"], [lang, "long tag"], [wsShell, "ws"], [projShell, "proj"]]) {
        assert.equal(await alive(id), true, `${name} lives after the chat DELETE`);
      }
      // Deleting the same chat a second time: 404, and nothing else falls.
      assert.equal((await json(`${base}/api/chats/${a.id}`, { method: "DELETE" })).status, 404);
      assert.equal(await alive(b1), true, "b1 lives after the second DELETE");

      // The second delete path: the workspace takes its chats along - and their shells, including those of the terminal tab on
      // workspace and project level. What belongs to nobody stays.
      const b2 = await mk({ cols: 80, rows: 24, tag: `chat:${b.id}` });
      await ok(`${base}/api/workspaces/${ws.id}`, { method: "DELETE" });
      assert.equal(await alive(b1), false, "b1 dead after the workspace DELETE");
      assert.equal(await alive(b2), false, "b2 dead after the workspace DELETE");
      assert.equal(await alive(wsShell), false, "ws shell dead after the workspace DELETE");
      assert.equal(await alive(projShell), false, "proj shell dead after the workspace DELETE");
      assert.equal(await alive(without), true, "without a tag lives after the workspace DELETE");
      assert.equal(await alive(empty), true, "without a body lives after the workspace DELETE");
      assert.equal(await alive(lang), true, "long tag lives after the workspace DELETE");
    } finally {
      // Kill every shell that still lives - otherwise it keeps the test's event loop open.
      for (const id of all) await fetch(`${base}/api/terminal/${id}`, { method: "DELETE" }).catch(() => {});
    }
  });
});

test("gitCommit: amend extends the last commit (new with a message, keep without); without amend the message is missing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-amend-"));
  try {
    await withGitEnvironment(async () => {
      const repo = seedRepo(root);
      fs.writeFileSync(path.join(root, "a.txt"), "a2\n");
      await gitCommit(root, "", "second", { all: true });
      assert.deepEqual(repo.commits(), ["second", "Seed"], "commit all => two commits");

      await gitCommit(root, "", "second, extended", { amend: true });
      assert.deepEqual(repo.commits(), ["second, extended", "Seed"], "amend with a message => ONE commit, new message");

      fs.writeFileSync(path.join(root, "b.txt"), "b\n");
      await gitCommit(root, "", "", { amend: true, all: true });
      assert.deepEqual(repo.commits(), ["second, extended", "Seed"], "amend without a message => ONE commit, keep the message (--no-edit)");
      assert.equal(repo.inHead("b.txt"), true, "amend all takes the new file into the last commit");

      await assert.rejects(() => gitCommit(root, "", "", {}), /Commit-Nachricht fehlt/, "without amend the empty message is the error");
      await assert.rejects(() => gitCommit(root, "", "   ", { all: true }), /Commit-Nachricht fehlt/, "whitespace is no message");
      assert.deepEqual(repo.commits(), ["second, extended", "Seed"], "the rejected calls committed nothing");
    });
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
});

test("gitDiscard all: staged stays, unstaged goes back, untracked gone, ignored stays", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-discard-"));
  try {
    await withGitEnvironment(async () => {
      const repo = seedRepo(root);
      fs.writeFileSync(path.join(root, "a.txt"), "staged\n");
      repo.g("add", "a.txt");
      fs.writeFileSync(path.join(root, "README.md"), "# changed, not staged\n");
      fs.writeFileSync(path.join(root, "u.txt"), "u\n");
      fs.mkdirSync(path.join(root, "fresh"));
      fs.writeFileSync(path.join(root, "fresh", "x.txt"), "x\n");
      fs.writeFileSync(path.join(root, "run.log"), "ignored\n");
      assert.deepEqual(repo.status(), [" M README.md", "?? fresh/", "?? u.txt", "M  a.txt"], "initial state");

      await gitDiscard(root, "", "", { all: true });
      assert.deepEqual(repo.status(), ["M  a.txt"], "only the staged change is still in the status");
      assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), "# Seed\n", "the unstaged change is back to the index");
      assert.equal(fs.existsSync(path.join(root, "u.txt")), false, "u.txt gone");
      assert.equal(fs.existsSync(path.join(root, "fresh")), false, "the untracked folder gone (-d)");
      assert.equal(fs.existsSync(path.join(root, "run.log")), true, "ignored stays (no -x)");
      assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "staged\n", "the staged version stays in the working tree");

      // Without `all` the old contract holds: a file is required.
      await assert.rejects(() => gitDiscard(root, "", "", {}), /Keine Datei angegeben/);
    });
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
});

test("Route: /git/commit {amend} and /git/discard {all} reach the units - without amend the empty message stays a 400", async () => {
  await withGitEnvironment(() => withServer(async ({ base, wsPath, projPath }) => {
    const repo = seedRepo(projPath);
    const ws = await makeWorkspace(base, "T", wsPath);
    const proj = await makeProject(base, ws.id, projPath);
    const api = `${base}/api/projects/${proj.id}`;

    fs.writeFileSync(path.join(projPath, "a.txt"), "a2\n");
    const r1 = await json(`${api}/git/commit`, { method: "POST", body: JSON.stringify({ message: "", all: true }) });
    assert.equal(r1.status, 400, JSON.stringify(r1.body));
    assert.match(String(r1.body.error), /Commit-Nachricht fehlt/);

    const r2 = await json(`${api}/git/commit`, { method: "POST", body: JSON.stringify({ message: "", all: true, amend: true }) });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.ok(Array.isArray(r2.body.repos), "the route answers with the fresh tree");
    assert.deepEqual(repo.commits(), ["Seed"], "amend through the route: ONE commit, keep the message");
    assert.equal(repo.inHead("a.txt"), true);

    fs.writeFileSync(path.join(projPath, "README.md"), "# changed\n");
    fs.writeFileSync(path.join(projPath, "u.txt"), "u\n");
    const r3 = await json(`${api}/git/discard`, { method: "POST", body: JSON.stringify({ all: true }) });
    assert.equal(r3.status, 200, JSON.stringify(r3.body));
    assert.deepEqual(repo.status(), [], "discard all through the route cleans the working tree");
  }));
});
