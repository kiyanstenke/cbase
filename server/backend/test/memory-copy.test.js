// Guard for the reader side in B of the files in a copy (runs/system-prompt.js projectMemoryPromptIn, dynworkflows/run.js,
// runs/runtime-limit.js).
//
// THE GAP. B reads for a copy chat from the main: the project memory (CLAUDE.md/AGENTS.md; the CLI does not read them itself
// because of `--setting-sources user`, Codex natively reads the copy's version: two versions in one run) and the script of a
// dynamic workflow (`scriptPath`, `workflow({scriptPath})`). Now the container of the copy reads what lies under its project folder.
//
// The promises, each with the way that breaks it:
//   (1) The version of the copy: a CLAUDE.md changed ONLY in the copy stands in the project memory of the copy chat (the main's
//       does not); a file the copy deleted (whiteout) is not in it; what the copy does not change shows through; the workspace
//       (above the project folder) stays in B. The container is asked ONCE. Counter-test B reads: the old
//       `projectMemoryPrompt(dirs)` reads the main.
//   (2) Main and "without instance" byte-equal to before, without a call in the copy.
//   (3) No fallback: if the container is down or the project folder cannot be determined, the memory of the copy is missing; the
//       main's never takes its place.
//   (4) A real turn in the copy (fake CLI): the system prompt carries the copy's version, in the NEXT turn the newly changed one.
//   (5) `scriptPath`: the route reads the file ahead in the container (readAloudCopy), `startDynWorkflow` takes what was read; the
//       host `workflow({scriptPath})` reads likewise. What the copy does not have is "not readable", never the script of the main.
//   (6) The B anchors of a copy carry only the runtime folder (anchorOfTheInstance): a reader in B given a path in the project
//       folder does not find it in the area (EOUTSIDE); a script in the runtime folder stays in B (no call in the copy).
//   (8) The host of a run reads `scriptPath` in the pinned instance of the RUN (run.instanceIdentifier), not in the chat's current
//       one: main => version of the main; without instance => B; a copy that no longer exists => EOUTSIDE. (9) The same through a
//       real run (start in the main, move into the copy, then workflow({scriptPath})); this checks the call site too.
//   (10) A memory file above the project folder (workspace) whose real place in B lies in the project folder (link to
//       `<P>/CLAUDE.md`, via a "/" such as /proc/self/root to `<P>/AGENTS.md`) is not read by B for the copy: the prompt holds the
//       copy's version, never the main's; main and "without instance" byte-equal.
//   (11) If the project folder of a copy cannot be determined, B reads nothing for it in the runtime folder either (EOUTSIDE):
//       without a lock no area (runs/runtime-limit.js locksOfTheCopy).
//
// No clock: the copy arises through the real series (stacks-copy-harness.mjs); the test waits for states.
//
// Counter-tests (one sabotage each in the real tree; the whole file run):
//   runs/system-prompt.js   projectMemoryPromptIn reads in the main as before (B reads)                       => (1) (3) (4) red
//                           no way `copy` for the memory files (nothing is read)                              => (1) (3) (4) red
//                           project folder of the copy not determinable => memory of the main (fallback)       => (3) red
//   runs/runtime-limit.js   anchorOfTheInstance also carries the project folder of a copy                      => (5) (6) red
//                           readInTheInstance never reads through the container                                => (5) red
//   dynworkflows/run.js     readAloudCopy reads in B instead of the container                                  => (5) red
//   runs/system-prompt.js   projectMemoryPrompt without the lock of the copy                                   => (10) red
//   runs/runtime-limit.js   locksOfTheCopy returns [] instead of throwing (project folder not determinable)   => (11) red
//   dynworkflows/run.js     call `hostWorkflow(chatId)` without run                                           => (8) (9) red
//                           the host's instance without EOUTSIDE for a missing instance                       => (8) red
//                           the host's instance: identifier null reads the binding of the chat                 => (8) red
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { readInRuntimeFolder, anchorOfTheInstance, readInTheInstance } from "../electron/server/runs/runtime-limit.js";
import { workflowScripts } from "../electron/server/runs/outputs.js";
import { locationFor } from "../electron/server/runs/runtime-location.js";
import { copyInstance } from "../electron/server/projectbox/creation.js";
import { instanceForProject, instanceIsCopy } from "../electron/server/runs/instance.js";
import { setCreationOptions } from "../electron/server/projectbox/recreate.js";
import { copyRequests, setCopyState } from "../electron/server/stacks/state.js";
import { projectMemoryPrompt, projectMemoryPromptIn } from "../electron/server/runs/system-prompt.js";
import { startDynWorkflow, readAloudCopy, hostWorkflow } from "../electron/server/dynworkflows/run.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";
import { buildCopy, inCopy, situationDefault, withCopy, withEnvironment, writeInCopy } from "./stacks-copy-harness.mjs";

const script = (name) => `export const meta = { name: '${name}', description: 'Building block ${name}', phases: [{ title: 'Part' }] }\nreturn '${name}';\n`;

// The state in the main BEFORE the copy starts: it shows through in the copy (lower layer).
function mainState(filePath) {
  const write = (rel, content) => { const p = path.join(filePath, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  write("CLAUDE.md", "Rule MAIN-REVISION-1\n");
  write(".claude/CLAUDE.md", "Rule MAIN-DOT-CLAUDE\n");
  write("AGENTS.md", "Rule MAIN-AGENTS\n");
  write("wf/both.js", script("MainRevision"));
  write("wf/only-main.js", script("OnlyInMain"));
}
async function copyWithChat(ctx, b) {
  const pid = b.s.projectId;
  await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
  await buildCopy(b, { chatId: ctx.chat.id });
  const inst = instanceForProject(pid, "copy-k1");
  assert.ok(inst && instanceIsCopy(inst), "the instance of the copy can be resolved");
  return inst;
}
const execInCopy = (b) => b.fd.calls().filter((a) => a.args[0] === "exec" && a.args.includes(b.copy)).length;
const broken = (b) => {
  const cfg = path.join(b.fd.dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, "utf8")), execBroken: [b.copy] }));
};

test("(1) CLAUDE.md changed only in the copy stands in the project memory of the copy, the main's does not; whiteout and showing through; the workspace stays in B; one call in the copy", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-memory-ws-"));
    try {
      fs.writeFileSync(path.join(ws, "CLAUDE.md"), "Rule WS-REVISION-B\n");
      const dirs = [ws, b.s.path];
      await writeInCopy(b, path.join(b.s.path, "CLAUDE.md"), "Rule COPY-REVISION-2\n");
      inCopy(b, b.s.path, "rm", "-f", "AGENTS.md"); // deleted in the copy (whiteout), present in the main

      // The counter-test statement: the old way (B reads) sees the main.
      const inB = projectMemoryPrompt(dirs);
      assert.ok(inB.includes("MAIN-REVISION-1") && !inB.includes("COPY-REVISION-2"), `B reads the main: ${inB}`);
      assert.ok(inB.includes("MAIN-AGENTS"));

      const prior = execInCopy(b);
      const mem = await projectMemoryPromptIn(dirs, inst);
      assert.equal(execInCopy(b) - prior, 1, "all candidates in ONE call in the container");
      assert.ok(mem.includes("COPY-REVISION-2"), `the version of the copy is missing: ${mem}`);
      assert.ok(!mem.includes("MAIN-REVISION-1"), `the version of the main stands in the prompt of the copy: ${mem}`);
      assert.ok(!mem.includes("MAIN-AGENTS"), `a file deleted in the copy stands in the prompt: ${mem}`);
      assert.ok(mem.includes("MAIN-DOT-CLAUDE"), "what the copy does not change shows through");
      assert.ok(mem.includes("WS-REVISION-B"), "the workspace above the project folder stays in B");
      // Order and headings as in B: workspace first, then the project folder.
      assert.ok(mem.indexOf("WS-REVISION-B") < mem.indexOf("COPY-REVISION-2") && mem.indexOf("COPY-REVISION-2") < mem.indexOf("MAIN-DOT-CLAUDE"), mem);
      assert.ok(mem.includes(`## ${path.basename(b.s.path)}${path.sep}CLAUDE.md`), mem);
      assert.ok(mem.startsWith("# Project memory\n"));

      // The main is untouched.
      assert.equal(fs.readFileSync(path.join(b.s.path, "CLAUDE.md"), "utf8"), "Rule MAIN-REVISION-1\n");

      // The next prompt: the file of the copy changes again.
      await writeInCopy(b, path.join(b.s.path, "CLAUDE.md"), "Rule COPY-REVISION-3\n");
      const afterwards = await projectMemoryPromptIn(dirs, inst);
      assert.ok(afterwards.includes("COPY-REVISION-3") && !afterwards.includes("COPY-REVISION-2"), afterwards);

      // Links to the same file stand once (dedup over the resolved place, as in B).
      const dupl = projectMemoryPrompt([b.s.path], { copy: new Map([
        [path.join(b.s.path, "CLAUDE.md"), { real: "/x/a.md", text: "EQUAL\n" }],
        [path.join(b.s.path, "AGENTS.md"), { real: "/x/a.md", text: "EQUAL\n" }],
        [path.join(b.s.path, ".claude", "CLAUDE.md"), null],
      ]) });
      assert.equal(dupl.split("EQUAL").length - 1, 1, dupl);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });
});

test("(2) main and without instance: byte-equal to projectMemoryPrompt, no call in the copy", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    await copyWithChat(ctx, b);
    const dirs = [b.s.path];
    const expected = projectMemoryPrompt(dirs);
    assert.ok(expected.includes("MAIN-REVISION-1"));
    const prior = execInCopy(b);
    assert.equal(await projectMemoryPromptIn(dirs, null), expected, "without instance");
    assert.equal(await projectMemoryPromptIn(dirs, undefined), expected);
    assert.equal(await projectMemoryPromptIn(dirs, instanceForProject(b.s.projectId)), expected, "the instance of the main");
    assert.equal(execInCopy(b), prior, "a call in the copy");
  });
});

test("(3) no fallback: if the container is down or the project folder cannot be determined, the memory of the copy is missing; the main's never takes its place", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-memory-ws-"));
    const logged = [];
    const log = console.log;
    console.log = (...a) => { logged.push(a.join(" ")); };
    try {
      fs.writeFileSync(path.join(ws, "CLAUDE.md"), "Rule WS-REVISION-B\n");
      broken(b);
      const mem = await projectMemoryPromptIn([ws, b.s.path], inst);
      assert.ok(mem.includes("WS-REVISION-B"), "the workspace lies in B and stays");
      assert.ok(!/MAIN-/.test(mem), `the memory of the main took its place: ${mem}`);
      assert.ok(logged.some((z) => z.includes("[project-memory]")), `no log line: ${logged.join(" | ")}`);

      // The project folder of the copy cannot be determined: nothing at all (not even the workspace; the block is missing entirely).
      const foreign = { projectId: "exists-not", instance: "copy-k9", identifier: "exists-not/copy-k9" };
      const empty = await projectMemoryPromptIn([ws, b.s.path], foreign);
      assert.equal(empty, "", `without a determinable project folder: ${empty}`);
    } finally { console.log = log; fs.rmSync(ws, { recursive: true, force: true }); }
  });
});

// ── (4) A real turn in the copy ──────────────────────────────────────────────────────────────────────────────────────────
// The environment as in the move-in tests: simple containers (no overlay), the copy set "ready" through the real setters. The overlay
// view is missing here (B and container see the same file); what is proven is the WAY: the memory of the turn comes from an `exec`
// IN the copy container.
const MAIN_CLI = `
  fs.appendFileSync(path.join(LOCATION, "prompts.jsonl"), JSON.stringify({ text, sp: arg("--append-system-prompt") }) + "\\n");
  finished();
  say({ type: "result", result: "ok", session_id: "s-main" });`;
const ops = (fd) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200",
  CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex") });
const containerStart = (fd, name) => execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
const readCalls = (fd, container) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec" && a.args.includes(container) && a.args.includes("readMany"));

test("(4) a real turn in the copy: the project memory of the system prompt comes from an exec in the copy container, never from B; in the main as before", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      await withEnvironment(ops(fd), async () => {
        const filePath = path.join(ctx.root, "workspace", "till");
        fs.mkdirSync(filePath, { recursive: true });
        fs.writeFileSync(path.join(filePath, "CLAUDE.md"), "Rule PROJECT-REVISION-1\n");
        const p = await ctx.projectWithoutInstance({ name: "Till", path: filePath });
        const main = `cbase-p-${p.id}`;
        const copyName = `cbase-k-${p.id}-k1`;
        containerStart(fd, main);
        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: main });
        await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
        const prompts = () => readJsonl(path.join(ctx.root, "prompts.jsonl"));
        const turn = async (text) => {
          const n = prompts().length;
          await json(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { method: "POST", body: JSON.stringify({ text }) });
          await waitForTruthy(async () => (prompts().length > n || (await json(`${ctx.base}/api/runs/active`)).runs === 0 ? true : null), `turn ${text}`);
          assert.ok(prompts().length > n, `${text}: the run ended without the fake CLI seeing a turn`);
          await ctx.waitForQuiet();
          return prompts()[n];
        };

        // In the main: B reads, the container is not asked.
        const inMain = await turn("MEMORY-MAIN");
        assert.ok(inMain.sp.includes("PROJECT-REVISION-1"), inMain.sp.slice(-400));
        assert.equal(readCalls(fd, main).length + readCalls(fd, copyName).length, 0, "in the main a container read the memory");

        // The copy becomes ready (real setters, wakeup marker beforehand): the next turn runs in it.
        const k = copyRequests({ projectId: p.id, name: "k1", chatId: ctx.chat.id });
        setCopyState(k.id, "build", { phase: "clone1" });
        containerStart(fd, copyName);
        store.writeStackCopyJournal(k.id, { data: { inset: { wakeCall: { state: "ready", at: 0 } } } });
        setCopyState(k.id, "ready", { result: { branchSpace: "copy/k1/", hints: [] } });
        try {
          fs.writeFileSync(path.join(filePath, "CLAUDE.md"), "Rule PROJECT-REVISION-2\n");
          const inCopy = await turn("MEMORY-COPY");
          assert.ok(inCopy.sp.includes("# Your copy"), "the turn did not run in the copy");
          assert.ok(inCopy.sp.includes("PROJECT-REVISION-2"), inCopy.sp.slice(-400));
          assert.equal(readCalls(fd, copyName).length, 1, "the memory did not come in ONE call from the copy container");
          assert.equal(readCalls(fd, main).length, 0, "the memory of the copy came from the main container");
        } finally {
          for (const z of store.liveStackCopies()) {
            try {
              if (["build", "ready", "clearAway"].includes(z.state)) setCopyState(z.id, "error", { error: "test end" });
              store.deleteProjectInstance(z.projectId, copyInstance(z.name));
              setCopyState(z.id, "removed");
            } catch { /* already gone */ }
          }
        }
      });
    }, { claude: fakeClaude({ main: MAIN_CLI }) });
  } finally { fd.cleanUp(); }
});

// ── (5) scriptPath ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(5) scriptPath of a copy chat: the route reads ahead in the container, the host workflow({scriptPath}) likewise: the version of the copy, never the script of the main", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const chat = () => store.getChat(ctx.chat.id);
    const p = (rel) => path.join(b.s.path, rel);
    await writeInCopy(b, p("wf/both.js"), script("CopyRevision"));
    await writeInCopy(b, p("wf/only-copy.js"), script("OnlyInTheCopy"));
    inCopy(b, b.s.path, "rm", "-f", "wf/only-main.js"); // deleted in the copy, present in the main

    // The route reads ahead; without an explicit path or in the main there is nothing to read ahead.
    const v = await readAloudCopy(chat(), { scriptPath: p("wf/both.js") });
    assert.equal(v.path, p("wf/both.js"));
    assert.ok(v.script.includes("CopyRevision") && !v.script.includes("MainRevision"), JSON.stringify(v));
    assert.equal(await readAloudCopy(chat(), { script: "x" }), null);
    assert.equal(await readAloudCopy(chat(), { scriptPath: "  " }), null);
    const missing = await readAloudCopy(chat(), { scriptPath: p("wf/only-main.js") });
    assert.ok(missing.error && !missing.script, `a script deleted in the copy was read: ${JSON.stringify(missing)}`);

    // startDynWorkflow takes what was read ahead: the card carries the name from the script of the COPY.
    const r = startDynWorkflow(chat(), { scriptPath: p("wf/both.js") }, { readAloud: v });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.name, "CopyRevision", "the card does not name the script of the copy");
    const onlyCopy = startDynWorkflow(chat(), { scriptPath: p("wf/only-copy.js") }, { readAloud: await readAloudCopy(chat(), { scriptPath: p("wf/only-copy.js") }) });
    assert.equal(onlyCopy.status, 202, JSON.stringify(onlyCopy.body));
    assert.equal(onlyCopy.body.name, "OnlyInTheCopy");
    const way = startDynWorkflow(chat(), { scriptPath: p("wf/only-main.js") }, { readAloud: missing });
    assert.equal(way.status, 400, JSON.stringify(way.body));
    assert.match(JSON.stringify(way.body), /nicht lesbar/);
    assert.ok(!JSON.stringify(way.body).includes("OnlyInMain"), "the script of the main in the error");
    // Without reading ahead (a caller that forgets it): closed; B carries no anchor for the project folder of a copy.
    const without = startDynWorkflow(chat(), { scriptPath: p("wf/both.js") });
    assert.equal(without.status, 400, JSON.stringify(without.body));
    assert.match(JSON.stringify(without.body), /EOUTSIDE/);
    assert.ok(!JSON.stringify(without.body).includes("MainRevision"));

    // The host of the workflow (workflow({scriptPath}) in the script).
    const host = hostWorkflow(ctx.chat.id);
    assert.ok((await host({ scriptPath: p("wf/both.js") })).script.includes("CopyRevision"));
    await assert.rejects(() => host({ scriptPath: p("wf/only-main.js") }), /nicht lesbar|not readable/);
    await assert.rejects(() => host({ scriptPath: "relative.js" }), /absolute/);

    // The container is down: nothing, not even from the main.
    broken(b);
    const stands = await readAloudCopy(chat(), { scriptPath: p("wf/both.js") });
    assert.ok(stands.error && !stands.script, JSON.stringify(stands));
    await assert.rejects(() => host({ scriptPath: p("wf/both.js") }), /nicht lesbar|not readable/);
    assert.ok(inst);
  });
});

test("(8) workflow({scriptPath}) of a running workflow reads in the pinned instance of the RUN, not in the current one of the chat", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const mainIdentifier = `${pid}/main`;
    await copyWithChat(ctx, b); // the chat is now bound to the copy, the run was (supposedly) started in the main
    const p = (rel) => path.join(b.s.path, rel);
    await writeInCopy(b, p("wf/both.js"), script("CopyRevision"));
    inCopy(b, b.s.path, "rm", "-f", "wf/only-main.js");
    // Run in the main: the version of the main, also the file the copy deleted; never a call in the copy.
    const before = execInCopy(b);
    const inMain = hostWorkflow(ctx.chat.id, { instanceIdentifier: mainIdentifier });
    assert.ok((await inMain({ scriptPath: p("wf/both.js") })).script.includes("MainRevision"), "the run in the main read the version of the copy");
    assert.ok((await inMain({ scriptPath: p("wf/only-main.js") })).script.includes("OnlyInMain"), "the run in the main did not find the file of the main");
    assert.equal(execInCopy(b), before, "the run in the main asked the copy");
    // Run without instance (null): in B as before.
    assert.ok((await hostWorkflow(ctx.chat.id, { instanceIdentifier: null })({ scriptPath: p("wf/both.js") })).script.includes("MainRevision"));
    // Opposite direction: run in a copy that no longer exists => closed (EOUTSIDE), never the main.
    await assert.rejects(() => hostWorkflow(ctx.chat.id, { instanceIdentifier: `${pid}/copy-away` })({ scriptPath: p("wf/both.js") }), /EOUTSIDE|nicht mehr|not readable/);
    // Restart (identifier undetermined): the binding of the chat applies as before, i.e. the version of the copy.
    assert.ok((await hostWorkflow(ctx.chat.id, {})({ scriptPath: p("wf/both.js") })).script.includes("CopyRevision"));
    assert.ok((await hostWorkflow(ctx.chat.id)({ scriptPath: p("wf/both.js") })).script.includes("CopyRevision"));
  });
});

test("(9) a run started in the main calls workflow({scriptPath}) after the chat was bound to the copy: the script comes from the main, not from the copy", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const p = (rel) => path.join(b.s.path, rel);
    await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
    store.updateChat(ctx.chat.id, { ultracode: 1 });
    const wf = `export const meta = { name: 'Host', description: 'Calls sub-workflows', phases: [{ title: 'Part' }] }\n`
      + `return [await workflow({ scriptPath: ${JSON.stringify(p("wf/both.js"))} }), await workflow({ scriptPath: ${JSON.stringify(p("wf/only-main.js"))} })];\n`;
    // The run begins in the main (its identifier is fixed from the start) ...
    const start = startDynWorkflow(store.getChat(ctx.chat.id), { script: wf });
    assert.equal(start.status, 201, JSON.stringify(start.body));
    // ... then the chat moves into the copy: the file there is different or missing.
    await copyWithChat(ctx, b);
    await writeInCopy(b, p("wf/both.js"), script("CopyRevision"));
    inCopy(b, b.s.path, "rm", "-f", "wf/only-main.js");
    const before = execInCopy(b);
    start.go();
    await waitForTruthy(() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(start.body.scriptPath), "result.json"), "utf8")).status; } catch { return false; } }, "the result of the run");
    const res = JSON.parse(fs.readFileSync(path.join(path.dirname(start.body.scriptPath), "result.json"), "utf8"));
    assert.equal(res.status, "finished", JSON.stringify(res).slice(0, 600));
    assert.deepEqual(res.returnValue, ["MainRevision", "OnlyInMain"], "the sub-workflow did not come from the instance of the run (main)");
    assert.equal(execInCopy(b), before, "the run in the main asked the copy");
  });
});

// ── (6) The B anchors ────────────────────────────────────────────────────────────────────────────────────────────────────
test("(6) the B anchors of a copy carry only the runtime folder: a project path is not readable in B (EOUTSIDE), a script in the runtime folder stays in B; main unchanged", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const main = instanceForProject(b.s.projectId);
    const anchor = anchorOfTheInstance(inst);
    assert.equal(anchor.length, 1, `anchor of the copy: ${anchor}`);
    assert.ok(anchor[0].includes(b.s.projectId) && !anchor.includes(path.resolve(b.s.path)), `the project folder is a B anchor of the copy: ${anchor}`);
    assert.deepEqual(anchorOfTheInstance(main), [path.resolve(b.s.path), anchor[0]], "the main keeps both anchors");

    // A reader in B for a project path of the copy: not in the area.
    assert.throws(() => readInRuntimeFolder(path.join(b.s.path, "wf/both.js"), { instance: inst, encoding: "utf8" }), (e) => e.code === "EOUTSIDE");
    // In the main the same path: readable (as before).
    assert.ok(readInRuntimeFolder(path.join(b.s.path, "wf/both.js"), { instance: main, encoding: "utf8" }).includes("MainRevision"));

    // A script in the runtime folder of the copy: read in B, no call in the container.
    const folder = path.join(workflowScripts(ctx.chat.id), "wf_test");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "script.js"), script("InRuntimeFolder"));
    const prior = execInCopy(b);
    const text = await readInTheInstance(path.join(folder, "script.js"), { instance: inst, encoding: "utf8" });
    assert.ok(text.includes("InRuntimeFolder"));
    assert.equal(execInCopy(b), prior, "the runtime folder stays in B");
    // A path neither in the project nor in the runtime folder: not readable, in B as in the copy.
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-memory-foreign-"));
    try {
      fs.writeFileSync(path.join(foreign, "anywhere.js"), "FOREIGN");
      await assert.rejects(() => readInTheInstance(path.join(foreign, "anywhere.js"), { instance: inst, encoding: "utf8" }), (e) => e.code === "EOUTSIDE");
    } finally { fs.rmSync(foreign, { recursive: true, force: true }); }
    assert.equal(execInCopy(b), prior);
  });
});

// ── (7) A turn in a REALLY built copy ──────────────────────────────────────────────────────────────────────────────────
// (4) builds the copy with simple containers; here it arises through the real series and the real creation (labels, mounts hash).
// The turn start (projectbox/recreate.js check, desired state from the mounts WITH the instance) must find its container at once:
// a turn in the copy recreates nothing (a recreation in the middle of the move-in would destroy the copy) and runs in its
// container, never in the main.
test("(7) a turn in a really built copy (real series, real creation): the turn start finds image and mounts label at once, no recreation; the CLI runs in the copy container, the main is not asked", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
    await buildCopy(b, { chatId: ctx.chat.id });
    // The series built with the options of the scenario (home, system); the turn start asks the same (in operation they are the defaults of both).
    setCreationOptions(() => b.opts);
    const rows = [];
    const log = console.log;
    console.log = (...a) => { rows.push(a.join(" ")); log(...a); };
    try {
      const before = b.fd.calls().length;
      const prompts = () => readJsonl(path.join(ctx.root, "prompts.jsonl"));
      await json(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "TURN-IN-REAL-COPY" }) });
      await waitForTruthy(async () => (prompts().length > 0 || (await json(`${ctx.base}/api/runs/active`)).runs === 0 ? true : null), "turn in the copy");
      await ctx.waitForQuiet();
      assert.equal(prompts().length, 1, "the fake CLI saw no turn");
      assert.ok(prompts()[0].sp.includes("# Your copy"), "the turn did not run in the copy");
      const after = b.fd.calls().slice(before);
      assert.ok(after.some((a) => a.args[0] === "exec" && a.args.includes(b.copy) && a.args.includes("-u")), "the CLI did not run through exec in the copy container");
      assert.equal(after.filter((a) => a.args[0] === "exec" && a.args.includes(b.main)).length, 0, "the main was asked");
      assert.equal(after.filter((a) => ["stop", "rm", "run", "kill", "restart"].includes(a.args[0])).length, 0, "a turn in the copy recreated or stopped a container");
      assert.deepEqual(rows.filter((z) => /\[projectbox\] recreation/.test(z)), [], "the turn start took the copy container for deviating");
    } finally { console.log = log; setCreationOptions(null); }
  }, { claude: fakeClaude({ main: MAIN_CLI }) });
});

test("(10) a memory file above the project folder that lands in B as a link in the project folder of the main is not read by B for the copy: the prompt holds the version of the copy, never the main's", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-memory-ws-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-memory-root-"));
    try {
      await writeInCopy(b, path.join(b.s.path, "CLAUDE.md"), "Rule COPY-REVISION-2\n");
      await writeInCopy(b, path.join(b.s.path, "AGENTS.md"), "Rule COPY-AGENTS\n");
      // In the workspace (in B): CLAUDE.md points to the file in the project folder, AGENTS.md through a "/" (like /proc/self/root) likewise.
      fs.symlinkSync(path.join(b.s.path, "CLAUDE.md"), path.join(ws, "CLAUDE.md"));
      fs.symlinkSync("/", path.join(outside, "root"));
      fs.symlinkSync(path.join(outside, "root") + path.join(b.s.path, "AGENTS.md"), path.join(ws, "AGENTS.md"));
      const inB = projectMemoryPrompt([ws, b.s.path]);
      assert.ok(inB.includes("MAIN-REVISION-1") && inB.includes("MAIN-AGENTS"), `the counter-test statement: B reads the main through the links: ${inB}`);
      const mem = await projectMemoryPromptIn([ws, b.s.path], inst);
      assert.ok(!mem.includes("MAIN-REVISION-1") && !mem.includes("MAIN-AGENTS"), `the memory of the main stands in the prompt of the copy: ${mem}`);
      assert.ok(mem.includes("COPY-REVISION-2") && mem.includes("COPY-AGENTS"), `the version of the copy is missing: ${mem}`);
      // Without a copy (main, no instance) byte-equal as before: the links apply.
      assert.equal(await projectMemoryPromptIn([ws, b.s.path], instanceForProject(b.s.projectId)), inB);
      assert.equal(await projectMemoryPromptIn([ws, b.s.path], null), inB);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("(11) if the project folder of a copy cannot be determined, B reads nothing for it in the runtime folder either: without a lock no area (empty is not unknown)", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const foreign = { projectId: "exists-not", instance: "copy-k9", identifier: "exists-not/copy-k9" };
    const location = locationFor({ projectId: foreign.projectId, converted: true }).root;
    const file = path.join(location, "outputs", "c1", "report.txt");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "REPORT");
    try {
      assert.throws(() => readInRuntimeFolder(file, { instance: foreign, encoding: "utf8" }), (e) => e.code === "EOUTSIDE" && /project folder of the copy exists-not\/copy-k9 cannot be determined/.test(e.message));
      await assert.rejects(() => readInTheInstance(file, { instance: foreign, encoding: "utf8" }), (e) => e.code === "EOUTSIDE");
      // The counter-test: in the runtime folder of a copy WITH a project folder B reads as before.
      const own = path.join(locationFor({ projectId: b.s.projectId, converted: true }).root, "outputs", "c1", "report.txt");
      fs.mkdirSync(path.dirname(own), { recursive: true });
      fs.writeFileSync(own, "OWN");
      assert.equal(readInRuntimeFolder(own, { instance: inst, encoding: "utf8" }), "OWN");
    } finally { fs.rmSync(location, { recursive: true, force: true }); }
  });
});
