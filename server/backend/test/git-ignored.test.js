// `GET …/git/ignored` — what git ignores, so that the explorer dims it. The computation lives in git.js `gitIgnored`/`parseIgnored`, the
// route in devtools/code-route.js on BOTH levels (code-scopes.test.js holds the anchor; COPY_READING names it as reading,
// files-in-copy.test.js (6)). The promises:
//   (a) a wholly ignored folder appears ONCE with a trailing "/" (not every file under node_modules), an ignored file with its path;
//       tracked and untracked but not ignored files are missing; per nested repo a list relative to ITS root.
//   (b) When the project lies BELOW the root of its repo, the paths are relative to the project (the folder the tree shows) — not
//       relative to the repo root.
//   (c) Cap with notice: at most IGNORED_CAP entries per repo, `clipped` says there were more.
//   (d) The route on both levels; without a repo an empty list.
//   (e) A folder that holds only ignored files but is not itself ignored (`*.log`, folder `logs/`) does NOT appear as a whole folder
//       in the list — `--directory` reports it so, `git check-ignore` confirms every folder entry; its files individually.
//
// COUNTER-TESTS (one place in git.js changed, only this file run):
//   `--directory` dropped from IGNORED_COMMAND                       ⇒ (a) red (every file under node_modules individually)
//   `git(relPath ? root : projectPath, …)` → `git(root, …)`           ⇒ (b) red (paths relative to the repo root)
//   `clipped: all.length > cap` → `clipped: false`                    ⇒ (c) red
//   the confirmation via `check-ignore` dropped (the filter on the folder entries) ⇒ (e) red (`logs/` as a whole folder)
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/git-ignored.test.js

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { gitIgnored, IGNORED_CAP, parseIgnored } from "../electron/server/git.js";
import { json, makeProject, makeWorkspace, withServer } from "./server-harness.mjs";

// A fixed git environment (code-scopes.test.js GIT_ENVIRONMENT): no ignore file of the machine colors the result.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: "/dev/null", GIT_CONFIG_KEY_1: "core.attributesFile", GIT_CONFIG_VALUE_1: "/dev/null" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" });
function create(root, rel, content = "x\n") {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function repo(dir, ignore) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  create(dir, ".gitignore", ignore);
}
async function withEnvironment(f) {
  const old = {};
  for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"]) { old[k] = process.env[k]; process.env[k] = GIT_ENV[k]; }
  try { return await f(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const withFolder = async (f) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-ignored-")));
  try { return await withEnvironment(() => f(d)); } finally { fs.rmSync(d, { recursive: true, force: true }); }
};

test("(c) parseIgnored: NUL-separated, empty parts dropped, cap with `clipped`", () => {
  assert.deepEqual(parseIgnored("a.log\0node_modules/\0"), { ignored: ["a.log", "node_modules/"], clipped: false });
  assert.deepEqual(parseIgnored(""), { ignored: [], clipped: false });
  assert.deepEqual(parseIgnored("a\0b\0c\0", 2), { ignored: ["a", "b"], clipped: true });
  assert.deepEqual(parseIgnored("a\0b\0", 2), { ignored: ["a", "b"], clipped: false }, "exactly at the cap nothing is clipped");
  const many = Array.from({ length: IGNORED_CAP + 5 }, (_, i) => `f${i}.log`).join("\0");
  const r = parseIgnored(many);
  assert.deepEqual([r.ignored.length, r.clipped], [IGNORED_CAP, true]);
});

test("(a)(b) an ignored folder once with \"/\", files individually, nested repos each on its own, paths relative to the project", async () => {
  await withFolder(async (root) => {
    // (a) The project without a repo of its own, two repos in it.
    const P = path.join(root, "p");
    repo(path.join(P, "web"), "node_modules/\n*.log\n");
    create(P, "web/src/app.ts");
    create(P, "web/node_modules/a/index.js");
    create(P, "web/node_modules/b/index.js");
    create(P, "web/src/error.log");
    // untracked, not ignored:
    create(P, "web/fresh.ts");
    repo(path.join(P, "api"), "dist\n");
    create(P, "api/dist/x.js");
    create(P, "api/main.py");
    const r = await gitIgnored(P);
    assert.deepEqual(r, { repos: [
      { relPath: "api", ignored: ["dist/"], clipped: false },
      { relPath: "web", ignored: ["node_modules/", "src/error.log"], clipped: false },
    ] });

    // (b) The project BELOW the root of its repo.
    const R = path.join(root, "mono");
    repo(R, "build/\n");
    create(R, "packages/till/build/out.js");
    create(R, "packages/till/src/a.ts");
    create(R, "other/build/y.js");
    const bottom = await gitIgnored(path.join(R, "packages", "till"));
    assert.deepEqual(bottom, { repos: [{ relPath: "", ignored: ["build/"], clipped: false }] }, "relative to the project, and only below it");

    assert.deepEqual(await gitIgnored(path.join(root, "empty-exists-not")), { repos: [] });
  });
});

test("(d) the route on both levels", async () => {
  await withServer(async ({ base, wsPath, projPath }) => {
    await withEnvironment(async () => {
      repo(projPath, "*.tmp\ncache/\n");
      create(projPath, "a.tmp");
      create(projPath, "cache/1/2.bin");
      create(projPath, "src/a.ts");
      const ws = await makeWorkspace(base, "Ignored", wsPath);
      const proj = await makeProject(base, ws.id, projPath, "Checkout");
      const p = await json(`${base}/api/projects/${proj.id}/git/ignored`);
      assert.deepEqual([p.status, p.body], [200, { repos: [{ relPath: "", ignored: ["a.tmp", "cache/"], clipped: false }] }]);
      const rel = path.relative(wsPath, projPath).split(path.sep).join("/");
      const w = await json(`${base}/api/workspaces/${ws.id}/git/ignored`);
      assert.deepEqual([w.status, w.body], [200, { repos: [{ relPath: rel, ignored: ["a.tmp", "cache/"], clipped: false }] }], "on workspace level a nested repo");
    });
  });
});

test("(e) a folder with only ignored files is itself not ignored — never dimmed as a whole folder", async () => {
  await withFolder(async (root) => {
    const P = path.join(root, "p");
    repo(P, "*.log\nnode_modules/\n");
    create(P, "logs/a.log");
    create(P, "logs/deep/b.log");
    create(P, "node_modules/x/index.js");
    create(P, "src/a.ts");
    const r = await gitIgnored(P);
    assert.equal(r.repos.length, 1);
    assert.equal(r.repos[0].ignored.includes("logs/"), false, "logs/ is not ignored — a new file in it would not be");
    assert.equal(r.repos[0].ignored.includes("node_modules/"), true, "a really ignored folder stays an entry");
    assert.equal(r.repos[0].ignored.includes("logs/a.log"), true, String(r.repos[0].ignored));
  });
});
