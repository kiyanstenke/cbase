// Guards of the data steps of the relocation (steps 9, 11, 13, the data part of 15; return path 1, 3, 5). Module:
// electron/server/projectbox/relocation/data.js. Without a server and without docker: a real store in a temp folder, real git repos
// and worktrees in the temp tree, the journal over the real table `project_relocations` (the same wiring as the procedure). No
// duration is a criterion.
//
//   (1) Return path 1: a graph worktree with an uncommitted file, step 13 and an error in 14 (through the journal run) => the file at
//       the old place, `graph_starts` columns and subagent image byte-equal, the copies gone. Two subagents whose image lacks a key
//       (only `worktree` or only `cwd`) are included: the return path is byte-equal only if no `"cwd":null` appears afterwards.
//       Counter-test in the test: the same check against "delete the copies from 13 without moving back" => the file is missing.
//   (2) After step 13 resolveCwd returns the moved worktree of the child chat; counter-test in the test: the same move of the
//       worktrees without rewriting the columns => fallback to the workspace with the log line.
//   (3) If a move back fails, the runtime folder stays (`runtimeStays`), and nothing is deleted there.
//   (4) Step 9: service with `-p 3100` and `port` 3100, repo default 3000 => start command without `-p`, `port` 3000; the return path
//       makes `.env`, start command, `service_start_commands` (also "no row") and `port` byte-equal. Without a repo default the start
//       command AND field stay (`worker` keeps `--port 3110`; the tunnel is under `withoutDefault`, not `commandStays`).
//   (5) No env value in journal, database, log or report; counter-test: the same scan finds an injected value.
//   (6) Step 11 only after 9; the project repo arises with a marker and falls on the return path (the files stay).
//   (7) Step 15 (data): backup, override, old chat files and old session copies in B gone, the new ones stay.
//   (8) The pure computations (`envWithDefault` on bytes, `withoutPortOverride`).
//   (9) Nested: a worktree in a worktree (`move` + `repair`) and a run folder without its own repo (rename + `repair`), there and
//       back, with uncommitted files.
//   (10) Every git in data.js carries the hardening — statically (ONE process start, with ...HARDENING) and on the wire with a
//       core.fsmonitor decoy in the repo (`git worktree move` reads the index: unhardened it runs — counter-test in the test).
//   (11) A prefilled target is put aside (relocation location), the living flat version moves, step 15 deletes only what 13 copied;
//       the return path puts the old one back; an entry without `fresh`/`aside` makes step 15 leave things alone.
//   (12) `browser-profiles/proj-<id>` (without lock files) and `service-logs/<id>_<svc>.log` -> `main_<svc>.log` move along; a living
//       lock keeps the flat profile in step 15; the return path removes the copies.
//   (13) A backup that does not match its checksum is never written over the `.env` (there and back).
//   (14) A half `git init` (before the marker) falls there and back — only with `gitPrior: false` and without objects.
//   (15) Only the override of the registered port, only the port field of a URL (docker -p 3100:3000, ssh -p 2222, a `:3100` in the
//        password stay).
//   (16) An override in quotes falls (ONE rule, ./port-command.js); a docker mapping on the old port keeps the field, even with a
//        rebuilt `.env`.
//   (17) A link to the outside as a parent folder under the project's runtime folder => step 13 throws, outside stays empty.
//   (18) A browser profile that became younger after the copy stays in step 15 (`since-copy-changed`).
//   (19) An attachment that arrives flat AFTER step 13 (the upload route writes to `attachmentLocation` = flat until `converted_at`)
//        survives step 15 — its folder stays (`since-copy-changed`), what did not change falls as before; a change with a reset
//        mtime counts too (fingerprint with ctime), an entry without a state stays (`status-unknown`); after the conversion
//        `attachmentPath` finds the attachment at the flat place. LIMIT: the ctime protects an in-place changed file ONLY from deletion
//        in step 15 — if the copy from step 13 lies at the target, it wins everywhere afterwards (`attachmentPath` reads it,
//        `copyAttachmentsTo` copies only what is missing, and the next turn (runs/runtime-location.js bringAlongChat) decides by
//        mtime only — with an equal mtime it discards the changed flat version). Only a NEW attachment (no copy at the target)
//        arrives safely.
//   (20) The port dismantling collapses whitespace only where it removed something — never in quotes elsewhere in the command.
//
// COUNTER-TESTS on the product (each sabotage, run the file, restore):
//   drop `writeRows(fresh)` in relocateRuntime                                      => (1) (2) (3) (7) red
//   portDismantling: `const port = standard ?? old.port` -> `old.port`             => (4) red (3100 instead of 3000)
//   portDismantlingBack: services not reset                                        => (4) (5) red (start command without `-p 3100`)
//   runtimeBack: drop the moving back                                              => (1) (3) red (the file is missing at the old place)
//   portDismantling: the original text in report or log                            => (5) red
//   HARDENING = []                                                                 => (10) red — also with the static part dropped
//   a second, unhardened pexec("git", …) in gitInB                                 => (10) red
//   `createFolderInArea` -> `fs.mkdirSync(…, {recursive})`                         => (17) red
//   `changed && !oldPresent ? port` -> `changed ? port`                                => (16) red
//   the check for remaining overrides also without `command`                       => (4) (5) (7) (13) red
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import * as store from "../electron/server/store.js";
import { DIRS, setDirs } from "../electron/server/app-state.js";
import { JournalTurned, createJournal, run, journalPlan, createRelocationLocation, relocationTime } from "../electron/server/projectbox/journal.js";
import { resolveCwd } from "../electron/server/runs/system-prompt.js";
import { sessionSlug } from "../electron/server/runs/session-transfer.js";
import { projectClaudeDir } from "../electron/server/runs/session-location.js";
import { attachmentLocation, attachmentPath, locationFor } from "../electron/server/runs/runtime-location.js";
import { isProjectRepo } from "../electron/server/git.js";
import * as data from "../electron/server/projectbox/relocation/data.js";

const DATA_SOURCE = new URL("../electron/server/projectbox/relocation/data.js", import.meta.url);

const real = (p) => fs.realpathSync(p);
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function write(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode) fs.chmodSync(file, mode);
}
const worktreeList = (repo) => git(repo, "worktree", "list", "--porcelain").split("\n").filter((z) => z.startsWith("worktree ")).map((z) => real(z.slice(9)));

async function withRelocation(fn, { plan = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-relocation-data-"));
  const savedEnvVars = {};
  const setEnv = (k, v) => { if (!(k in savedEnvVars)) savedEnvVars[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  const prior = DIRS;
  try {
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    for (const [k, v] of Object.entries({ HOME: home, CBASE_CONTAINER: "1", CBASE_DIND: "1", CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined })) setEnv(k, v);
    const D = path.join(root, "data");
    for (const d of ["scratch", "attachments", "outputs"]) fs.mkdirSync(path.join(D, d), { recursive: true });
    setDirs({ data: D, scratch: path.join(D, "scratch"), attachments: path.join(D, "attachments"), outputs: path.join(D, "outputs") });
    store.initStore(D);
    const W = path.join(root, "ws");
    const P = path.join(W, "till");
    write(path.join(P, "README.md"), "till\n");
    git(P, "init", "-q", "-b", "main");
    git(P, "add", "-A");
    git(P, "commit", "-q", "-m", "start");
    store.createWorkspace({ id: "w1", name: "W", path: W, createdAt: Date.now() });
    store.addProject("w1", { id: "p1", name: "Till", path: P, createdAt: Date.now() });
    const relocationLocation = createRelocationLocation({ data: D, projectId: "p1", time: relocationTime() });
    const u = store.createRelocation({ projectId: "p1", location: relocationLocation });
    const journal = createJournal({ read: () => store.readRelocation(u.id), write: (f) => store.writeRelocation(u.id, f) });
    const logs = [];
    const F = path.join(D, "scratch", "worktrees");
    fs.mkdirSync(F, { recursive: true });
    const ctx = {
      projectId: "p1", project: store.getProject("p1"), workspace: store.getWorkspace("w1"), journal, relocationLocation, inst: null, docker: null,
      log: (t) => logs.push(String(t)),
      plan: {
        projectId: "p1", projectPath: P, worktrees: { move: [], stay: [] }, dismantling: { env: [], services: [], overrides: [] },
        local: { entries: [], assignment: {} }, projectRepo: { arises: false, reason: "repo" }, ...plan,
      },
    };
    const newLocation = path.join(D, "projects", "p1");
    return await fn({ root, home, D, W, P, F, ctx, u, logs, newLocation, newF: path.join(newLocation, "worktrees") });
  } finally {
    setDirs(prior);
    for (const [k, v] of Object.entries(savedEnvVars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// A project with a graph child chat (worktree with an unsaved file), a subagent with its own worktree, a subagent in the worktree
// of the child chat, sessions in B, chat files at the flat place and ~/.local.
function seedGraph({ home, W, P, F, ctx }) {
  const g = path.join(F, "graph-abc");
  const a = path.join(F, "agent-a1");
  git(P, "worktree", "add", "-q", "-b", "cbase/graph-abc12345", g, "HEAD");
  git(P, "worktree", "add", "-q", "-b", "cbase/agent-a1", a, "HEAD");
  write(path.join(g, "open.txt"), "unsaved\n");
  store.createChat({ id: "c1", workspaceId: "w1", projectId: "p1", provider: "claude", createdAt: 1, updatedAt: 1 });
  store.createChat({ id: "k1", workspaceId: "w1", projectId: "p1", provider: "claude", createdAt: 1, updatedAt: 1 });
  store.updateChat("c1", { claudeSessionId: "s-c1" });
  store.updateChat("k1", { claudeSessionId: "s-k1" });
  store.createGraphStart({ id: "gs1", chatId: "c1", childChatId: "k1", workflowId: "wf1", workflowName: "Wf", shortName: "wf", background: true, worktree: true, status: "started" });
  store.changeGraphStart("gs1", {
    worktreePath: g,
    worktreeInfo: JSON.stringify({ dir: g, branch: "cbase/graph-abc12345", repos: [{ name: "till", relPath: "", root: P, target: g, base: "b" }], own: [{ path: path.join(g, ".env"), kind: "copy", source: path.join(P, ".env") }] }),
  });
  store.rememberSubagent("c1", { agentId: "a1", name: "one", provider: "claude", model: "m", sessionId: "", state: "finished", status: "completed", cwd: a, worktree: { dir: a, branch: "cbase/agent-a1", repo: P, base: "b" } });
  store.rememberSubagent("k1", { agentId: "a2", name: "two", provider: "claude", model: "m", sessionId: "", state: "finished", status: "completed", cwd: g, worktree: null, instance: "old/main" });
  // Images that LACK a key (only `worktree` or only `cwd`) — the return path leaves it missing (test 1 compares).
  store.rememberSubagent("c1", { agentId: "a3", name: "three", provider: "claude", model: "m", sessionId: "", state: "finished", status: "completed", worktree: { dir: a, branch: "cbase/agent-a1", repo: P, base: "b" } });
  store.rememberSubagent("k1", { agentId: "a4", name: "four", provider: "claude", model: "m", sessionId: "", state: "finished", status: "completed", cwd: g });
  const bClaude = path.join(home, ".claude", "projects");
  write(path.join(bClaude, sessionSlug(real(W)), "s-c1.jsonl"), "c\n");
  write(path.join(bClaude, sessionSlug(real(g)), "s-k1.jsonl"), "k\n");
  write(path.join(DIRS.scratch, "c1.mcp.json"), "{}\n");
  write(path.join(DIRS.attachments, "c1", "image.png"), "png");
  write(path.join(home, ".local", "state", "till-mcp", "state.json"), "{}\n");
  write(path.join(home, ".local", "bin", "tool"), "#!/bin/sh\n", 0o755);
  ctx.plan.worktrees.move = [{ repo: P, path: real(g) }, { repo: P, path: real(a) }];
  ctx.plan.local.assignment = { "state/till-mcp": ["p1"] };
  return { g, a, gReal: real(g) };
}

const columns = () => store.graphWorktreeRows();
const images = () => ["c1", "k1"].flatMap((c) => store.subagentsOf(c));

// ── (1) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(1) return path 1: error in 14 after step 13 => the unsaved file at the old place, columns byte-equal, copies gone — counter-test: deleting copies without moving back loses it", async () => {
  const PLAN = journalPlan({ forward: ["runtime", "check", "start"], backward: ["runtime-back"], pivot: "start" });
  const finding = {};
  for (const [name, back] of [
    ["runtimeBack", (ctx) => data.runtimeBack(ctx)],
    ["naive", async (ctx) => { fs.rmSync(path.join(DIRS.data, "projects", ctx.projectId), { recursive: true, force: true }); }],
  ]) {
    await withRelocation(async (u) => {
      const { g } = seedGraph(u);
      const prior = { columns: columns(), images: images() };
      const newG = path.join(u.newF, "graph-abc");
      const effects = {
        runtime: async () => {
          await data.relocateRuntime(u.ctx);
          if (name !== "runtimeBack") return;
          // State after 13: moved (not copied), rewritten, copied.
          assert.equal(fs.readFileSync(path.join(newG, "open.txt"), "utf8"), "unsaved\n");
          assert.equal(fs.existsSync(g), false, "moved, not copied");
          assert.deepEqual(worktreeList(u.P).sort(), [real(u.P), real(path.join(u.newF, "agent-a1")), real(newG)].sort(), "git knows the new places");
          const info = JSON.parse(columns()[0].info);
          assert.equal(columns()[0].path, newG);
          assert.deepEqual([info.dir, info.repos[0].target, info.own[0].path, info.own[0].source, info.projectId], [newG, newG, path.join(newG, ".env"), path.join(u.P, ".env"), "p1"], "dir, repos[].target, own[].path rewritten, projectId added");
          const [a1, a2] = [store.readSubagent("c1", "a1"), store.readSubagent("k1", "a2")];
          assert.deepEqual([a1.cwd, a1.worktree.dir, a1.instance], [path.join(u.newF, "agent-a1"), path.join(u.newF, "agent-a1"), "p1/main"], "subagent with worktree");
          assert.deepEqual([a2.cwd, a2.instance], [newG, "p1/main"], "subagent in the worktree of the child chat");
          assert.ok(fs.existsSync(path.join(u.newLocation, "scratch", "c1.mcp.json")) && fs.existsSync(path.join(u.newLocation, "attachments", "c1", "image.png")), "chat files copied");
          assert.ok(fs.existsSync(path.join(DIRS.attachments, "c1", "image.png")), "…and the old ones stay until step 15");
          const pl = path.join(u.newLocation, "home", ".local");
          assert.ok(fs.existsSync(path.join(pl, "state", "till-mcp", "state.json")) && fs.existsSync(path.join(pl, "bin", "tool")), "~/.local by the assignment");
          const pc = path.join(projectClaudeDir("p1"), "projects");
          assert.ok(fs.existsSync(path.join(pc, sessionSlug(real(newG)), "s-k1.jsonl")), "child chat: target slug from the NEW worktree");
          assert.ok(fs.existsSync(path.join(pc, sessionSlug(real(u.P)), "s-c1.jsonl")), "project chat: target slug from the project folder");
        },
        check: () => { throw new Error("Manifest differs"); },
        start: () => {},
        "runtime-back": () => back(u.ctx),
      };
      await assert.rejects(run(PLAN, u.ctx.journal, effects, { fresh: true }), (e) => e instanceof JournalTurned && /Manifest/.test(e.message));
      finding[name] = {
        atOldLocation: fs.existsSync(path.join(g, "open.txt")) && fs.readFileSync(path.join(g, "open.txt"), "utf8") === "unsaved\n",
        columns: JSON.stringify(columns()) === JSON.stringify(prior.columns),
      };
      if (name === "runtimeBack") {
        assert.deepEqual(columns(), prior.columns, "graph_starts: worktree_path and worktree_info byte-equal");
        assert.deepEqual(images(), prior.images, "subagent image as before (instance of the second back to \"old/main\")");
        assert.deepEqual(worktreeList(u.P).sort(), [real(u.P), real(path.join(u.F, "agent-a1")), real(g)].sort(), "git knows the old places again");
        assert.equal(fs.existsSync(path.join(u.newF, "graph-abc")), false);
        assert.equal(fs.existsSync(path.join(u.newLocation, "attachments", "c1")), false, "chat copies gone");
        assert.equal(fs.existsSync(path.join(u.newLocation, "home", ".local")), false, "~/.local copy gone");
        assert.equal(fs.existsSync(path.join(projectClaudeDir("p1"), "projects")), false, "session copies gone");
        assert.ok(fs.existsSync(path.join(u.home, ".claude", "projects", sessionSlug(real(g)), "s-k1.jsonl")), "the session in B stayed");
        const z = store.readRelocation(u.u.id);
        assert.equal(z.direction, "backward");
        assert.equal(z.worktrees.list.length, 2, "journal: repo, old and new path per worktree");
        assert.ok(z.worktrees.list.every((w) => w.repo === u.P && w.old && w.fresh));
      }
    });
  }
  assert.deepEqual(finding.runtimeBack, { atOldLocation: true, columns: true }, "the return path brings the file back");
  assert.equal(finding.naive.atOldLocation, false, "counter-test: deleting copies without moving back loses the unsaved file — the check is red");
});

// ── (2) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(2) after step 13 resolveCwd returns the moved worktree of the graph child chat — counter-test without rewriting the columns: fallback with a log line", async () => {
  await withRelocation(async (u) => {
    seedGraph(u);
    await data.relocateRuntime(u.ctx);
    assert.equal(resolveCwd(store.getChat("k1")), path.join(u.newF, "graph-abc"));
  });
  await withRelocation(async (u) => {
    const { g } = seedGraph(u);
    // The same move of the worktrees, but the columns stay old.
    const fresh = path.join(u.newF, "graph-abc");
    fs.mkdirSync(u.newF, { recursive: true });
    git(u.P, "worktree", "move", g, fresh);
    const log = mock.method(console, "log", () => {});
    try {
      const cwd = resolveCwd(store.getChat("k1"));
      assert.notEqual(cwd, fresh, "without rewriting, resolveCwd does not find the moved worktree");
      assert.equal(cwd, u.W, "…and falls back to the workspace");
      assert.ok(log.mock.calls.some((c) => /\[graph-worktree\] k1: the worktree .* is missing/.test(String(c.arguments[0]))), "with the log line");
    } finally { log.mock.restore(); }
  });
});

// ── (3) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(3) if a move back fails, the runtime folder stays: runtimeStays, and nothing is deleted there", async () => {
  await withRelocation(async (u) => {
    const { g } = seedGraph(u);
    await data.relocateRuntime(u.ctx);
    fs.mkdirSync(g); // something lies at the old place meanwhile — the move back refuses
    const r = await data.runtimeBack(u.ctx);
    assert.equal(r.runtimeStays, u.newLocation);
    assert.ok(r.error.length >= 1);
    assert.equal(fs.readFileSync(path.join(u.newF, "graph-abc", "open.txt"), "utf8"), "unsaved\n", "the worktree with the file is still in the runtime folder");
    assert.ok(fs.existsSync(path.join(u.newLocation, "attachments", "c1", "image.png")), "no copy removed");
    assert.equal(columns()[0].path, path.join(u.newF, "graph-abc"), "the column still points to where it lies");
    assert.ok(u.logs.some((l) => /the runtime folder .* stays/.test(l)));
    // The other worktree (agent-a1) came back, with its image.
    assert.equal(store.readSubagent("c1", "a1").cwd, path.join(u.F, "agent-a1"));
  });
});

// ── (4) and (5) ─────────────────────────────────────────────────────────────────────────────────────────────────────

const SECRET = "secret-value-9f3a71";
function seedServices({ P, ctx }) {
  const env = Buffer.concat([Buffer.from(`# Till\r\nPORT=3100\r\nexport NEXT_PUBLIC_API_URL="http://localhost:3101/api"\r\nSECRET=${SECRET}\r\nNAME=Kässe `, "utf8"), Buffer.from([0xff, 0x0a])]);
  write(path.join(P, ".env"), env, 0o640);
  write(path.join(P, ".env.example"), "PORT=3000\nNEXT_PUBLIC_API_URL=http://localhost:3001/api\n");
  write(path.join(P, "docker-compose.cbase.yml"), "services: {}\n");
  const web = store.addProjectService("p1", { name: "web", port: 3100, startCommand: "next dev -p 3100 --turbo" });
  store.updateProjectService(web.id, { startCommand: "next dev -p 3100 --turbo" }); // one row in service_start_commands
  const api = store.addProjectService("p1", { name: "api", port: 3101, startCommand: "PORT=3101 node server.js" }); // no row
  const without = store.addProjectService("p1", { name: "worker", port: 3110, startCommand: "npm run dev -- --port 3110" });
  ctx.plan.dismantling = {
    env: [{ file: ".env", key: "PORT", port: 3100, standard: 3000 }, { file: ".env", key: "NEXT_PUBLIC_API_URL", port: 3101, standard: 3001 }],
    services: [
      { id: web.id, name: "web", portOld: 3100, portStandard: 3000, source: ".env.example", command: true, env: true },
      { id: api.id, name: "api", portOld: 3101, portStandard: 3001, source: "package.json", command: true, env: false },
      { id: without.id, name: "worker", portOld: 3110, portStandard: null, source: null, command: true, env: false },
    ],
    overrides: [{ file: "docker-compose.cbase.yml", ofCbase: true }, { file: "docker-compose.override.yml", ofCbase: false }],
  };
  return { env, web, api, without };
}
const serviceStatus = (id) => { const s = store.getProjectService(id); return { startCommand: s.startCommand, port: s.port, row: store.serviceStartRow("p1", s.name) }; };

test("(4) step 9: -p 3100/port 3100, default 3000 => without -p, port 3000; the return path makes .env, start command, service_start_commands (also \"no row\") and port byte-equal", async () => {
  await withRelocation(async (u) => {
    const { env, web, api, without } = seedServices(u);
    const prior = { web: serviceStatus(web.id), api: serviceStatus(api.id), without: serviceStatus(without.id) };
    assert.equal(prior.api.row, null, "api has no row in service_start_commands");
    const b = await data.portDismantling(u.ctx);
    assert.deepEqual([serviceStatus(web.id).startCommand, serviceStatus(web.id).port, serviceStatus(web.id).row.startCommand], ["next dev --turbo", 3000, "next dev --turbo"]);
    assert.deepEqual([serviceStatus(api.id).startCommand, serviceStatus(api.id).port, serviceStatus(api.id).row], ["node server.js", 3001, null], "no row stays no row");
    assert.deepEqual([serviceStatus(without.id).startCommand, serviceStatus(without.id).port], ["npm run dev -- --port 3110", 3110], "without a recognisable default the start command AND field stay (otherwise `--port` would fall, the service would start on its framework port while the field showed 3110)");
    assert.deepEqual(b.withoutDefault, ["worker"], "…and the report names the service");
    const newEnv = fs.readFileSync(path.join(u.P, ".env"));
    assert.ok(newEnv.equals(Buffer.concat([Buffer.from(`# Till\r\nPORT=3000\r\nexport NEXT_PUBLIC_API_URL="http://localhost:3001/api"\r\nSECRET=${SECRET}\r\nNAME=Kässe `, "utf8"), Buffer.from([0xff, 0x0a])])), "only the port numbers changed, every other byte stays");
    assert.equal(fs.statSync(path.join(u.P, ".env")).mode & 0o777, 0o640, "the file permissions stay");
    const names = fs.readdirSync(path.join(u.ctx.relocationLocation, data.LOCATION_ENV)).sort();
    assert.equal(names.length, 2, `backup and checksum, no .tmp (${names.join(", ")})`);
    const backup = path.join(u.ctx.relocationLocation, data.LOCATION_ENV, names.find((n) => !n.endsWith(data.ENV_CHECK)));
    assert.ok(fs.readFileSync(backup).equals(env), "the original byte for byte in the relocation location");
    assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
    const check = `${backup}${data.ENV_CHECK}`;
    assert.deepEqual(JSON.parse(fs.readFileSync(check, "utf8")), { size: env.length, sha256: crypto.createHash("sha256").update(env).digest("hex") }, "checksum of the original next to it");
    assert.equal(fs.statSync(check).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(u.P, "docker-compose.cbase.yml")), false, "the override file of cbase lies aside");
    const z = store.readRelocation(u.u.id);
    assert.deepEqual(z.dismantling, [{ file: ".env", key: ["NEXT_PUBLIC_API_URL", "PORT"] }]);
    assert.deepEqual(z.services.map((d) => [d.name, d.startCommand, d.port, d.startRow && d.startRow.startCommand]), [
      ["web", "next dev -p 3100 --turbo", 3100, "next dev -p 3100 --turbo"], ["api", "PORT=3101 node server.js", 3101, null], ["worker", "npm run dev -- --port 3110", 3110, null],
    ], "the old values are in the journal, \"no row\" as null");

    // Repeated (after a crash): the same result, the backup stays the original.
    await data.portDismantling(u.ctx);
    assert.ok(fs.readFileSync(path.join(u.P, ".env")).equals(newEnv));
    assert.ok(fs.readFileSync(backup).equals(env));

    await data.portDismantlingBack(u.ctx);
    assert.ok(fs.readFileSync(path.join(u.P, ".env")).equals(env), ".env byte-equal");
    assert.deepEqual({ web: serviceStatus(web.id), api: serviceStatus(api.id), without: serviceStatus(without.id) }, prior, "start command, port and service_start_commands byte-equal");
    assert.equal(fs.readFileSync(path.join(u.P, "docker-compose.cbase.yml"), "utf8"), "services: {}\n", "override back");
    assert.equal(fs.existsSync(backup), false, "the backup falls after the confirmed write-back");
    assert.equal(fs.existsSync(check), false, "…with checksum");
    await data.portDismantlingBack(u.ctx); // repeatable
    assert.deepEqual({ web: serviceStatus(web.id), api: serviceStatus(api.id), without: serviceStatus(without.id) }, prior);
  });
});

test("(5) no env value in journal, database, log or report — counter-test: the same scan finds an injected value", async () => {
  await withRelocation(async (u) => {
    seedServices(u);
    const consoleLog = [];
    const fang = ["log", "warn", "error", "info"].map((m) => mock.method(console, m, (...a) => { consoleLog.push(a.map(String).join(" ")); }));
    let reports;
    try {
      reports = [await data.portDismantling(u.ctx), await data.projectRepoStep(u.ctx), await data.portDismantlingBack(u.ctx)];
    } finally { for (const f of fang) f.mock.restore(); }
    const dbFiles = () => fs.readdirSync(u.D).filter((n) => n.startsWith("automater.db")).map((n) => fs.readFileSync(path.join(u.D, n)));
    const finds = (value) => ({
      db: dbFiles().some((b) => b.includes(Buffer.from(value))),
      journal: JSON.stringify(store.readRelocation(u.u.id)).includes(value),
      log: [...u.logs, ...consoleLog].some((l) => l.includes(value)),
      report: JSON.stringify(reports).includes(value),
    });
    assert.deepEqual(finds(SECRET), { db: false, journal: false, log: false, report: false });
    // Counter-test: the scan sees a value that did get into the database.
    store.createChat({ id: "leak", workspaceId: "w1", title: `leak ${SECRET}`, createdAt: 1, updatedAt: 1 });
    assert.equal(finds(SECRET).db, true, "the scan of the database file finds an injected value");
  });
});

// ── (6) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(6) step 11 only after 9; the project repo arises with a marker, the return path removes only .git", async () => {
  await withRelocation(async (u) => {
    const Q = path.join(u.W, "notes");
    write(path.join(Q, "plan.md"), "# Plan\n");
    store.addProject("w1", { id: "p2", name: "Notes", path: Q, createdAt: Date.now() });
    u.ctx.project = store.getProject("p2");
    u.ctx.plan.projectRepo = { arises: true, reason: null, files: [{ path: "plan.md", bytes: 7 }] };
    await assert.rejects(data.projectRepoStep(u.ctx), (e) => e.step === "project-repo" && /step 9/.test(e.message), "before the port dismantling");
    await data.portDismantling(u.ctx);
    const r = await data.projectRepoStep(u.ctx);
    assert.equal(r.created, true);
    assert.match(git(Q, "log", "--format=%s", "-1"), /State at relocation/);
    assert.equal(store.readRelocation(u.u.id).projectRepo.state, "created");
    assert.deepEqual(await data.projectRepoStep(u.ctx), { created: true, commit: r.commit, alreadyThere: true }, "repeatable");
    const z = await data.projectRepoBack(u.ctx);
    assert.equal(z.removed, true);
    assert.equal(fs.existsSync(path.join(Q, ".git")), false);
    assert.equal(fs.readFileSync(path.join(Q, "plan.md"), "utf8"), "# Plan\n", "the files stay");
  });
  await withRelocation(async (u) => {
    // A project folder that is a repo itself: nothing arises, nothing falls.
    await data.portDismantling(u.ctx);
    u.ctx.plan.projectRepo = { arises: true };
    assert.equal((await data.projectRepoStep(u.ctx)).created, false);
    assert.equal((await data.projectRepoBack(u.ctx)).removed, false);
    assert.ok(fs.existsSync(path.join(u.P, ".git")), "the code repo stays");
  });
});

// ── (7) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(7) step 15 (data): backup, override, old chat files and old session copies in B gone — the new ones stay", async () => {
  await withRelocation(async (u) => {
    const { gReal } = seedGraph(u);
    seedServices(u);
    await data.portDismantling(u.ctx);
    await data.relocateRuntime(u.ctx);
    const r = await data.cleanUpAfterStart(u.ctx);
    assert.deepEqual(r.error, []);
    assert.equal(fs.existsSync(path.join(u.ctx.relocationLocation, data.LOCATION_ENV)), false, "`.env` backup gone");
    assert.equal(fs.existsSync(path.join(u.ctx.relocationLocation, data.LOCATION_OVERRIDE)), false, "override gone");
    assert.equal(fs.existsSync(path.join(DIRS.attachments, "c1")), false, "old chat files gone");
    assert.ok(fs.existsSync(path.join(u.newLocation, "attachments", "c1", "image.png")), "the new ones stay");
    const b = path.join(u.home, ".claude", "projects");
    assert.equal(fs.existsSync(path.join(b, sessionSlug(gReal), "s-k1.jsonl")), false, "old session in B gone");
    assert.ok(fs.existsSync(path.join(projectClaudeDir("p1"), "projects", sessionSlug(real(path.join(u.newF, "graph-abc"))), "s-k1.jsonl")), "the new one stays");
  });
});

// ── (8) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(8) pure computations: port number only in the key's line, every other byte stays; start command without override", () => {
  const one = Buffer.from("PORT=3100\nAPI=http://127.0.0.1:3100/x\nDIFFERENT=:3100\nCOUNT=31000\n#PORT=3100\nWEB_PORT='3100'\n", "latin1");
  const r = data.envWithDefault(one, [
    { key: "PORT", port: 3100, standard: 3000 }, { key: "API", port: 3100, standard: 3000 },
    { key: "WEB_PORT", port: 3100, standard: 3000 }, { key: "MISSING", port: 1, standard: 2 },
  ]);
  assert.equal(r.buf.toString("latin1"), "PORT=3000\nAPI=http://127.0.0.1:3000/x\nDIFFERENT=:3100\nCOUNT=31000\n#PORT=3100\nWEB_PORT='3000'\n");
  assert.deepEqual([r.hit, r.missed], [["API", "PORT", "WEB_PORT"], ["MISSING"]]);
  for (const [before, to] of [
    ["next dev -p 3100", "next dev"], ["next dev -p 3100 --turbo", "next dev --turbo"], ["npm run dev -- -p 3100", "npm run dev"],
    ["PORT=3101 node server.js", "node server.js"], ["VITE_PORT=5174 vite --port=5174 --host", "vite --host"], ["uvicorn app:app --port 8001", "uvicorn app:app"],
    ["docker compose -p till up", "docker compose -p till up"], ["", ""],
  ]) assert.equal(data.withoutPortOverride(before), to, before);
});

// ── (9) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(9) nested run folders: a worktree in a worktree and a run folder without its own repo move with their git administration there and back", async () => {
  await withRelocation(async (u) => {
    // P is a repo with its own repo `sub` inside (ignored); M is a folder without a repo containing two repos.
    const sub = path.join(u.P, "sub");
    write(path.join(sub, "s.txt"), "s\n");
    git(sub, "init", "-q", "-b", "main"); git(sub, "add", "-A"); git(sub, "commit", "-q", "-m", "s");
    write(path.join(u.P, ".gitignore"), "sub/\n");
    const M = path.join(u.W, "multi");
    for (const r of ["a", "b"]) {
      write(path.join(M, r, "x.txt"), `${r}\n`);
      git(path.join(M, r), "init", "-q", "-b", "main"); git(path.join(M, r), "add", "-A"); git(path.join(M, r), "commit", "-q", "-m", r);
    }
    const n = path.join(u.F, "graph-n");
    const m = path.join(u.F, "graph-m");
    git(u.P, "worktree", "add", "-q", "-b", "cbase/graph-n", n, "HEAD");
    git(sub, "worktree", "add", "-q", "-b", "cbase/graph-n", path.join(n, "sub"), "HEAD");
    for (const r of ["a", "b"]) git(path.join(M, r), "worktree", "add", "-q", "-b", "cbase/graph-m", path.join(m, r), "HEAD");
    write(path.join(n, "sub", "open.txt"), "inside\n");
    write(path.join(m, "b", "open.txt"), "b-open\n");
    u.ctx.plan.worktrees.move = [
      { repo: u.P, path: real(n) }, { repo: sub, path: real(path.join(n, "sub")) },
      { repo: path.join(M, "a"), path: real(path.join(m, "a")) }, { repo: path.join(M, "b"), path: real(path.join(m, "b")) },
    ];
    const r = await data.relocateRuntime(u.ctx);
    assert.equal(r.worktrees, 4);
    const nNew = path.join(u.newF, "graph-n");
    const mNew = path.join(u.newF, "graph-m");
    assert.equal(fs.readFileSync(path.join(nNew, "sub", "open.txt"), "utf8"), "inside\n");
    assert.equal(fs.readFileSync(path.join(mNew, "b", "open.txt"), "utf8"), "b-open\n");
    assert.ok(worktreeList(sub).includes(real(path.join(nNew, "sub"))), "the inner worktree is followed up at its repo");
    assert.ok(worktreeList(path.join(M, "a")).includes(real(path.join(mNew, "a"))));
    assert.match(git(path.join(mNew, "b"), "status", "--porcelain"), /open\.txt/, "git works in the moved worktree");
    assert.equal(git(path.join(nNew, "sub"), "rev-parse", "--show-toplevel").trim(), real(path.join(nNew, "sub")));

    const z = await data.runtimeBack(u.ctx);
    assert.equal(z.runtimeStays, null);
    assert.equal(fs.readFileSync(path.join(n, "sub", "open.txt"), "utf8"), "inside\n");
    assert.equal(fs.readFileSync(path.join(m, "b", "open.txt"), "utf8"), "b-open\n");
    assert.ok(worktreeList(sub).includes(real(path.join(n, "sub"))) && worktreeList(path.join(M, "b")).includes(real(path.join(m, "b"))), "git knows the old places again");
    assert.deepEqual(fs.readdirSync(u.newF), [], "no worktree left in the runtime folder");
  });
});

// ── (10) ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(10) every git in data.js carries the hardening — statically at the source and on the wire with an fsmonitor decoy (counter-test in the test: unhardened it runs)", async () => {
  // Static: ONE process start (gitInB, with ...HARDENING before every argument), ONE way through runtime/git-run.js (without an
  // instance, fallback gitInB). A second start or a call without the hardening turns this red. Comment lines do not count.
  const code = fs.readFileSync(DATA_SOURCE, "utf8").split("\n").filter((z) => !/^\s*\/\//.test(z)).join("\n");
  assert.match(code, /const HARDENING = \["-c", "core\.hooksPath=\/dev\/null", "-c", "core\.fsmonitor=false"\];/, "the hardening itself");
  assert.deepEqual(code.match(/import \{[^}]*\} from "node:child_process";/g), ['import { execFile } from "node:child_process";'], "from child_process ONLY execFile");
  assert.deepEqual(code.match(/\bpexec\(/g), ["pexec("], "exactly ONE process start");
  assert.match(code, /pexec\("git", \[\.\.\.HARDENING, \.\.\.args\]/, "…and it carries the hardening before every argument");
  assert.deepEqual(code.match(/\bgitRun\(/g), ["gitRun("], "exactly one way through runtime/git-run.js");
  assert.match(code, /gitRun\(null, cwd, args, \{ fallback: \(\) => gitInB\(cwd, args\) \}\)/, "…without an instance, fallback gitInB");
  for (const re of [/\bexecFile\(/, /\bexecFileSync\b/, /\bspawn(?:Sync)?\(/, /\bexec(?:Sync)?\(/, /\bfork\(/]) assert.doesNotMatch(code, re);

  // On the wire: `git worktree move` reads the index of the worktree — a core.fsmonitor of the repo would run (measured).
  await withRelocation(async (u) => {
    seedGraph(u);
    const marker = path.join(u.root, "fsmonitor-ran");
    const decoy = path.join(u.root, "decoy.sh");
    write(decoy, `#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n`, 0o755);
    git(u.P, "config", "core.fsmonitor", decoy);
    await data.relocateRuntime(u.ctx);
    const z = await data.runtimeBack(u.ctx);
    assert.equal(z.runtimeStays, null);
    assert.equal(fs.existsSync(marker), false, "no fsmonitor of the repo ran — neither when moving nor back");
    // Counter-test: the same decoy runs on an UNHARDENED `git worktree move` — the check above is not blind.
    const w = path.join(u.root, "against-w");
    git(u.P, "-c", "core.fsmonitor=false", "worktree", "add", "-q", "-b", "against", w, "HEAD");
    git(u.P, "worktree", "move", w, `${w}-2`);
    assert.equal(fs.existsSync(marker), true, "unhardened the decoy runs");
  });
});

// ── (11) ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const content = (dir) => Object.fromEntries(fs.readdirSync(dir, { recursive: true }).map(String).sort()
  .filter((n) => fs.lstatSync(path.join(dir, n)).isFile()).map((n) => [n, fs.readFileSync(path.join(dir, n), "utf8")]));

test("(11) a prefilled target (an earlier relocation left the runtime folder) is put aside instead of overwritten — the living flat version moves, step 15 deletes only what 13 copied; back, the old one lies at the target again", async () => {
  const prefill = (u) => {
    const target = path.join(u.newLocation, "attachments", "c1");
    write(path.join(target, "image.png"), "old");
    write(path.join(target, "only-old.txt"), "only old");
    write(path.join(DIRS.attachments, "c1", "fresh.txt"), "since relocation 1"); // the chat kept working flat
    return target;
  };
  await withRelocation(async (u) => {
    seedGraph(u);
    const target = prefill(u);
    const aside = path.join(u.ctx.relocationLocation, data.LOCATION_PREFILLED, "attachments", "c1");
    const b = await data.relocateRuntime(u.ctx);
    assert.deepEqual(content(target), { "image.png": "png", "fresh.txt": "since relocation 1" }, "at the target exactly the living version — nothing old mixed in");
    assert.deepEqual(content(aside), { "image.png": "old", "only-old.txt": "only old" }, "the prefilled version lies aside, unchanged");
    assert.equal(b.aside, 1);
    await data.relocateRuntime(u.ctx); // a second run puts nothing aside a second time
    assert.deepEqual(content(aside), { "image.png": "old", "only-old.txt": "only old" });
    const r = await data.cleanUpAfterStart(u.ctx);
    assert.deepEqual(r.error, []);
    assert.equal(fs.existsSync(path.join(DIRS.attachments, "c1")), false, "the flat version falls because 13 copied it");
    assert.deepEqual(content(target), { "image.png": "png", "fresh.txt": "since relocation 1" }, "nothing lost");
    assert.deepEqual(r.aside, [aside], "the report names the version put aside, step 15 leaves it");
  });
  await withRelocation(async (u) => {
    seedGraph(u);
    const target = prefill(u);
    await data.relocateRuntime(u.ctx);
    const z = await data.runtimeBack(u.ctx);
    assert.equal(z.runtimeStays, null);
    assert.deepEqual(content(target), { "image.png": "old", "only-old.txt": "only old" }, "back: the old version at the target again, byte-equal");
    assert.equal(fs.existsSync(path.join(u.ctx.relocationLocation, data.LOCATION_PREFILLED, "attachments", "c1")), false);
    assert.deepEqual(content(path.join(DIRS.attachments, "c1")), { "image.png": "png", "fresh.txt": "since relocation 1" }, "flat untouched");
  });
  await withRelocation(async (u) => {
    // An entry from the version before `aside` (`fresh: false`, nothing copied): step 15 leaves the flat version.
    const from = path.join(DIRS.attachments, "c1");
    const to = path.join(u.newLocation, "attachments", "c1");
    write(path.join(from, "fresh.txt"), "live");
    write(path.join(to, "old.txt"), "old");
    await u.ctx.journal.note({ copies: { chat: [{ chatId: "c1", from, to, fresh: false }] } });
    const r = await data.cleanUpAfterStart(u.ctx);
    assert.equal(fs.readFileSync(path.join(from, "fresh.txt"), "utf8"), "live", "not copied => not deleted");
    assert.deepEqual(r.stays, [{ chatId: "c1", path: from, reason: "target-prefilled" }]);
  });
});

// ── (12) ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(12) the project's browser profile and its service logs move along (without the lock files); step 15 removes the flat ones unless the lock lives; the return path removes the copies", async () => {
  const seedProject = (u, lockPid) => {
    const flat = locationFor({});
    const profile = path.join(flat.browserProfiles, "proj-p1");
    write(path.join(profile, "Default", "Cookies"), "cookie");
    fs.symlinkSync(`${os.hostname()}-${lockPid}`, path.join(profile, "SingletonLock"));
    const svc = store.addProjectService("p1", { name: "web", port: 3000, startCommand: "next dev" });
    const log = path.join(flat.serviceLogs, `p1_${svc.id}.log`);
    write(log, "line 1\n");
    const fresh = locationFor({ projectId: "p1", converted: true });
    return { profile, log, newProfile: path.join(fresh.browserProfiles, "proj-p1"), newLog: path.join(fresh.serviceLogs, `main_${svc.id}.log`) };
  };
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  await withRelocation(async (u) => {
    const o = seedProject(u, deadPid);
    const b = await data.relocateRuntime(u.ctx);
    assert.equal(b.project, 2);
    assert.equal(fs.readFileSync(path.join(o.newProfile, "Default", "Cookies"), "utf8"), "cookie", "the profile with its logins where projectBrowserProfile reads after the conversion");
    assert.equal(fs.existsSync(o.newProfile) && fs.readdirSync(o.newProfile).includes("SingletonLock"), false, "without the lock of a running instance");
    assert.equal(fs.readFileSync(o.newLog, "utf8"), "line 1\n", "the service log under the name of the instance (where the service attaches)");
    const r = await data.cleanUpAfterStart(u.ctx);
    assert.deepEqual([r.error, r.stays, r.project], [[], [], 2]);
    assert.equal(fs.existsSync(o.profile) || fs.existsSync(o.log), false, "the flat ones gone");
  });
  await withRelocation(async (u) => {
    const o = seedProject(u, process.pid); // the lock LIVES — its Chromium keeps writing flat
    await data.relocateRuntime(u.ctx);
    const r = await data.cleanUpAfterStart(u.ctx);
    assert.deepEqual(r.stays, [{ kind: "browser", path: o.profile, reason: "in-use" }]);
    assert.equal(fs.readFileSync(path.join(o.profile, "Default", "Cookies"), "utf8"), "cookie", "the flat profile stays");
  });
  await withRelocation(async (u) => {
    const o = seedProject(u, deadPid);
    await data.relocateRuntime(u.ctx);
    const z = await data.runtimeBack(u.ctx);
    assert.equal(z.runtimeStays, null);
    assert.equal(fs.existsSync(o.newProfile) || fs.existsSync(o.newLog), false, "the copies gone");
    assert.equal(fs.readFileSync(path.join(o.profile, "Default", "Cookies"), "utf8"), "cookie", "flat untouched");
    assert.ok(fs.lstatSync(path.join(o.profile, "SingletonLock")).isSymbolicLink());
  });
});

// ── (13) ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(13) a backup that does not match its checksum (empty after a crash) is never written over the .env — not there, not back; if the .env itself is the original, the return path is done for it", async () => {
  await withRelocation(async (u) => {
    const { env } = seedServices(u);
    await data.portDismantling(u.ctx);
    const envFile = path.join(u.P, ".env");
    const changed = fs.readFileSync(envFile);
    const dir = path.join(u.ctx.relocationLocation, data.LOCATION_ENV);
    const backup = path.join(dir, fs.readdirSync(dir).find((n) => !n.endsWith(data.ENV_CHECK)));
    fs.truncateSync(backup, 0); // what a SIGKILL between open and write or a crash without fsync would leave
    await assert.rejects(data.portDismantling(u.ctx), (e) => e.step === "port-dismantling" && /checksum/.test(e.message) && !e.message.includes(SECRET));
    assert.ok(fs.readFileSync(envFile).equals(changed), "there: the .env untouched");
    await assert.rejects(data.portDismantlingBack(u.ctx), (e) => e.step === "port-dismantling-back" && /checksum/.test(e.message) && !e.message.includes(SECRET));
    assert.ok(fs.readFileSync(envFile).equals(changed), "back: the .env not truncated to 0 bytes");
    assert.ok(fs.existsSync(backup) && fs.existsSync(`${backup}${data.ENV_CHECK}`), "backup and checksum stay");
    fs.writeFileSync(envFile, env); // the .env is (again) the original
    await data.portDismantlingBack(u.ctx);
    assert.ok(fs.readFileSync(envFile).equals(env));
    assert.deepEqual(fs.readdirSync(dir), [], "backup and checksum gone");
  });
});

// ── (14) ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(14) a death between git init and the marker — \"running\" carries gitPrior, the half .git falls there and back; a foreign .git (gitPrior true or unknown, or with objects) stays", async () => {
  const withQ = (fn) => withRelocation(async (u) => {
    const Q = path.join(u.W, "notes");
    write(path.join(Q, "plan.md"), "# Plan\n");
    store.addProject("w1", { id: "p2", name: "Notes", path: Q, createdAt: Date.now() });
    u.ctx.project = store.getProject("p2");
    u.ctx.plan.projectRepo = { arises: true, reason: null };
    await data.portDismantling(u.ctx);
    return fn(u, Q);
  });
  const halfGit = (Q) => git(Q, "init", "-q", "-b", "main"); // the repo creation up to before the marker
  await withQ(async (u, Q) => {
    const noted = [];
    const j = u.ctx.journal;
    u.ctx.journal = { snapshot: () => j.snapshot(), note: (f) => { noted.push(JSON.parse(JSON.stringify(f))); return j.note(f); } };
    await data.projectRepoStep(u.ctx);
    assert.deepEqual(noted.find((f) => f.projectRepo?.state === "running")?.projectRepo, { path: Q, state: "running", gitPrior: false });
  });
  await withQ(async (u, Q) => {
    await u.ctx.journal.note({ projectRepo: { path: Q, state: "running", gitPrior: false } });
    halfGit(Q);
    assert.deepEqual(await data.projectRepoBack(u.ctx), { removed: true, reason: "half-created" });
    assert.equal(fs.existsSync(path.join(Q, ".git")), false);
    assert.equal(fs.readFileSync(path.join(Q, "plan.md"), "utf8"), "# Plan\n", "the files stay");
  });
  await withQ(async (u, Q) => {
    await u.ctx.journal.note({ projectRepo: { path: Q, state: "running", gitPrior: false } });
    halfGit(Q);
    const r = await data.projectRepoStep(u.ctx);
    assert.equal(r.created, true, "there: the half .git falls, the project repo arises properly");
    assert.equal(isProjectRepo(Q), true);
  });
  for (const [what, prior, commit] of [["gitPrior true", true, false], ["gitPrior unknown", undefined, false], ["with objects", false, true]]) {
    await withQ(async (u, Q) => {
      await u.ctx.journal.note({ projectRepo: { path: Q, state: "running", ...(prior === undefined ? {} : { gitPrior: prior }) } });
      halfGit(Q);
      if (commit) { git(Q, "add", "-A"); git(Q, "commit", "-q", "-m", "own"); }
      assert.deepEqual(await data.projectRepoBack(u.ctx), { removed: false, reason: "without-marker" }, what);
      assert.ok(fs.existsSync(path.join(Q, ".git")), `${what}: the .git stays`);
    });
  }
});

// ── (15) ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(15) the port dismantling changes only the override of the registered port and only the port field of a URL — docker -p 3100:3000, ssh -p 2222 and a :3100 in the password stay", async () => {
  for (const [before, ports, to] of [
    ["docker run --rm -p 3100:3000 shop-web", [3100], "docker run --rm -p 3100:3000 shop-web"],
    ["ssh -N -p 2222 -L 5432:db:5432 host", [5432], "ssh -N -p 2222 -L 5432:db:5432 host"],
    ["next dev -p 3100 --turbo", [3100], "next dev --turbo"],
    ["next  dev   -p 3200", [3100], "next  dev   -p 3200"], // nothing removed => byte-equal, also the spaces
    ["PORT=3101 node server.js", [3101], "node server.js"],
  ]) assert.equal(data.withoutPortOverride(before, ports), to, before);
  assert.equal(data.withoutPortOverride("docker run --rm -p 3100:3000 shop-web"), "docker run --rm -p 3100:3000 shop-web", "a docker mapping stays even without a port list");
  const env = Buffer.from("DATABASE_URL=postgres://app:3100secret@localhost:3100/db\nTWO=postgres://app:3100@db:3100/x\nHOSTS=a:3100,b:3100\nREDIS=\"redis://h:3100\"\n", "latin1");
  const r = data.envWithDefault(env, ["DATABASE_URL", "TWO", "HOSTS", "REDIS"].map((key) => ({ key, port: 3100, standard: 3000 })));
  assert.equal(r.buf.toString("latin1"), "DATABASE_URL=postgres://app:3100secret@localhost:3000/db\nTWO=postgres://app:3100@db:3000/x\nHOSTS=a:3000,b:3000\nREDIS=\"redis://h:3000\"\n", "only the port field, never the password");
  await withRelocation(async (u) => {
    const shop = store.addProjectService("p1", { name: "shop", port: 3100, startCommand: "docker run --rm -p 3100:3000 shop-web" });
    const tunnel = store.addProjectService("p1", { name: "tunnel", port: 5432, startCommand: "ssh -N -p 2222 -L 5432:db:5432 host" });
    u.ctx.plan.dismantling = { env: [], overrides: [], services: [
      { id: shop.id, name: "shop", portOld: 3100, portStandard: 3000, source: "framework:x", command: true, env: false },
      { id: tunnel.id, name: "tunnel", portOld: 5432, portStandard: null, source: null, command: true, env: false },
    ] };
    const b = await data.portDismantling(u.ctx);
    assert.deepEqual([serviceStatus(shop.id).startCommand, serviceStatus(shop.id).port], ["docker run --rm -p 3100:3000 shop-web", 3100], "docker mapping stays, the field too (the dismantling did not change the port)");
    assert.deepEqual([serviceStatus(tunnel.id).startCommand, serviceStatus(tunnel.id).port], ["ssh -N -p 2222 -L 5432:db:5432 host", 5432]);
    assert.deepEqual(b.commandStays, [{ name: "shop", ports: [3100] }], "the report names which port numbers stay — name and number, never the command");
    assert.deepEqual(b.withoutDefault, ["tunnel"], "without a default the dismantling does not touch the tunnel — it is under withoutDefault, not commandStays");
  });
});

// ── (16)–(18) ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("(16) an override in quotes falls; if the old port stays as a docker mapping in the command, the field stays too — even if the .env was rebuilt", async () => {
  for (const [before, to] of [
    ['sh -c "next dev -p 3100"', 'sh -c "next dev"'], ["bash -lc 'npm run dev -- --port=3100'", "bash -lc 'npm run dev'"],
    ['sh -c "PORT=3100 node s.js"', 'sh -c "node s.js"'], ["docker run -p 3100:3000 img", "docker run -p 3100:3000 img"],
  ]) assert.equal(data.withoutPortOverride(before, [3100]), to, before);
  assert.deepEqual(data.overriddenPorts('sh -c "next dev -p 3100"'), [3100]);
  await withRelocation(async (u) => {
    const shop = store.addProjectService("p1", { name: "shop", port: 3100, startCommand: "docker run --rm -p 3100:3000 shop-web" });
    u.ctx.plan.dismantling = { env: [], overrides: [], services: [{ id: shop.id, name: "shop", portOld: 3100, portStandard: 3000, source: ".env.example", command: true, env: true }] };
    const b = await data.portDismantling(u.ctx);
    assert.deepEqual([serviceStatus(shop.id).startCommand, serviceStatus(shop.id).port], ["docker run --rm -p 3100:3000 shop-web", 3100], "the host port of the mapping stays 3100 — otherwise the field would point to 3000, where nothing listens");
    assert.deepEqual(b.commandStays, [{ name: "shop", ports: [3100] }]);
  });
});

test("(17) a parent folder in the project's runtime folder that is a link to the outside makes step 13 fail — nothing lands outside", async () => {
  await withRelocation(async (u) => {
    store.createChat({ id: "c1", workspaceId: "w1", projectId: "p1", provider: "claude", createdAt: 1, updatedAt: 1 });
    write(path.join(DIRS.attachments, "c1", "image.png"), "png");
    const outside = path.join(u.root, "outside");
    fs.mkdirSync(outside);
    const fresh = locationFor({ projectId: "p1", converted: true });
    fs.mkdirSync(fresh.root, { recursive: true });
    fs.symlinkSync(outside, fresh.attachments);
    await assert.rejects(data.relocateRuntime(u.ctx), (e) => e instanceof data.RelocationDataError, "step 13 writes through the link");
    assert.deepEqual(fs.readdirSync(outside), [], "nothing lies outside");
    assert.equal(fs.readFileSync(path.join(DIRS.attachments, "c1", "image.png"), "utf8"), "png", "the flat file stays");
  });
});

test("(18) a browser profile that changed after the copy (lock dead meanwhile) stays in step 15; unchanged it falls", async () => {
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  const seed = () => {
    const flat = locationFor({});
    const profile = path.join(flat.browserProfiles, "proj-p1");
    write(path.join(profile, "Default", "Cookies"), "cookie");
    fs.symlinkSync(`${os.hostname()}-${deadPid}`, path.join(profile, "SingletonLock"));
    return profile;
  };
  await withRelocation(async (u) => {
    const profile = seed();
    await data.relocateRuntime(u.ctx);
    const state = store.readRelocation(u.u.id).copies.project.find((k) => k.kind === "browser").beforeCopy;
    // The state is the fingerprint of the tree (not the youngest mtime).
    assert.ok(state && /^[0-9a-f]{64}$/.test(String(state.fingerprint)) && Number.isFinite(state.copiedAt), JSON.stringify(state));
    const later = new Date(Date.now() + 3_600_000);
    fs.utimesSync(path.join(profile, "Default", "Cookies"), later, later);
    const r = await data.cleanUpAfterStart(u.ctx);
    assert.deepEqual(r.stays, [{ kind: "browser", path: profile, reason: "since-copy-changed" }]);
    assert.equal(fs.readFileSync(path.join(profile, "Default", "Cookies"), "utf8"), "cookie", "the flat profile stays");
  });
  await withRelocation(async (u) => {
    const profile = seed();
    await data.relocateRuntime(u.ctx);
    const r = await data.cleanUpAfterStart(u.ctx);
    assert.deepEqual([r.stays, r.project], [[], 1], "unchanged, the flat profile falls (counter-test in the test)");
    assert.equal(fs.existsSync(profile), false);
  });
});

// ── (19)–(20) ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("(19) an attachment that arrives flat after step 13 survives step 15 — its folder stays, unchanged things fall; a reset mtime counts too, without a state it stays; the reader finds it after the conversion", async () => {
  await withRelocation(async (u) => {
    seedGraph(u); // c1: scratch/c1.mcp.json, attachments/c1/image.png (flat)
    await data.relocateRuntime(u.ctx);
    // Between step 13 and setting `converted_at` (14b): the upload route (chats/routes.js POST /attachments) writes to
    // attachmentLocation — without converted_at the FLAT place that step 13 already copied.
    const flat = path.join(DIRS.attachments, "c1");
    assert.equal(attachmentLocation("c1"), flat, "precondition: before the conversion attachmentLocation points flat");
    fs.writeFileSync(path.join(flat, "new-after-13.txt"), "important");
    const r = await data.cleanUpAfterStart(u.ctx);
    const found = [path.join(flat, "new-after-13.txt"), path.join(u.newLocation, "attachments", "c1", "new-after-13.txt")].filter((p) => fs.existsSync(p));
    assert.ok(found.length > 0, "the attachment uploaded after step 13 is at no place any more");
    assert.equal(fs.readFileSync(path.join(flat, "new-after-13.txt"), "utf8"), "important");
    assert.deepEqual(r.error, []);
    assert.deepEqual(r.stays, [{ chatId: "c1", path: flat, reason: "since-copy-changed" }]);
    assert.equal(fs.existsSync(path.join(DIRS.scratch, "c1.mcp.json")), false, "what did not change falls as before");
    assert.ok(store.readRelocation(u.u.id).copies.chat.every((k) => /^[0-9a-f]{64}$/.test(String(k.beforeCopy?.fingerprint))), "every copied entry carries its state");
    // After the conversion: attachmentLocation points into the runtime folder, the reader finds the attachment at the flat place
    // (fallback); the next turn of the chat brings it along (runs/runtime-location.js bringAlongChat).
    store.createProjectInstance({ projectId: "p1", state: "ready", convertedAt: Date.now() });
    assert.equal(attachmentLocation("c1"), path.join(u.newLocation, "attachments", "c1"));
    assert.equal(attachmentPath("c1", "new-after-13.txt"), path.join(flat, "new-after-13.txt"));
  });
  await withRelocation(async (u) => {
    // A change IN PLACE with the same size and a reset mtime (a writer that preserves timestamps): the youngest mtime would see
    // nothing, the fingerprint sees the ctime. This promises ONLY that step 15 does not delete the flat version: the later
    // bringing along (bringAlongChat) still decides by mtime and keeps the older copy at the target on an equal mtime (limit in
    // the header).
    seedGraph(u);
    const image = path.join(DIRS.attachments, "c1", "image.png");
    const old = fs.statSync(image);
    await data.relocateRuntime(u.ctx);
    fs.writeFileSync(image, "PNG");
    fs.utimesSync(image, old.atime, old.mtime);
    const r = await data.cleanUpAfterStart(u.ctx);
    assert.equal(fs.readFileSync(image, "utf8"), "PNG", "the changed flat version is gone");
    assert.deepEqual(r.stays, [{ chatId: "c1", path: path.dirname(image), reason: "since-copy-changed" }]);
  });
  await withRelocation(async (u) => {
    // An entry from a journal without a state (copied, but no state): unknown — it stays.
    const from = path.join(DIRS.attachments, "c1");
    const to = path.join(u.newLocation, "attachments", "c1");
    write(path.join(from, "a.txt"), "a");
    write(path.join(to, "a.txt"), "a");
    await u.ctx.journal.note({ copies: { chat: [{ chatId: "c1", field: "attachments", from, to, fresh: true, aside: null }] } });
    const r = await data.cleanUpAfterStart(u.ctx);
    assert.deepEqual(r.stays, [{ chatId: "c1", path: from, reason: "status-unknown" }]);
    assert.ok(fs.existsSync(path.join(from, "a.txt")));
  });
});

test("(20) the port dismantling collapses whitespace only where it removed something — quotes elsewhere stay byte-equal", () => {
  for (const [before, ports, to] of [
    ['PORT=3100 node server.js --title "x  y"', [3100], 'node server.js --title "x  y"'],
    ['sh -c "echo \'a  b\' && next dev -p 3100"', [3100], 'sh -c "echo \'a  b\' && next dev"'],
    ["next dev -p 3100 --title 'x\t\ty'", [3100], "next dev --title 'x\t\ty'"],
    ['npm run dev -- "--hostname=0.0.0.0"  -p 3100', [3100], 'npm run dev -- "--hostname=0.0.0.0"'],
    // The place itself: the whitespace around the removed override shrinks to one separator.
    ["next dev -p 3100   --turbo", [3100], "next dev --turbo"],
    ["vite --port 3100 PORT=3100 --host", [3100], "vite --host"],
    ['sh -c "next dev  -p 3100  --turbo"', [3100], 'sh -c "next dev --turbo"'],
  ]) assert.equal(data.withoutPortOverride(before, ports), to, before);
});
