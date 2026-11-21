// Service detection in the project container: "Scan again" (POST /api/projects/:id/services/scan) resp. the connection of the
// domain side (projectbox/detection.js detectServices) → projects/scans.js → claude.js scanServices → runOnce → runOnceClaude
// → inProject — with operating marker, the fake docker (fake-docker.mjs, an exec runs LOCALLY with the environment from its
// `-e NAME`) and an instance row; and the same detection without operating marker.
//
// The fake CLI imitates the start behaviour measured at pin 2.1.280: in a repo it calls git — `ls-files` twice and
// `remote get-url origin`/`remote`, WITHOUT CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS also `--no-optional-locks status --short`,
// `log`, `config user.name`; for ls-files/status/log/config with the eight `-c` of the CLI and without our GIT_DIR/GIT_CONFIG_*.
// It proves only that the switch reaches the CLI process; whether the real binary behaves so is measured by
// a measurement against the real CLI at every CLI jump, not by the gate.
//
// The promises, each with the way that breaks it:
//   (a) Converted ⇒ `docker exec … cbase-p-<id> /usr/sbin/cbase-wrapper … -- <claude>` with `-w <project folder>`; without
//       conversion no docker call.
//   (b) argv: `--tools Read,Glob,Grep`, `--strict-mcp-config --mcp-config {"mcpServers":{}}`, no `--add-dir`, no
//       `--dangerously-skip-permissions`, and `--permission-mode default` EXPLICITLY (the reference boundary hangs on mode
//       `default`; without the flag `-p` starts in mode `auto` since 2.1.285 and collects git context without our GIT_DIR);
//       the CLI sees exactly Read, Glob, Grep — no Bash.
//   (c) Environment of the CLI: GIT_DIR=/nonexistent, core.fsmonitor=false, core.hooksPath=/dev/null,
//       CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1, ENABLE_CLAUDEAI_MCP_SERVERS=false (the CLI then does not fetch the claude.ai
//       connectors at all), plus as in every oneshot CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1; in the docker argv only
//       `-e NAME`, never a value — even if B carries the same value (`envAlways`).
//   (d) Start gate via `projectId`: while the instance works ("recreate") the detection waits (`waiting: "project"`, no exec,
//       does not count in idle), the transition to `ready` wakes it. Likewise during a server step of the SETUP at `ready`
//       (`code-repos`, git init at the gate of the fake git — the setup harness ./setup-harness.mjs): waits, no exec; the end
//       of the setup wakes it in the SAME turn (procedure.js: endSetup BEFORE wakeProject), afterwards it runs exactly once in the
//       project container.
//   (e) Foreign text: a field with a token pattern (sk-ant-, ghp_, long base64) is dropped, the bell names service and field,
//       never the value; name capped at 80, start command at 1,000 characters; an absolute path is no token — and a long
//       RELATIVE path with a digit is none either (`dir` is relative to the project root), a token with `/` is.
//   (f) `onlySupplement` removes nothing — in the same test the counter-test of the store path: the full reconcile with the
//       same answer removes the service not named.
//   (g) a call during a run ⇒ EXACTLY ONE follow-up (two more calls yield one); while it computes it counts in the project's
//       idle (reason "detection"), afterwards no more.
//   (h) storage full ⇒ `waiting: "storage"` without exec, free + pass of the storage queue ⇒ runs; the cap
//       (CBASE_DETECTION_CAP=1) holds the second until the first is done.
//   (i) Filter case: a repo-local `filter.x.clean` (marker program) with an equally sized change and old mtime — the
//       detection in the container does NOT run it; a plain `git status` afterwards does (the probe holds).
//   Also: Codex fails visibly without a start ("only with Claude"), directly at the connector too.
//
// COUNTER-TESTS (each a spot sabotaged, the file run, then restored):
//   providers/connectors/claude.js `instance ? inProject(…) : spawn(…)` → only `spawn(…)` ⇒ (a)(b)(c)(e), (d), (h), (i) red
//   (no exec);
//   buildClaudeOnceArgs without the `onlyRead` branch ⇒ form and (a)(b)(c)(e) red (Bash in the set); without
//   `--strict-mcp-config` in it ⇒ form and (a)(b)(c)(e) red;
//   `envAlways` left out ⇒ (a)(b)(c)(e) red (the name is missing from the argv, the CLI does not see the switch — B carries it
//   itself);
//   providers/index.js without `projectId`/`instance` at the start gate ⇒ (d) red (it starts at once; without the `finally`
//   around the transition the test then hung on the harness quiet — the instance stayed on "recreate");
//   claude.js looksLikeSecret → always false ⇒ form and (a)(b)(c)(e) red (token in the database);
//   store/projects.js without the `onlySupplement` condition ⇒ (f)(g) red (the store call with a keep set); projects/scans.js
//   with the full reconcile also for `onlySupplement` ⇒ (f)(g) red (the path via detectServices);
//   projects/scans.js with the old drop (`if (open) return;`) ⇒ (f)(g) red (no follow-up);
//   projects/scans.js without storage gate ⇒ (h) red; without cap ⇒ (h) red;
//   DETECTION_ENVIRONMENT without CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS ⇒ form, (a)(b)(c)(e) and (i) red (the filter marker
//   appears);
//   DETECTION_ENVIRONMENT without ENABLE_CLAUDEAI_MCP_SERVERS ⇒ form and (a)(b)(c)(e) red (the CLI does not see the switch).
// No clock: waits are on states (serviceScans, gates of the fake CLI), never on a duration; every wait also ends when the
// expected state fails to appear (otherwise a failure would turn into a hang).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { WRAPPER_PATH } from "../electron/server/runtime/inProject.js";
import { getMonitorEvents } from "../electron/server/services.js";
import { projectIdle } from "../electron/server/projectbox/idle.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { detectServices, setServicesDetection } from "../electron/server/projectbox/detection.js";
import { runServicesScan, serviceScans } from "../electron/server/projects/scans.js";
import { wakeStorageQueue } from "../electron/server/workflows/storage-queue.js";
import { buildClaudeOnceArgs, DETECTION_ENVIRONMENT, runOnceClaude } from "../electron/server/providers/connectors/claude.js";
import { runOnceCodex } from "../electron/server/providers/connectors/codex.js";
import { looksLikeSecret } from "../electron/server/claude.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { request, create, staging, cliEnvironment, setupRoute, gitHold, gitWaiting, gitContinue, inSources, withCreation, write } from "./setup-harness.mjs";

// ── The fake CLI of the detection ─────────────────────────────────────────────────────────────────────────────────────────
// Per run: a start marker `detection/<dir>-<n>.start`, the capture `<dir>-<n>.json` (argv, cwd, hardening environment,
// built-in tools, git calls), then the answer from `scan-<dir>.json` — with `hold-<dir>` only at the gate
// `scan-<dir>-<n>`. No backticks and no "${" in the body (it sits in a template).
const DETECTOR = fakeClaude({ oneshot: `
    if (!prompt.includes("service scanner")) { respond("[]"); return; }
    const { spawnSync } = require("node:child_process");
    const where = path.basename(process.cwd());
    const deposit = path.join(LOCATION, "detection");
    fs.mkdirSync(deposit, { recursive: true });
    let nr = 1;
    while (fs.existsSync(path.join(deposit, where + "-" + nr + ".start"))) nr++;
    fs.writeFileSync(path.join(deposit, where + "-" + nr + ".start"), String(process.pid));
    const CLI_C = ["-c", "core.askPass=", "-c", "protocol.ext.allow=never", "-c", "submodule.recurse=false", "-c", "log.showSignature=false",
      "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor="];
    const withoutOur = () => { const e = { ...process.env }; delete e.GIT_DIR; for (const k of Object.keys(e)) if (k.startsWith("GIT_CONFIG_")) delete e[k]; return e; };
    const git = [];
    const call = (what, args, env) => { const r = spawnSync("git", args, { cwd: process.cwd(), env, encoding: "utf8" }); git.push({ what, code: r.status }); };
    call("ls-files", [...CLI_C, "ls-files", "--error-unmatch", "--", ":(icase).claude/settings.local.json"], withoutOur());
    call("ls-files", [...CLI_C, "ls-files", "--error-unmatch", "--", ":(icase).claude/settings.local.json"], withoutOur());
    call("remote get-url", ["remote", "get-url", "origin"], process.env);
    call("remote", ["remote"], process.env);
    if (process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS !== "1") {
      call("status", [...CLI_C, "--no-optional-locks", "status", "--short"], withoutOur());
      call("log", [...CLI_C, "log", "--oneline", "-n", "5"], withoutOur());
      call("config", [...CLI_C, "config", "user.name"], withoutOur());
    }
    const env = {};
    for (const k of ["CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS", "ENABLE_CLAUDEAI_MCP_SERVERS", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "GIT_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"]) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
    fs.writeFileSync(path.join(deposit, where + "-" + nr + ".json"), JSON.stringify({ argv, cwd: process.cwd(), env, tools: eingebauteTools(), git }));
    const response = () => { let t = "[]"; try { t = fs.readFileSync(path.join(LOCATION, "scan-" + where + ".json"), "utf8"); } catch {} respond(t); };
    if (fs.existsSync(path.join(LOCATION, "hold-" + where))) gate("scan-" + where + "-" + nr).then(response); else response();` });

async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
// As in inProject.test.js: the CLI homes in B live in the throwaway folder — never in the machine's real ~/.claude.
const ops = (fd, extra = {}) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200",
  CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex"), ...extra });

// A project via the route (WITHOUT operating marker), empty: the creation does not scan itself.
async function project(ctx, name) {
  const filePath = path.join(ctx.root, "workspace", name);
  fs.mkdirSync(filePath, { recursive: true });
  const p = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name, path: filePath }) });
  return { ...p, path: filePath };
}
// The project container in the fake docker and the converted instance row.
function convert(fd, proj, state = "ready") {
  const name = `cbase-p-${proj.id}`;
  execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
  store.createProjectInstance({ projectId: proj.id, state, convertedAt: Date.now(), containerId: name });
  return name;
}
const snapshot = (proj) => serviceScans.get(String(proj.id)) || null;
// Wait until the state satisfies `check` OR the detection is no longer running (otherwise a failure would hang).
const waitForStatus = (proj, check, what) => waitForTruthy(() => {
  const s = snapshot(proj);
  return s && (check(s) || s.status !== "running") ? s : null;
}, what);
const finished = (proj) => waitForStatus(proj, () => false, `detection ${proj.name} done`);
const scan = async (ctx, proj) => {
  const r = await json(`${ctx.base}/api/projects/${proj.id}/services/scan`, { method: "POST" });
  assert.equal(r.ok, true);
};
const capture = (ctx, proj, seq) => {
  const f = path.join(ctx.root, "detection", `${path.basename(proj.path)}-${seq}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
};
const started = (ctx, proj, seq) => fs.existsSync(path.join(ctx.root, "detection", `${path.basename(proj.path)}-${seq}.start`));
const execsOfCli = (fd) => fd.calls({ daemon: "host" })
  .filter((a) => a.args[0] === "exec" && a.args.includes(WRAPPER_PATH) && a.args[a.args.indexOf("--") + 1] === process.env.CLAUDE_BIN);
const value = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const openReasons = (proj) => projectIdle(proj.id).open.map((o) => o.reason);

// ── Without server: the form of the detection and the token pattern ─────────────────────────────────────────────────────
test("Form: onlyRead gives Read/Glob/Grep and the empty MCP configuration, withoutTools takes precedence; the token pattern", async () => {
  const a = buildClaudeOnceArgs({ onlyRead: true });
  assert.equal(value(a, "--tools"), "Read,Glob,Grep");
  assert.ok(a.includes("--strict-mcp-config"));
  assert.equal(value(a, "--mcp-config"), '{"mcpServers":{}}');
  for (const f of ["--add-dir", "--dangerously-skip-permissions"]) assert.ok(!a.includes(f), f);
  assert.equal(value(a, "--permission-mode"), "default", "the mode is explicitly there (the CLI default is auto since 2.1.285)");
  assert.equal(value(buildClaudeOnceArgs({ onlyRead: true, withoutTools: true }), "--tools"), "", "withoutTools takes precedence");
  assert.ok(!buildClaudeOnceArgs({}).includes("--tools"), "an ordinary oneshot stays as it was");
  assert.equal(DETECTION_ENVIRONMENT.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS, "1");
  assert.equal(DETECTION_ENVIRONMENT.ENABLE_CLAUDEAI_MCP_SERVERS, "false", "without the switch the CLI fetches the claude.ai connectors");
  for (const t of ["sk-ant-api03-abc", "x ghp_abcdef", "github_pat_11AB", "glpat-xyz", "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9f",
    // A token with `/` stays one (the chain changes character class too often for a path), likewise a path with a
    // token as part and a 40-character token in a description.
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "config/aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9f/x", "Token aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7d"]) {
    assert.equal(looksLikeSecret(t), true, t);
  }
  for (const t of ["npm run dev", "/home/agent/workspace/Project1/apps/WebFrontend2/bin", "docker compose -f docker-compose.production.yml up",
    "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz", "0123456789abcdef0123456789abcdef01234567",
    // `dir` is RELATIVE to the project root — a long monorepo path with a digit (42 characters), also in the start command.
    "packages/CustomerPortal/apps/frontend-web2", "cd packages/CustomerPortal/apps/frontend-web2 && npm run dev",
    "services/backend/src/main/java/com/Example2/App"]) {
    assert.equal(looksLikeSecret(t), false, t);
  }
  // There is no Codex in the project container — the connector rejects before it starts anything. CODEX_BIN points
  // nowhere: without the rejection the call would end at ENOENT instead of at a real CLI.
  await withEnvironment({ CODEX_BIN: path.join(os.tmpdir(), "codex-exists-not-an7") }, async () => {
    await assert.rejects(runOnceCodex("p", { instance: { projectId: "x", instance: "main", identifier: "x/main" } }), /nur mit Claude|only with Claude/);
  });
  assert.equal(typeof runOnceClaude, "function");
});

// ── (a) (b) (c) (e): in the project container, and the same detection without operating marker ────────────────────────────
test("(a)(b)(c)(e) Detection in the project container: docker exec with the wrapper, Read/Glob/Grep, hardened environment as names only, token dropped — without operating marker no docker", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const proj = await project(ctx, "till");
      const container = convert(fd, proj);
      const lang = "Q".repeat(120);
      fs.writeFileSync(path.join(ctx.root, "scan-till.json"), JSON.stringify([
        { name: "API", kind: "backend", port: 18080, startCommand: `ANTHROPIC_API_KEY=sk-ant-api03-${"x".repeat(30)} node server.js`, description: "Die API" },
        { name: "Web", kind: "frontend", port: 18081, dir: "/home/agent/workspace/Project1/apps/WebFrontend2/bin", startCommand: "npm run dev", description: `Token ghp_${"A1b2".repeat(9)}` },
        { name: "Cache", kind: "cache", port: null, container: "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fGh", startCommand: "", description: "Redis" },
        { name: lang, kind: "worker", port: null, startCommand: `node worker.js ${"a ".repeat(600)}`.trim(), description: "lang" },
      ]));
      const bellPrior = getMonitorEvents(0).length;

      // ── In the project: B carries both switches ITSELF — without envAlways it would not arrive (the allowlist otherwise takes only deviations).
      await withEnvironment(ops(fd, { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" }), async () => {
        await scan(ctx, proj);
        const s = await finished(proj);
        assert.equal(s.status, "done", JSON.stringify(s));
      });
      // (a) docker exec in cbase-p-<id>, as agent, working folder = project folder, through the wrapper.
      const execs = execsOfCli(fd);
      assert.equal(execs.length, 1, `no or more than one exec of the CLI: ${JSON.stringify(fd.calls().map((a) => a.args.slice(0, 6)))}`);
      const ex = execs[0].args;
      assert.ok(ex.includes(container), "exec in cbase-p-<id>");
      assert.equal(value(ex, "-u"), "agent");
      assert.equal(value(ex, "-w"), proj.path, "-w is the project folder");
      const a1 = capture(ctx, proj, 1);
      assert.ok(a1, "the CLI did not run");
      assert.equal(fs.realpathSync(a1.cwd), fs.realpathSync(proj.path));
      // (b) the form of the detection as the CLI sees it.
      assert.equal(value(a1.argv, "--tools"), "Read,Glob,Grep");
      assert.ok(a1.argv.includes("--strict-mcp-config"));
      assert.equal(value(a1.argv, "--mcp-config"), '{"mcpServers":{}}');
      for (const f of ["--add-dir", "--dangerously-skip-permissions"]) assert.ok(!a1.argv.includes(f), `${f} im argv`);
      assert.equal(value(a1.argv, "--permission-mode"), "default", "the mode explicitly reaches the CLI");
      assert.deepEqual(a1.tools, ["Read", "Glob", "Grep"], "the CLI sees exactly Read, Glob, Grep — no Bash");
      // (c) the environment IN the container; in the docker argv only names.
      assert.deepEqual(a1.env, {
        CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", GIT_DIR: "/nonexistent", GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false", GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null",
      });
      const names = ex.flatMap((x, i) => (x === "-e" ? [ex[i + 1]] : []));
      for (const n of [...Object.keys(DETECTION_ENVIRONMENT), "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"]) assert.ok(names.includes(n), `-e ${n} missing: ${names.join(" ")}`);
      assert.ok(names.every((n) => !n.includes("=")), `a value behind -e: ${names.join(" ")}`);
      assert.ok(!ex.some((x) => String(x).includes("/nonexistent")), "a hardening value is in the argv");
      assert.deepEqual(a1.git.map((g) => g.what), ["ls-files", "ls-files", "remote get-url", "remote"], "with the switch no status/log/config");
      // (e) Token dropped — none in the database, the bell names service and field, never the value.
      const services = Object.fromEntries(store.listProjectServices(proj.id).map((d) => [d.name, d]));
      assert.ok(services.API && services.Web && services.Cache, Object.keys(services).join(", "));
      assert.equal(services.API.start_command ?? services.API.startCommand ?? "", "");
      assert.equal(services.Web.description, "");
      assert.equal(services.Web.dir, "/home/agent/workspace/Project1/apps/WebFrontend2/bin", "an absolute path is no token");
      assert.equal(services.Cache.container, "");
      const raw = JSON.stringify(store.listProjectServices(proj.id));
      for (const t of ["sk-ant-", "ghp_", "aB3dE5fG7"]) assert.ok(!raw.includes(t), `${t} in the database`);
      const bell = getMonitorEvents(0).slice(bellPrior).find((e) => /Geheimnis|secret/.test(e.title));
      assert.ok(bell, "no bell for the dropped fields");
      for (const z of ["API: startCommand", "Web: description", "Cache: container"]) assert.ok(bell.body.includes(z), `${z} missing: ${bell.body}`);
      for (const t of ["sk-ant-", "ghp_", "aB3dE5fG7"]) assert.ok(!bell.body.includes(t), `${t} in the bell`);
      // The lengths: name 80, start command up to 1,000.
      const long = store.listProjectServices(proj.id).find((d) => d.name.startsWith("QQQ"));
      assert.equal(long?.name.length, 80);
      const cmd = long.start_command ?? long.startCommand;
      assert.ok(cmd.length > 300 && cmd.length <= 1000, `start command ${cmd.length} characters`);

      // ── Without operating marker: the same detection in B, no docker — in the same hardened form.
      const prior = fd.calls().length;
      await scan(ctx, proj);
      assert.equal((await finished(proj)).status, "done");
      assert.equal(fd.calls().length, prior, `docker call without operating marker: ${JSON.stringify(fd.calls().slice(prior))}`);
      const a2 = capture(ctx, proj, 2);
      assert.ok(a2, "the second detection did not run");
      assert.equal(value(a2.argv, "--tools"), "Read,Glob,Grep");
      assert.equal(a2.env.GIT_DIR, "/nonexistent");
      await ctx.waitForQuiet();
    }, { claude: DETECTOR });
  } finally {
    fd.cleanUp();
  }
});

// ── (d) Start gate via the project; Codex fails visibly ───────────────────────────────────────────────────────────────────
test("(d) The detection waits at the lock of its project (recreate), without exec and without holding idle; the transition to ready wakes it — Codex fails visibly", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const proj = await project(ctx, "lager");
      convert(fd, proj, "recreate");
      // A failure before the transition would leave the instance on "recreate" — the harness quiet would then wait forever.
      const ready = () => { if (store.projectInstance(proj.id, "main")?.state !== "ready") setInstanceState(proj.id, "main", "ready"); };
      await withEnvironment(ops(fd), async () => { try {
        await scan(ctx, proj);
        const s = await waitForStatus(proj, (x) => x.waiting === "project", "detection waits at the lock");
        assert.equal(s.status, "running", JSON.stringify(s));
        assert.equal(s.waiting, "project", `started despite the lock: ${JSON.stringify(s)}`);
        assert.match(s.waitText, /Projekt-Container|project container/);
        assert.equal(execsOfCli(fd).length, 0, "no exec while the instance works");
        assert.ok(!openReasons(proj).includes("detection"), "a waiting detection does not hold idle");
        // The transition (state waker → wakeProject → projectbox/detection.js) wakes it.
        ready();
        const f = await finished(proj);
        assert.equal(f.status, "done", JSON.stringify(f));
        assert.equal(execsOfCli(fd).length, 1, "after the transition it ran in the container");

        // Codex (or any provider but Claude) in the project container: visibly failed, nothing started. CODEX_BIN points
        // nowhere — a real CLI never starts here, even if both rejections were missing.
        await withEnvironment({ CODEX_BIN: path.join(ctx.root, "codex-exists-not") }, async () => {
          const prior = store.getSetting("agent_model_services");
          store.setSetting("agent_model_services", JSON.stringify({ provider: "codex", model: "gpt-5.6-sol" }));
          try {
            await scan(ctx, proj);
            const c = await finished(proj);
            assert.equal(c.status, "error", JSON.stringify(c));
            assert.match(c.error, /nur mit Claude|only with Claude/);
            assert.equal(execsOfCli(fd).length, 1, "no further exec");
          } finally { store.setSetting("agent_model_services", prior ?? ""); }
        });
      } finally { ready(); } });
      await ctx.waitForQuiet();
    }, { claude: DETECTOR });
  } finally {
    fd.cleanUp();
  }
});

// ── (f) (g) in B: onlySupplement, follow-up, idle ──────────────────────────────────────────────────────────────────────
test("(f)(g) onlySupplement removes nothing (the full reconcile does); a call during a run yields exactly one follow-up; a computing detection counts in idle", async () => {
  await withAgentsServer(async (ctx) => {
    const proj = await project(ctx, "rest");
    const response = (list) => fs.writeFileSync(path.join(ctx.root, "scan-rest.json"), JSON.stringify(list));
    const names = () => store.listProjectServices(proj.id).map((d) => d.name).sort();
    // The existing one: "Old", created by the scan.
    response([{ name: "Old", kind: "worker", port: null, startCommand: "node old.js" }]);
    await scan(ctx, proj);
    assert.equal((await finished(proj)).status, "done");
    assert.deepEqual(names(), ["Old"]);
    // (f) After a later upload: only supplement — "Old" stays although the detection does not name it.
    response([{ name: "Fresh", kind: "worker", port: null, startCommand: "node new.js" }]);
    assert.equal(detectServices(proj.id, { onlySupplement: true }), true);
    const e = await finished(proj);
    assert.equal(e.status, "done", JSON.stringify(e));
    assert.deepEqual(names(), ["Fresh", "Old"], "onlySupplement removed one");
    assert.deepEqual(e.removed, []);
    // The store holds it itself (second layer): with `onlySupplement` the reconcile removes nothing even if a caller
    // passes a keep set in which "Old" is missing.
    const direct = store.reconcileScan(proj.id, [{ name: "Fresh", kind: "worker", port: null, startCommand: "node new.js" }], { onlySupplement: true, keep: new Set() });
    assert.deepEqual(direct.removed, [], "the store removes despite onlySupplement");
    assert.deepEqual(names(), ["Fresh", "Old"]);
    // Counter-test in the same test: the full reconcile (creation, "Scan again") with the same answer removes "Old".
    await scan(ctx, proj);
    const v = await finished(proj);
    assert.deepEqual(names(), ["Fresh"], "the full reconcile removes the scan service not named");
    assert.deepEqual(v.removed.map((d) => d.name), ["Old"]);

    // (g) Run 4 holds at the gate; meanwhile three more calls.
    fs.writeFileSync(path.join(ctx.root, "hold-rest"), "1");
    await scan(ctx, proj);
    await ctx.gate.reached("scan-rest-4");
    assert.ok(openReasons(proj).includes("detection"), `the computing detection is missing in idle: ${JSON.stringify(projectIdle(proj.id).open)}`);
    await scan(ctx, proj);
    await scan(ctx, proj);
    assert.equal(detectServices(proj.id, { onlySupplement: true }), true);
    ctx.gate.open("scan-rest-4");
    // Either the follow-up stands at its gate, or the detection is over (then the call was dropped — red).
    await waitForTruthy(() => fs.existsSync(path.join(ctx.root, "gates", "scan-rest-5.waiting")) || snapshot(proj)?.status !== "running", "follow-up or end");
    assert.ok(started(ctx, proj, 5), `no follow-up: ${JSON.stringify(snapshot(proj))}`);
    ctx.gate.open("scan-rest-5");
    // The state falls to "done" only when no further follow-up comes — one followed in the same tick (runServicesScan sets
    // "running" synchronously), so "done" here means: exactly one.
    assert.equal((await finished(proj)).status, "done");
    assert.ok(!started(ctx, proj, 6), "more than one follow-up");
    assert.ok(!openReasons(proj).includes("detection"), "after the end it no longer counts");
    fs.rmSync(path.join(ctx.root, "hold-rest"));
    await ctx.waitForQuiet();
  }, { claude: DETECTOR });
});

// ── (h) Storage gate and cap ──────────────────────────────────────────────────────────────────────────────────────────────
test("(h) Storage full ⇒ the detection waits without exec, free + pass of the storage queue ⇒ it runs; the cap holds the second until the end of the first", async () => {
  const fd = await fakeDocker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-an7-storage-"));
  const cgroup = path.join(root, "sys", "fs", "cgroup");
  fs.mkdirSync(cgroup, { recursive: true });
  fs.writeFileSync(path.join(cgroup, "memory.max"), "1000000000\n");
  fs.writeFileSync(path.join(cgroup, "memory.current"), "900000000\n"); // 90 % — above the 80 % line
  try {
    await withAgentsServer(async (ctx) => {
      const one = await project(ctx, "one");
      const two = await project(ctx, "two");
      convert(fd, one);
      convert(fd, two);
      await withEnvironment(ops(fd, { CBASE_STORAGE_ROOT: root, CBASE_DETECTION_CAP: "1" }), async () => {
        await scan(ctx, one);
        const s = await waitForStatus(one, (x) => x.waiting === "storage", "detection waits for storage");
        assert.equal(s.waiting, "storage", `started despite full memory: ${JSON.stringify(s)}`);
        assert.match(s.waitText, /Speicher|memory/);
        assert.equal(execsOfCli(fd).length, 0);
        fs.writeFileSync(path.join(cgroup, "memory.current"), "100000000\n");
        assert.ok(wakeStorageQueue() >= 1, "the pass started nothing");
        assert.equal((await finished(one)).status, "done");
        assert.equal(execsOfCli(fd).length, 1);

        // The cap (1): the first holds at the gate, the second waits until it is done.
        fs.writeFileSync(path.join(ctx.root, "hold-one"), "1");
        await scan(ctx, one);
        await ctx.gate.reached("scan-one-2");
        await scan(ctx, two);
        const z = await waitForStatus(two, (x) => x.waiting === "cap", "zweite Erkennung am Deckel");
        assert.equal(z.waiting, "cap", `the second ran beside the first: ${JSON.stringify(z)}`);
        assert.match(z.waitText, /höchstens 1|at most 1/);
        assert.ok(!started(ctx, two, 1));
        ctx.gate.open("scan-one-2");
        assert.equal((await finished(one)).status, "done");
        assert.equal((await finished(two)).status, "done", "the second did not run after the end of the first");
        assert.ok(started(ctx, two, 1));
        fs.rmSync(path.join(ctx.root, "hold-one"));
      });
      await ctx.waitForQuiet();
    }, { claude: DETECTOR });
  } finally {
    fd.cleanUp();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── (i) Der Filter-Fall (M9) ──────────────────────────────────────────────────────────────────────────────────────────────
test("(i) Filter case: a repo-local filter.x.clean does not run at the detection in the container — a plain git status lets it run", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const proj = await project(ctx, "filter");
      const marker = path.join(ctx.root, "filter-marker");
      const program = path.join(ctx.root, "filter-program.sh");
      fs.writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
      fs.chmodSync(program, 0o755);
      const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: proj.path, encoding: "utf8" });
      git("init", "-q");
      fs.writeFileSync(path.join(proj.path, "data.txt"), "aaaa\n");
      git("add", "data.txt");
      git("commit", "-q", "-m", "one");
      // Only AFTER the commit: the filter in the configuration OF THE REPO and for every file; an equally sized change with an old
      // mtime — the index no longer matches, a `status` must read the content and send it through the filter.
      git("config", "filter.x.clean", program);
      git("config", "filter.x.smudge", "cat");
      fs.writeFileSync(path.join(proj.path, ".gitattributes"), "* filter=x\n");
      fs.writeFileSync(path.join(proj.path, "data.txt"), "bbbb\n");
      const old = new Date("2001-01-01T00:00:00Z");
      fs.utimesSync(path.join(proj.path, "data.txt"), old, old);
      fs.rmSync(marker, { force: true });
      convert(fd, proj);
      await withEnvironment(ops(fd), async () => {
        await scan(ctx, proj);
        assert.equal((await finished(proj)).status, "done");
      });
      const a = capture(ctx, proj, 1);
      assert.ok(a, "the CLI did not run");
      assert.equal(execsOfCli(fd).length, 1, "the detection did not run in the container");
      assert.deepEqual(a.git.map((g) => g.what), ["ls-files", "ls-files", "remote get-url", "remote"]);
      assert.equal(fs.existsSync(marker), false, "the repo-local filter ran at the start of the detection");
      // The probe holds: a plain status reads the change and runs the filter.
      spawnSync("git", ["status", "--short"], { cwd: proj.path, encoding: "utf8" });
      assert.equal(fs.existsSync(marker), true, "the probe does not hold: even a plain status did not run the filter");
      await ctx.waitForQuiet();
    }, { claude: DETECTOR });
  } finally {
    fd.cleanUp();
  }
});

// ── (d) during a server step of the setup ─────────────────────────────────────────────────────────────────────────────────
test("(d) Setup: during `code-repos` (git init at the gate) the detection waits at the lock (no exec); the end of the setup wakes it in the same turn, it runs exactly once", async () => {
  await withCreation(async ({ ctx, fd, gitGates }) => {
    // The real detection instead of the harness recorder — the same connection as in server.js.
    setServicesDetection((pid, o) => { const p = store.getProject(pid); if (p) runServicesScan(p, o); });
    const proj = await create(ctx, { name: "Lager", sources: [{ kind: "folder", target: "x", bytes: 2 }], codeRepos: ["x"] });
    const pid = proj.id;
    await inSources(pid);
    assert.equal((await request(setupRoute(ctx.base, pid, "sources/1/begin"), { method: "POST", body: { bytes: 2 } })).status, 200);
    write(path.join(staging(proj, 1), "x", "a.txt"), "ok");
    gitHold(gitGates, "init");
    assert.equal((await request(setupRoute(ctx.base, pid, "sources/1/finished"), { method: "POST" })).status, 202);
    try {
      await gitWaiting(gitGates, "init");
      assert.equal(store.setupOf(pid)?.step, "code-repos");
      assert.equal(store.projectInstance(pid, "main")?.state, "ready", "the instance is ready — the lock is the setup's");
      assert.equal(detectServices(pid), true);
      const s = await waitForTruthy(() => { const x = serviceScans.get(pid); return x && (x.waiting === "project" || x.status !== "running") ? x : null; }, "detection waits at the lock");
      assert.equal(s.waiting, "project", `started in the middle of the server step: ${JSON.stringify(s)}`);
      assert.equal(execsOfCli(fd).length, 0, "no CLI exec during the server step");
    } finally { gitContinue(gitGates, "init"); }
    await waitForTruthy(() => !store.setupOf(pid), "Einrichtung fertig");
    // In the same turn as the end (wakeProject after endSetup, the waker runs in the next microtick): at the first look
    // at the finished setup it no longer waits. With wakeProject before it, the setup would still hold it there, and it
    // would lie until the next tick of the storage queue.
    assert.notEqual(serviceScans.get(pid)?.waiting, "project", "the end of the setup did not wake it");
    const f = await waitForTruthy(() => { const x = serviceScans.get(pid); return x && x.status !== "running" ? x : null; }, "Erkennung fertig");
    assert.equal(f.status, "done", JSON.stringify(f));
    assert.equal(execsOfCli(fd).length, 1, "afterwards EXACTLY one CLI exec in the project container");
  }, { claude: DETECTOR, environment: cliEnvironment });
});
