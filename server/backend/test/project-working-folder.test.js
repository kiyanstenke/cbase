// Working folder = project folder.
//
// The promise: for a project that has NOT been converted, cwd, system prompt and --add-dir are unchanged (golden). For a
// converted one (instance: operating mark AND `converted_at`) cwd is the project folder, the workspace is missing from
// --add-dir, the project focus says so, and Playwright writes into the chat's output location, not into the project repo.
//
//   (1) resolveCwd in four cases — no project, project without instance, project with instance, graph-start worktree with
//       instance (the worktree wins) —, plus an instance of ANOTHER project (does not count).
//   (2) Main seam over the fake docker: a Claude turn without an instance row runs in B in the workspace, the next one with a
//       row in the project container with `-w <project folder>`, without the workspace root in --add-dir, with the new focus sentence.
//   (3) projectFocusPrompt in both modes (today's sentence word for word; converted no longer).
//   (4) playwrightMcpEntry with and without instance: `outputDir` only for a profile in a project's runtime folder, otherwise
//       the configuration is the old form.
//   (5) The reader with fallback: attachmentFile and foreignChatFolder find the files at the old location.
//
// Counter-tests: (1)/(2) with the line `if (inContainer) return inContainer.path;` struck from resolveCwd — red (cwd = workspace);
// (2) with the old runAddDirs (workspace stays) — red; (3) with today's sentence also for converted — red; (4) with the old
// toolchain/playwright.js — no outputDir, red.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { DIRS } from "../electron/server/app-state.js";
import { SET_PORTS_IN_PROJECT, projectFocusPrompt, resolveCwd } from "../electron/server/runs/system-prompt.js";
import { attachmentFile, foreignChatFolder, locationFor } from "../electron/server/runs/runtime-location.js";
import { playwrightMcpEntry } from "../electron/server/toolchain/playwright.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";

async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
// Operating mark, fake docker, CLI homes in B in a throwaway folder (no look at the real ~/.claude).
const ops = (fd) => ({
  CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200",
  CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex"),
});
const containerStart = (fd, name) =>
  execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
const execCalls = (fd) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec");

async function createProject(ctx, name = "till") {
  const projPath = path.join(ctx.ws.path, name);
  fs.mkdirSync(projPath, { recursive: true });
  return ctx.projectWithoutInstance({ name, path: projPath });
}

const MAIN = `
  const addDirs = argv.flatMap((a, i) => (a === "--add-dir" ? [argv[i + 1]] : []));
  fs.appendFileSync(path.join(LOCATION, "runs.jsonl"), JSON.stringify({ text, cwd: process.cwd(), addDirs, sp: arg("--append-system-prompt") }) + "\\n");
  finished();
  say({ type: "result", result: "ok", session_id: "s-working-folder" });`;
const claude = fakeClaude({ main: MAIN });
const runWith = (root, part) => waitForTruthy(() => readJsonl(path.join(root, "runs.jsonl")).find((l) => String(l.text).includes(part)), `run ${part}`);
const real = (p) => fs.realpathSync(p);
const SET_TODAY = "You start in the workspace folder, but your work and attention should concentrate on this project";
const SET_NEW = "Your working folder is this project folder";

test("(1) resolveCwd: workspace without project and without instance, project folder with instance, the worktree goes first", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws } = ctx;
    const p = await createProject(ctx);
    const q = await createProject(ctx, "depot");
    const without = store.getChat(ctx.chat.id);
    assert.equal(resolveCwd(without), ws.path, "no project: the workspace");
    assert.equal(resolveCwd(without, { instance: { projectId: p.id } }), ws.path, "without a project no instance counts");

    await json(`${base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
    const including = store.getChat(ctx.chat.id);
    assert.equal(resolveCwd(including, { instance: null }), ws.path, "project without instance: the workspace as today");
    assert.equal(resolveCwd(including), ws.path, "asked without an argument: no instance without operation");
    assert.equal(resolveCwd(including, { instance: { projectId: p.id, instance: "main" } }), p.path, "with instance: the project folder");
    assert.equal(resolveCwd(including, { instance: { projectId: q.id, instance: "main" } }), ws.path, "the instance of another project does not count");

    // The child chat of a background run with its own worktree works there — also with an instance.
    const wt = path.join(ctx.root, "wt-graph");
    fs.mkdirSync(wt);
    store.createGraphStart({ id: "gs-1", chatId: "orchestrator", childChatId: including.id, workflowId: "wf", workflowName: "W", shortName: "w", background: true, worktree: true, status: "started" });
    store.changeGraphStart("gs-1", { worktreePath: wt, worktreeInfo: JSON.stringify({ dir: wt, repos: [] }) });
    assert.equal(resolveCwd(including, { instance: { projectId: p.id, instance: "main" } }), wt, "the worktree goes first");
  }, { claude });
});

test("(2) main seam: without an instance row in the workspace, with a row in the project container — -w project folder, no workspace in --add-dir, new focus sentence", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat, ws, root } = ctx;
      await withEnvironment(ops(fd), async () => {
        const p = await createProject(ctx);
        const name = `cbase-p-${p.id}`;
        containerStart(fd, name);
        await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });

        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "WITHOUT-ROW" }) });
        const a = await runWith(root, "WITHOUT-ROW");
        await ctx.waitForQuiet();
        assert.deepEqual(execCalls(fd), [], "without an instance row no docker exec");
        assert.equal(a.cwd, real(ws.path), "without instance: the workspace is the working folder");
        assert.ok(a.sp.includes(SET_TODAY) && !a.sp.includes(SET_NEW), "without instance: today's focus sentence");

        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: name });
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "WITH-ROW" }) });
        const b = await runWith(root, "WITH-ROW");
        await ctx.waitForQuiet();
        const exec = execCalls(fd).find((x) => x.args.includes(process.env.CLAUDE_BIN));
        assert.ok(exec, "the turn ran via docker exec");
        assert.equal(exec.args[exec.args.indexOf("-w") + 1], p.path, "-w is the project folder");
        assert.equal(b.cwd, real(p.path), "the run works in the project folder");
        const wsRoot = path.resolve(ws.path);
        const withWs = b.addDirs.filter((d) => { const r = path.relative(d, wsRoot); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); });
        assert.deepEqual(withWs, [], `no workspace root in --add-dir: ${b.addDirs.join(", ")}`);
        const runtime = locationFor({ projectId: p.id, converted: true }).root;
        assert.ok(b.addDirs.length && b.addDirs.every((d) => d.startsWith(runtime + path.sep)), `only the project's runtime folder: ${b.addDirs.join(", ")}`);
        assert.ok(b.sp.includes(SET_NEW) && !b.sp.includes(SET_TODAY), "with instance: the new focus sentence instead of the old one");
      });
    }, { claude });
  } finally {
    fd.cleanUp();
  }
});

test("(3) projectFocusPrompt: today's sentence word for word, converted the new one — the rest equal", () => {
  const proj = { name: "Checkout", path: "/w/till" };
  const today = projectFocusPrompt(proj);
  assert.equal(today, [
    "# Project focus",
    "This chat is focused on the project \"Checkout\".",
    "Project folder: /w/till",
    "You start in the workspace folder, but your work and attention should concentrate on this project: work in its folder unless the user asks for something else, and in doubt relate statements to this project.",
    "The project-related cbase_* tools (context, ports) are already preconfigured for this project — without projectId they refer to it automatically. Chat artifacts always use this chat automatically, independent of that.",
    // The one sentence from mcp/credentials-satz.js.
    "cbase_vars_list/get return in this chat the credentials of THIS project plus those of the workspace, unless the project has hidden them (with the same key the project's wins); the field origin names the source.",
  ].join("\n"));
  assert.equal(projectFocusPrompt(proj, { converted: false }), today);
  const fresh = projectFocusPrompt(proj, { converted: true });
  assert.ok(!fresh.includes(SET_TODAY), "converted: the old sentence is gone");
  assert.ok(fresh.includes(SET_NEW) && fresh.includes("neighbouring projects") && fresh.includes("cbase.projectRepo = true") && fresh.includes("commits go into the code repos"));
  const rows = (t) => t.split("\n");
  // Right after the new sentence comes the fixed transition sentence (only for converted).
  assert.equal(rows(fresh)[rows(fresh).findIndex((z) => z.startsWith(SET_NEW)) + 1], SET_PORTS_IN_PROJECT, "converted: the transition sentence follows the new one");
  assert.ok(!today.includes(SET_PORTS_IN_PROJECT) && !today.includes("nothing is remapped"), "not converted: no transition sentence");
  assert.deepEqual(rows(fresh).filter((z) => !z.startsWith(SET_NEW) && z !== SET_PORTS_IN_PROJECT), rows(today).filter((z) => !z.startsWith("You start")), "everything else equal");
});

test("(4) playwrightMcpEntry: outputDir only for a profile in a project's runtime folder, otherwise the old form", async () => {
  await withAgentsServer(async ({ chat }) => {
    const entry = (userDataDir) => {
      const e = playwrightMcpEntry("npx", { headless: true, userDataDir });
      return { e, cfg: fs.readFileSync(e.args[e.args.indexOf("--config") + 1], "utf8") };
    };
    // The old form, rebuilt: browser{launchOptions{headless,args}, userDataDir}, plus window size and capabilities, equal at every location.
    const oldForm = (userDataDir) => JSON.stringify({
      browser: { launchOptions: { headless: true, args: ["--remote-debugging-port=0"] }, contextOptions: { viewport: { width: 1440, height: 900 } }, userDataDir },
      capabilities: ["network", "storage", "testing", "vision"],
    }, null, 2);

    const flat = path.join(DIRS.data, "playwright-profiles", `chat-${chat.id}`);
    assert.equal(entry(flat).cfg, oldForm(flat), "flat location: the same configuration as before");
    const stock = path.join(DIRS.data, "playwright-profiles", "ws-1");
    assert.equal(entry(stock).cfg, oldForm(stock), "login stock: no outputDir");

    const pLocation = locationFor({ projectId: "p7", converted: true });
    const inProject = path.join(pLocation.playwrightProfiles, `chat-${chat.id}`);
    assert.equal(JSON.parse(entry(inProject).cfg).outputDir, path.join(pLocation.outputs, chat.id, "playwright"), "chat in a project: the chat's output location");
    const agent = path.join(pLocation.playwrightProfiles, `chat-${chat.id}-agent-a1`);
    assert.equal(JSON.parse(entry(agent).cfg).outputDir, path.join(pLocation.outputs, chat.id, "playwright"), "subagent: the same output location of its chat");
    const foreign = path.join(pLocation.root, "elsewhere", `chat-${chat.id}`);
    assert.equal(JSON.parse(entry(foreign).cfg).outputDir, undefined, "only under a project's playwright-profiles");
  }, { claude });
});

test("(5) attachmentFile and foreignChatFolder find the chat's files at the old location", async () => {
  await withAgentsServer(async ({ chat }) => {
    const flat = locationFor({});
    const pLocation = locationFor({ projectId: "p9", converted: true });
    // Without another location: the current path as the reader built it before; no foreign folders.
    assert.equal(attachmentFile(chat, "a.png", flat), `${path.join(flat.attachments, chat.id)}/a.png`);
    assert.deepEqual(foreignChatFolder(chat, flat), []);

    // The file is still at the flat location, the chat is already in project p9: the reader finds it there.
    fs.mkdirSync(path.join(flat.attachments, chat.id), { recursive: true });
    fs.writeFileSync(path.join(flat.attachments, chat.id, "a.png"), "x");
    fs.mkdirSync(path.join(pLocation.attachments, chat.id), { recursive: true });
    assert.equal(attachmentFile(chat, "a.png", pLocation), `${path.join(flat.attachments, chat.id)}/a.png`, "fallback to the old location");
    assert.equal(attachmentFile(chat, "missing.png", pLocation), `${path.join(pLocation.attachments, chat.id)}/missing.png`, "nowhere: the current path");
    assert.deepEqual(foreignChatFolder(chat, pLocation), [path.join(flat.attachments, chat.id)]);
    // If it also exists at the current location, that one wins.
    fs.writeFileSync(path.join(pLocation.attachments, chat.id, "a.png"), "y");
    assert.equal(attachmentFile(chat, "a.png", pLocation), `${path.join(pLocation.attachments, chat.id)}/a.png`);
  }, { claude });
});
