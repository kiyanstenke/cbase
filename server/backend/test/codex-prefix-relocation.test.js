// The prefix of a Codex thread (providers/connectors/codex-prefix.js) in the project home - exactly ONCE per version
// after conversion, project switch and session relocation.
//
// The proof "does the thread already carry this version" is its rollout in the home of THIS run: in B the home of B, in
// the project container the home of the project (`<runtime>/home/.codex`, runs/session-location.js projectCodexDir).
// Before the spawn the rollout moves there (sessionForStart). codex-prefix.test.js checks the proof only with one home
// and at the connector; here the whole way through the real server, the fake docker of the project containers and the
// fake Codex CLI of the harness, which writes its input into the rollout like the real one as `response_item`.
//
// The promise (one chat, one thread, eight turns):
//   ONE    project P1 without instance, run in B: new thread => block (version A).
//   TWO    same thread, nothing changed => no block.
//   THREE  P1 converted (instance): the rollout moves into the home of P1, the resume finds it; the set grows by the
//          instance tools => block with new version B != A - exactly once.
//   FOUR   in the project home, nothing changed => no block (the proof reads the project home).
//   FIVE   project switch to P2 (own instance, own home): the rollout moves into the home of P2 => block C (other project).
//   SIX    => no block.
//   SEVEN  back to P1: the rollout moves back; the most recent block is C => block B again (a newer version replaces
//          the older one).
//   EIGHT  => no block.
// Every turn with a block carries a different version than the most recent block before (otherwise it would be
// doubled), every turn continues the same thread, and after ONE no "resume_failed".
//
// Counter-tests:
//   agent-harness.mjs fakeCodex without the response_item row (the old fake)           => red at TWO (every turn with a block)
//   connectors/codex.js runChatCodex: `rolloutOfTheThread(id, null)` instead of the instance    => red at FOUR (proof searched in the home of B)
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/codex-prefix-relocation.test.js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { projectClaudeDir, projectCodexDir } from "../electron/server/runs/session-location.js";
import { fakeCodex, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
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

// Like session-transfer.test.js: operation mark, fake docker, the CLI homes of B in a throwaway folder; the container of
// a project with the environment of the setup (CLAUDE_CONFIG_DIR, CODEX_HOME in the CLI home of its runtime folder).
const bEnvironment = (fd, root) => ({
  CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200",
  CLAUDE_CONFIG_DIR: path.join(root, "b-home", ".claude"), CODEX_HOME: path.join(root, "b-home", ".codex"),
  CBASE_CODEX_PREFIX_EVERY_TURN: undefined,
});
async function project(ctx, fd, name) {
  const filePath = path.join(ctx.ws.path, name.toLowerCase());
  fs.mkdirSync(filePath, { recursive: true });
  const p = await ctx.projectWithoutInstance({ name, path: filePath });
  const container = `cbase-p-${p.id}`;
  execFileSync(fd.bin, ["run", "-d", "--name", container, "-e", `CLAUDE_CONFIG_DIR=${projectClaudeDir(p.id)}`, "-e", `CODEX_HOME=${projectCodexDir(p.id)}`, "cbase-projectbox:test"],
    { env: { ...process.env, ...fd.env } });
  return { p, convert: () => store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: container }) };
}

// The harness CLI that appends every argv (like codex-own-tools.test.js).
const CODEX = fakeCodex({ text: "Codex answer" })
  .replace("const say =", "fs.appendFileSync(path.join(LOCATION, \"cx-codex-argv.jsonl\"), JSON.stringify(process.argv.slice(2)) + \"\\n\");\nconst say =");
const revisionOf = (prompt) => (/^\[SYSTEM-DEFAULTS \(revision ([0-9a-f]{12})\)/.exec(prompt) || [])[1] || null;
const resumeOf = (argv) => { const i = argv.indexOf("resume"); return i >= 0 ? argv[i + 1] : null; };

test("Codex prefix in the project home: exactly once per version - after conversion, project switch and way back", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws, root } = ctx;
      await withEnvironment(bEnvironment(fd, root), async () => {
        const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "codex", model: "gpt-5.6-sol", permissionMode: "bypassPermissions" }) });
        await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Codex relocation" }) });
        const p1 = await project(ctx, fd, "Checkout");
        const p2 = await project(ctx, fd, "Warehouse");
        const setProject = (p) => json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.p.id }) });
        await setProject(p1);

        const argvs = () => (fs.existsSync(path.join(root, "cx-codex-argv.jsonl")) ? readJsonl(path.join(root, "cx-codex-argv.jsonl")) : []);
        const history = [];
        let n = 0;
        const turn = async (text) => {
          await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text }) });
          n += 1;
          await waitForTruthy(async () => (await json(`${base}/api/chats/${chat.id}/log`)).filter((m) => m.role === "assistant").length >= n, `Codex ${text}`);
          await ctx.waitForQuiet();
          const own = argvs().filter((a) => String(a[a.length - 1]).endsWith(text));
          assert.equal(own.length, 1, `${text}: exactly one Codex process (no failed resume with retry) - ${own.length}`);
          const argv = own[0];
          const z = { text, revision: revisionOf(argv[argv.length - 1]), resume: resumeOf(argv) };
          history.push(z);
          return z;
        };

        const one = await turn("ONE");
        assert.ok(one.revision, "ONE: new thread => block");
        assert.equal(one.resume, null);
        const thread = (await turn("TWO")).resume;
        assert.ok(thread, "TWO continues the thread");
        assert.equal(history[1].revision, null, "TWO: same thread in B, nothing changed => no block");

        p1.convert();
        const three = await turn("THREE");
        assert.ok(three.revision && three.revision !== one.revision, "THREE: in the project container the set grows (instance tools) => block with new version");
        const four = await turn("FOUR");
        assert.equal(four.revision, null, "FOUR: the rollout in the project home carries the version => no block");
        assert.ok(fs.readdirSync(path.join(projectCodexDir(p1.p.id), "sessions"), { recursive: true }).some((f) => String(f).endsWith(`-${thread}.jsonl`)), "the rollout lies in the home of P1");

        p2.convert();
        await setProject(p2);
        const five = await turn("FIVE");
        assert.ok(five.revision && five.revision !== three.revision, "FIVE: other project => block with new version");
        assert.equal((await turn("SIX")).revision, null, "SIX: proven in the home of P2 => no block");

        await setProject(p1);
        const seven = await turn("SEVEN");
        assert.equal(seven.revision, three.revision, "SEVEN: back in P1 - the most recent block is that of P2 => the version of P1 once more");
        assert.equal((await turn("EIGHT")).revision, null, "EIGHT: => no block");

        // Overall: every turn continues the SAME thread, and no block repeats the most recent before it.
        for (const z of history.slice(1)) assert.equal(z.resume, thread, `${z.text}: same thread`);
        let mostRecent = null;
        for (const z of history) {
          if (!z.revision) continue;
          assert.notEqual(z.revision, mostRecent, `${z.text}: the block repeats the most recent in the thread`);
          mostRecent = z.revision;
        }
        console.log(`[codex-prefix-relocation] ${history.map((z) => `${z.text}:${z.revision || "-"}`).join(" ")}`);
      });
    }, { codex: CODEX });
  } finally {
    fd.cleanUp();
  }
});
