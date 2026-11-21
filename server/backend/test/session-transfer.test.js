// CLI home per project and transcript relocation.
//
// The promise: a resume of a chat whose project was moved finds its session in the project's home — for the chat, for a subagent and
// for Codex; without an instance the turn start reads and writes nothing at a new place. The fake CLIs of the harness
// (agent-harness.mjs) report a missing session like the real ones ("No conversation found with session ID" resp. "no rollout found
// for thread id", exit 1, no result) — as soon as CLAUDE_CONFIG_DIR/CODEX_HOME lie in the throwaway folder.
//
//   (1) Slug against the measured values; pullClaudeSession/pullCodexRollout (newest wins, tmp + rename, `<sid>/`, "present", old copies
//       only after the confirmation, a fork cleans nothing up). (1e): the slug shortens above 200 characters like the pinned CLI
//       (measured pairs), and a pull for a long cwd is "present" instead of deleting the real session.
//   (2) Main seam Claude: session in B, project moved => next turn without resume_failed_retrying, resume from the project home, the
//       copy in B falls after the confirmed turn; the relocation turn carries the hint `<old>/<sid>/ → <new>/<sid>/`. If both copies
//       are missing: retry without resume AND a hint row in the history.
//   (3) Subagent: a resumed subagent with a session in B finds it in the project container; its successful turn removes its old
//       copies in B, its input carries the hint.
//   (4) Codex: the rollout moves under the same relative path into the project's home.
//   (5) Rollout readers (codexSessionRoots) see the Codex homes of the projects.
//   (6) Without an instance and without an instance row: no file access.
//   (7) CLI home: createCliHome (three folders, .claude.json only with three fields, 0600, once), trust entry (idempotent, in place,
//       the rest byte-equal), copyLocal (venv link stays a link; state/ and share/<x> only after assignment).
//   (8) pullSessionsOfTheProject: chat and subagents of a project in one go.
//   (9) fetchSessionsBack: back to B when deleting a project.
//
// Counter-tests (each red): sessionSlug without the shortening => (1e); agent-runtime.js without `confirmSession` => (3) "`.jsonl`
// and <sid>/ in B fall"; the agent input without `input: agentInput` => (3) "the hint to the subagent"; do-run.js without the hint
// row => (2); sessionForStart => `return null` => (2) (3) (4) red (resume_failed_retrying resp. no resume); copyLocal with `cp -RL`
// => (7) red (the link becomes a file); copyLocal with the whole ~/.local => (7) red (the second project carries
// state/orbit-mcp); the old codexSessionRoots => (5) red.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import * as store from "../electron/server/store.js";
import { DIRS, setDirs } from "../electron/server/app-state.js";
import { removeCopies, sessionSlug, pullClaudeSession, pullCodexRollout } from "../electron/server/runs/session-transfer.js";
import { projectClaudeDir, projectCodexDir, sessionConfirmed, sessionForStart, pullSessionsOfTheProject } from "../electron/server/runs/session-location.js";
import { codexRateLimitSnapshot, codexUsage, readCodexTokenSnapshot, setCodexHomeSource } from "../electron/server/providers/connectors/codex.js";
import { CLAUDE_JSON_FIELDS, codexTrustText, copyLocal, createCliHome, localReferences, enterCodexTrust } from "../electron/server/projectbox/cli-home.js";
import { fakeClaude, fakeCodex, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";

const HAIKU = "claude-haiku-4-5-20251001";
const real = (p) => fs.realpathSync(p);
const disposable = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `cbase-${name}-`));

async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const OPS = { CBASE_CONTAINER: "1", CBASE_DIND: "1" };
// A data folder for the units without a server (runs/runtime-location.js needs DIRS.data).
async function withData(fn) {
  const prior = DIRS;
  const d = disposable("session-data");
  setDirs({ data: d, scratch: path.join(d, "scratch"), attachments: path.join(d, "attachments"), outputs: path.join(d, "outputs") });
  try { return await fn(d); } finally { setDirs(prior); fs.rmSync(d, { recursive: true, force: true }); }
}
function write(file, content, mtimeSec = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtimeSec !== null) fs.utimesSync(file, mtimeSec, mtimeSec);
}

// ── (1) The mechanics ───────────────────────────────────────────────────────────────────────────────────────────────

test("(1a) slug: every character except [A-Za-z0-9] becomes \"-\"", () => {
  assert.equal(sessionSlug("/tmp/cbase-measurement-a"), "-tmp-cbase-measurement-a");
  assert.equal(sessionSlug("/tmp/cbase-measurement-ws/proj"), "-tmp-cbase-measurement-ws-proj");
  assert.equal(sessionSlug("/home/agent/workspaces/examplecorp"), "-home-agent-workspaces-examplecorp");
  assert.equal(sessionSlug("/a/b.c_d e~f"), "-a-b-c-d-e-f");
});

// The shortening as 2.1.280 computes it — rebuilt independently of the product. That the rebuild is the CLI's is a measurement on
// the 2.1.280 binary (three cwd/folder pairs); those pairs carry the product name of that time in their paths, the name is part of
// the measurement (the shortening counts the characters, the hash covers the whole path), so they are held outside the public
// tree. Here the product is held against the rebuild on paths of the same shape: two long ones (shortened, hash), one short one.
const cliSlug = (cwd) => {
  const s = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (s.length <= 200) return s;
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return `${s.slice(0, 200)}-${Math.abs(h).toString(36)}`;
};
const LONG_FOLDERS = `${"one_very.long-folder".repeat(4)}/${"x".repeat(60)}/project.with_dots`;
const SHAPES_2_1_280 = [
  `/private/var/folders/9p/T/cbase-slug-y2ARi5/cwd/${LONG_FOLDERS}`,
  `/private/var/folders/9p/T/cbase-s1-12-slug-R4Pooq/cwd/${LONG_FOLDERS}`,
  "/private/var/folders/9p/T/cbase-s1-12-slug-R4Pooq/short.cwd",
];

test("(1e) the slug shortens above 200 characters like the pinned CLI (rebuilt as measured on 2.1.280) — otherwise the confirmation would delete the real session", () => {
  for (const cwd of SHAPES_2_1_280) assert.equal(sessionSlug(cwd), cliSlug(cwd), `${cwd.length} characters`);
  assert.deepEqual(SHAPES_2_1_280.map((cwd) => sessionSlug(cwd).length > 200), [true, true, false], "two shortened, one not");
  for (const cwd of SHAPES_2_1_280.slice(0, 2)) {
    assert.match(sessionSlug(cwd), /^-private-var-folders-.{170,}-[0-9a-z]+$/, "the first 200 characters, then the hash");
    assert.equal(sessionSlug(cwd).slice(0, 200), cwd.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200));
  }
  const exactly200 = `/${"a".repeat(199)}`;
  assert.equal(sessionSlug(exactly200), `-${"a".repeat(199)}`, "exactly 200 characters: unshortened");
  assert.match(sessionSlug(`${exactly200}b`), /^-a{199}-[0-9a-z]+$/, "201 characters: the first 200, then the hash");
  assert.equal(sessionSlug(`${exactly200}b`), cliSlug(`${exactly200}b`));

  // The failure case: a long cwd, the session already lies in the REAL (shortened) slug in the run's home.
  const r = disposable("session-lang");
  try {
    const p = path.join(r, "p", ".claude");
    // Long by itself, not by the temp folder: on macOS os.tmpdir() alone is ~50 characters, on Linux /tmp is 4 — with 40 x the path
    // stayed under 200 there (CI red at "the path is long enough").
    const cwd = path.join(r, "ws", "one_very.long-folder".repeat(6), "x".repeat(80), "till");
    fs.mkdirSync(cwd, { recursive: true });
    assert.ok(real(cwd).length > 200, "the path is long enough");
    const sid = "sid-lang-0001";
    const realFile = path.join(p, "projects", cliSlug(real(cwd)), `${sid}.jsonl`);
    write(realFile, "turn1\nturn2\n", 1_800_000_000);
    const turn = pullClaudeSession({ sid, destination: p, cwd, sources: [p] });
    assert.equal(turn.status, "present", "the session already lies where the CLI looks for it — nothing to copy");
    assert.equal(turn.target, realFile);
    sessionConfirmed(turn, sid);
    assert.equal(fs.readFileSync(realFile, "utf8"), "turn1\nturn2\n", "the confirmation leaves the real session alone");
    assert.deepEqual(fs.readdirSync(path.join(p, "projects")), [cliSlug(real(cwd))], "no second, unshortened slug");
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("(1b) pullClaudeSession: the newest copy moves into the slug of the new cwd, with <sid>/; old ones only after the confirmation", () => {
  const r = disposable("session-claude");
  try {
    const b = path.join(r, "b", ".claude");
    const p = path.join(r, "p", ".claude");
    const cwd = path.join(r, "ws", "till");
    fs.mkdirSync(cwd, { recursive: true });
    const sid = "0f8e3c1a-1111-4000-8000-000000000001";
    const old = path.join(b, "projects", sessionSlug(path.join(r, "ws")), `${sid}.jsonl`);
    write(old, "row-1\nrow-2\n", 1_800_000_000);
    write(path.join(path.dirname(old), sid, "tool-results", "t1.txt"), "result");
    // An OLDER copy in a third slug of the same home — it loses.
    const older = path.join(b, "projects", "-elsewhere", `${sid}.jsonl`);
    write(older, "row-1\n", 1_700_000_000);

    const turn = pullClaudeSession({ sid, destination: p, cwd, sources: [b, p] });
    const target = path.join(p, "projects", sessionSlug(real(cwd)), `${sid}.jsonl`);
    assert.equal(turn.status, "copied");
    assert.equal(turn.target, target);
    assert.equal(turn.source, old);
    assert.equal(fs.readFileSync(target, "utf8"), "row-1\nrow-2\n");
    assert.equal(Math.round(fs.statSync(target).mtimeMs / 1000), 1_800_000_000, "the timestamp goes along");
    assert.equal(fs.readFileSync(path.join(path.dirname(target), sid, "tool-results", "t1.txt"), "utf8"), "result", "the folder <sid>/ goes along");
    assert.ok(fs.readdirSync(path.dirname(target)).every((n) => !n.includes(".transfer-")), "no tmp remainder");
    assert.ok(fs.existsSync(old) && fs.existsSync(older), "the old copies stay until the confirmation");
    assert.deepEqual(new Set(turn.old), new Set([old, path.join(path.dirname(old), sid), older]));

    // A fork writes a NEW session: nothing falls.
    assert.equal(sessionConfirmed(turn, "one-other-session"), 0);
    assert.ok(fs.existsSync(old));
    // The turn at the new place is confirmed (same session): the old ones fall, the new one stays.
    assert.equal(sessionConfirmed(turn, sid), 3);
    assert.ok(!fs.existsSync(old) && !fs.existsSync(older) && !fs.existsSync(path.join(path.dirname(old), sid)));
    assert.ok(fs.existsSync(target));

    // The next turn: it is there, nothing to do.
    const again = pullClaudeSession({ sid, destination: p, cwd, sources: [b, p] });
    assert.equal(again.status, "present");
    assert.deepEqual(again.old, []);
    // A session that exists nowhere.
    assert.equal(pullClaudeSession({ sid: "missing-0000", destination: p, cwd, sources: [b, p] }).status, "missing");
    // No id that would be a path.
    assert.equal(pullClaudeSession({ sid: "../x", destination: p, cwd, sources: [b, p] }).status, "missing");
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("(1c) pullClaudeSession: an older copy AT the target is overwritten, never removed as old; back to B works the same", () => {
  const r = disposable("session-claude-target");
  try {
    const b = path.join(r, "b", ".claude");
    const p = path.join(r, "p", ".claude");
    const cwd = path.join(r, "ws");
    fs.mkdirSync(cwd, { recursive: true });
    const sid = "sid-back";
    const inP = path.join(p, "projects", sessionSlug(real(cwd)), `${sid}.jsonl`);
    const inB = path.join(b, "projects", sessionSlug(real(cwd)), `${sid}.jsonl`);
    write(inB, "old\n", 1_700_000_000);
    write(inP, "old\nnew\n", 1_800_000_000);
    // The project was left (project → no project): the newest (in the project) moves to B, over the old one there.
    const turn = pullClaudeSession({ sid, destination: b, cwd, sources: [b, p] });
    assert.equal(turn.status, "copied");
    assert.equal(fs.readFileSync(inB, "utf8"), "old\nnew\n");
    assert.deepEqual(turn.old, [inP], "only the copy in the project is old — never the target itself");
    assert.equal(removeCopies(turn.old), 1);
    assert.ok(fs.existsSync(inB) && !fs.existsSync(inP));
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("(1d) pullCodexRollout: the same relative path under sessions/, found via the file", () => {
  const r = disposable("session-codex");
  try {
    const b = path.join(r, "b", ".codex");
    const p = path.join(r, "p", ".codex");
    const id = "01a0e4c0-282d-7630-b5d9-0aef127f8a35";
    const rel = path.join("sessions", "2026", "09", "27", `rollout-2026-09-27T21-23-13-${id}.jsonl`);
    write(path.join(b, rel), "{\"a\":1}\n", 1_800_000_000);
    write(path.join(b, "sessions", "2026", "09", "27", "rollout-2026-09-27T21-00-00-other-thread.jsonl"), "x\n");
    const turn = pullCodexRollout({ threadId: id, destination: p, sources: [b, p] });
    assert.equal(turn.status, "copied");
    assert.equal(turn.target, path.join(p, rel));
    assert.equal(fs.readFileSync(path.join(p, rel), "utf8"), "{\"a\":1}\n");
    assert.deepEqual(turn.old, [path.join(b, rel)]);
    assert.ok(!fs.existsSync(path.join(p, "sessions", "2026", "09", "27", "rollout-2026-09-27T21-00-00-other-thread.jsonl")), "only this thread");
    assert.equal(pullCodexRollout({ threadId: id, destination: p, sources: [b, p] }).status, "present");
    assert.equal(pullCodexRollout({ threadId: "exists-not", destination: p, sources: [b, p] }).status, "missing");
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

// ── (2)–(4) Main seam via the fake docker ────────────────────────────────────────────────────────────────────────────

// The project's container carries the environment the setup gives it (projectbox): CLAUDE_CONFIG_DIR and CODEX_HOME in the CLI home
// of its runtime folder.
function projectContainer(fd, projectId) {
  const name = `cbase-p-${projectId}`;
  execFileSync(fd.bin, ["run", "-d", "--name", name, "-e", `CLAUDE_CONFIG_DIR=${projectClaudeDir(projectId)}`, "-e", `CODEX_HOME=${projectCodexDir(projectId)}`, "cbase-projectbox:test"],
    { env: { ...process.env, ...fd.env } });
  return name;
}
// B: ops marker, fake docker, B's CLI homes in the test's throwaway folder (the fakes write sessions there).
const bEnvironment = (fd, root) => ({
  ...OPS, CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200",
  CLAUDE_CONFIG_DIR: path.join(root, "b-home", ".claude"), CODEX_HOME: path.join(root, "b-home", ".codex"),
});
async function convertedProject(ctx, fd, chatId) {
  const projPath = path.join(ctx.ws.path, "till");
  fs.mkdirSync(projPath, { recursive: true });
  const p = await ctx.projectWithoutInstance({ name: "Till", path: projPath });
  const name = projectContainer(fd, p.id);
  await json(`${ctx.base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
  return { p, name, convert: () => store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: name }) };
}
const SID = "s-relocation-main";
const MAIN = `
  if (text.includes("SENDE:")) {
    const agentId = /SENDE:([A-Za-z0-9-]+)/.exec(text)[1];
    const m = await mcpCall("cbase_agent_send", { agentId, message: "further" });
    fs.appendFileSync(path.join(LOCATION, "sent.jsonl"), JSON.stringify({ t: textOf(m) }) + "\\n");
  }
  fs.appendFileSync(path.join(LOCATION, "main.jsonl"), JSON.stringify({ text, resume: arg("--resume"), ccd: process.env.CLAUDE_CONFIG_DIR || "" }) + "\\n");
  finished();
  say({ type: "result", result: "ok", session_id: arg("--resume") || ${JSON.stringify(SID)} });`;
const SUB = `
    fs.appendFileSync(path.join(LOCATION, "sub.jsonl"), JSON.stringify({ text, resume: arg("--resume"), ccd: process.env.CLAUDE_CONFIG_DIR || "" }) + "\\n");
    finished();
    say({ type: "result", result: "Finding continued", session_id: arg("--resume") || "sub-new" });`;
const claude = fakeClaude({ main: MAIN, sub: SUB });
const rows = (root, file) => readJsonl(path.join(root, file));
const mainWith = (root, part) => rows(root, "main.jsonl").filter((z) => z.text.includes(part));
const send = (base, chatId, text) => json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });

test("(2) main seam Claude: session in B, project moved => resume from the project home, no resume_failed_retrying; both copies missing => hint row", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat, root, ws } = ctx;
      await withEnvironment(bEnvironment(fd, root), async () => {
        const { p, convert } = await convertedProject(ctx, fd, chat.id);
        const bFile = path.join(root, "b-home", ".claude", "projects", sessionSlug(real(ws.path)), `${SID}.jsonl`);

        await send(base, chat.id, "ONE");
        await waitForTruthy(() => mainWith(root, "ONE").length, "turn ONE");
        await ctx.waitForQuiet();
        assert.ok(fs.existsSync(bFile), "turn ONE ran in B and wrote its session there");
        assert.equal(store.getChat(chat.id).claudeSessionId, SID);
        // A large tool result of turn ONE (the CLI stores it under <sid>/tool-results/ and names the path).
        const bFolder = path.join(path.dirname(bFile), SID);
        write(path.join(bFolder, "tool-results", "t1.txt"), "large output");

        convert();
        await send(base, chat.id, "TWO");
        await waitForTruthy(() => mainWith(root, "TWO").length, "turn TWO");
        await ctx.waitForQuiet();
        const two = mainWith(root, "TWO");
        assert.equal(two.length, 1, "exactly one run — no retry without resume");
        assert.equal(two[0].resume, SID, "resume of the session");
        assert.equal(two[0].ccd, projectClaudeDir(p.id), "in the project's home");
        const pFile = path.join(projectClaudeDir(p.id), "projects", sessionSlug(real(p.path)), `${SID}.jsonl`);
        assert.ok(fs.existsSync(pFile), "the session lies in the slug of the project folder");
        assert.ok(!fs.existsSync(bFile), "after the confirmed turn the copy in B falls");
        // The history names t1.txt under the old folder — the relocation turn carries the hint old → new.
        const pFolder = path.join(path.dirname(pFile), SID);
        assert.equal(fs.readFileSync(path.join(pFolder, "tool-results", "t1.txt"), "utf8"), "large output", "<sid>/ moved along");
        assert.ok(two[0].text.includes("cbase-hint") && two[0].text.includes(`- ${bFolder}/ → ${pFolder}/`), `the hint names the old and the new session folder: ${two[0].text}`);
        assert.ok(!fs.existsSync(bFolder), "the old folder falls with the confirmation");
        const log = await json(`${base}/api/chats/${chat.id}/log`);
        assert.ok(!log.some((m) => m.role === "hint"), "no hint — nothing was lost");

        // Both copies gone (like a rollback without a way back): the turn runs anyway, visibly without memory.
        fs.rmSync(pFile);
        await send(base, chat.id, "THREE");
        await waitForTruthy(() => mainWith(root, "THREE").length >= 1 && mainWith(root, "THREE").some((z) => !z.resume), "turn THREE without resume");
        await ctx.waitForQuiet();
        const log3 = await json(`${base}/api/chats/${chat.id}/log`);
        // The retry ends cleanly because the server closes its stdin (exit 0 => one meta row per turn: ONE, TWO, THREE). If the
        // finally of the failed run removed the child from `runChildren`, stdin would stay open and only the fake docker's
        // emergency brake would end the retry after 120 s with exit 9 (run_error, no meta row) — the real CLI would run forever.
        assert.equal(log3.filter((m) => m.role === "meta").length, 3, "each of the three turns ends cleanly, the retry too");
        const hint = log3.filter((m) => m.role === "hint");
        assert.equal(hint.length, 1, "exactly one hint row");
        assert.match(hint[0].text, new RegExp(`Sitzung ${SID} nicht gefunden, der Chat beginnt ohne Gedächtnis`));
      });
    }, { claude });
  } finally {
    fd.cleanUp();
  }
});

test("(3) subagent: a resumed subagent with a session in B finds it in the project container", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat, root } = ctx;
      await withEnvironment(bEnvironment(fd, root), async () => {
        const { p, convert } = await convertedProject(ctx, fd, chat.id);
        convert();
        // A subagent that worked in B (its session lies in B's home) and moved with the project (its record carries the project's
        // instance).
        const subSid = "sub-relocation-0001";
        const bFile = path.join(root, "b-home", ".claude", "projects", sessionSlug(real(ctx.ws.path)), `${subSid}.jsonl`);
        write(bFile, JSON.stringify({ type: "result", sessionId: subSid }) + "\n");
        const bFolder = path.join(path.dirname(bFile), subSid);
        write(path.join(bFolder, "tool-results", "t1.txt"), "large output of the subagent");
        store.rememberSubagent(chat.id, { agentId: "arelocate000-1", name: "reloc", provider: "claude", model: HAIKU, sessionId: subSid,
          state: "finished", status: "completed", cwd: p.path, instance: `${p.id}/main` });

        await send(base, chat.id, "SENDE:arelocate000-1");
        // The wait is for the completion notice (it wakes the main agent whether the subagent succeeded or failed) — not for its
        // row: without the relocation it dies before the body ("No conversation found"), and the test would hang instead of turning red.
        await waitForTruthy(() => rows(root, "main.jsonl").some((z) => z.text.includes("<task-notification>")), "completion notice of the subagent");
        await ctx.waitForQuiet();
        const [s] = rows(root, "sub.jsonl");
        assert.ok(s, "the subagent ran — without the relocation it ended with \"No conversation found\" before doing anything");
        assert.equal(s.resume, subSid, "resume of its session");
        assert.equal(s.ccd, projectClaudeDir(p.id), "in the project container");
        const pFile = path.join(projectClaudeDir(p.id), "projects", sessionSlug(real(p.path)), `${subSid}.jsonl`);
        assert.ok(fs.existsSync(pFile));
        // The subagent's successful turn confirms the relocation — the old copies in B fall.
        assert.ok(!fs.existsSync(bFile) && !fs.existsSync(bFolder), "after the subagent's confirmed turn `.jsonl` and <sid>/ in B fall");
        // The subagent learns where its session folder now lies (fenced prefix on ITS input).
        const pFolder = path.join(path.dirname(pFile), subSid);
        assert.ok(s.text.includes("cbase-hint") && s.text.includes(`- ${bFolder}/ → ${pFolder}/`), `the hint to the subagent: ${s.text}`);
        assert.ok(s.text.includes("further"), "the message itself follows the hint");
      });
    }, { claude });
  } finally {
    fd.cleanUp();
  }
});

test("(4) Codex: the rollout moves under the same relative path into the project's home, the resume finds it", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws, root } = ctx;
      await withEnvironment(bEnvironment(fd, root), async () => {
        const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "codex", model: "gpt-5.6-sol", permissionMode: "bypassPermissions" }) });
        await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Codex" }) });
        const { p, convert } = await convertedProject(ctx, fd, chat.id);
        const responses = async () => (await json(`${base}/api/chats/${chat.id}/log`)).filter((m) => m.role === "assistant").map((m) => m.text);

        await send(base, chat.id, "ONE");
        await waitForTruthy(async () => (await responses()).length >= 1, "Codex ONE");
        await ctx.waitForQuiet();
        const rolloutsIn = (home) => { const out = []; const go = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const x = path.join(d, e.name); if (e.isDirectory()) go(x); else out.push(path.relative(home, x)); } }; go(path.join(home, "sessions")); return out; };
        const inB = rolloutsIn(path.join(root, "b-home", ".codex"));
        assert.equal(inB.length, 1, "turn ONE wrote its rollout in B");

        convert();
        await send(base, chat.id, "TWO");
        await waitForTruthy(async () => (await responses()).length >= 2, "Codex TWO");
        await ctx.waitForQuiet();
        const [, two] = await responses();
        assert.match(two, /\(resume codex-thread\)/, "resume of the thread — without the relocation \"no rollout found\" and a run without resume");
        assert.deepEqual(rolloutsIn(projectCodexDir(p.id)), inB, "the same relative path");
        assert.deepEqual(rolloutsIn(path.join(root, "b-home", ".codex")), [], "after the confirmed turn the copy in B falls");
      });
    }, { claude, codex: fakeCodex({ text: "Codex answer" }) });
  } finally {
    fd.cleanUp();
  }
});

// ── (5) Rollout readers ────────────────────────────────────────────────────────────────────────────────────────────────

test("(5) the three rollout readers (token state, usage, limit snapshot) find the rollout in a project's Codex home (codexSessionRoots with the source from server.js)", async () => {
  const r = disposable("session-reader");
  try {
    await withEnvironment({ HOME: path.join(r, "home"), CODEX_HOME: undefined }, async () => {
      const projHome = path.join(r, "projects", "p1", "home", ".codex");
      const id = "tid-reader-0001";
      write(path.join(projHome, "sessions", "2026", "09", "28", `rollout-2026-09-28T10-00-00-${id}.jsonl`),
        JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 11, output_tokens: 3, cached_input_tokens: 5 }, total_token_usage: { input_tokens: 40, output_tokens: 9, cached_input_tokens: 5 }, model_context_window: 872000 } } }) + "\n"
        // The limit state (runs/limit-gate.js via codexRateLimitSnapshot/codexUsage, /api/usage/codex via codexUsage).
        + JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_at: 4102444800 }, rate_limit_reached_type: "primary", plan_type: "pro" } } }) + "\n");
      setCodexHomeSource(null);
      assert.equal(readCodexTokenSnapshot(id), null, "without a source (the old state): not found");
      assert.equal(codexRateLimitSnapshot({ threadId: id }), null, "without a source: no limit snapshot");
      assert.equal(codexUsage().connected, false, "without a source: no usage");
      setCodexHomeSource(() => [projHome]);
      const snap = readCodexTokenSnapshot(id);
      assert.ok(snap, "with the source: found");
      assert.deepEqual(snap.last, { input: 11, output: 3, cached: 5 });
      assert.equal(snap.contextWindow, 872000);
      assert.equal(codexRateLimitSnapshot({ threadId: id })?.rate_limit_reached_type, "primary", "the thread's limit snapshot");
      const usage = codexUsage();
      assert.equal(usage.connected, true);
      assert.equal(usage.primary?.usedPercent, 42, "the usage from the project's rollout");
      setCodexHomeSource(() => { throw new Error("broken"); });
      assert.equal(readCodexTokenSnapshot(id), null, "a throwing source does not break the reader");
      assert.equal(codexUsage().connected, false, "… nor the usage");
    });
  } finally {
    setCodexHomeSource(null);
    fs.rmSync(r, { recursive: true, force: true });
  }
});

// ── (6) No file access without an instance ───────────────────────────────────────────────────────────────────────────

test("(6) without an instance and without any instance row: sessionForStart reads no file; with a row anywhere it pulls to B", async () => {
  await withAgentsServer(async ({ root, ws }) => {
    const b = path.join(root, "b-home", ".claude");
    await withEnvironment({ CLAUDE_CONFIG_DIR: b }, async () => {
      const counter = ["readdirSync", "statSync", "existsSync", "copyFileSync", "lstatSync"].map((n) => mock.method(fs, n));
      const accesses = () => counter.reduce((s, m) => s + m.mock.callCount(), 0);
      try {
        assert.equal(store.projectInstances().length, 0);
        assert.equal(sessionForStart({ sid: "s-g2", provider: "claude", instance: null, cwd: ws.path }), null);
        assert.equal(sessionForStart({ sid: "s-g2", provider: "codex", instance: null, cwd: ws.path }), null);
        assert.equal(sessionForStart({ sid: "s-g2", provider: "openrouter", instance: { projectId: "p1" }, cwd: ws.path }), null, "only claude and codex");
        assert.equal(accesses(), 0, "no file access without an instance row");
      } finally { for (const m of counter) m.mock.restore(); }

      // With a row (of another project): the chat without an instance fetches its session back from a project home to B
      // (project → no project).
      const p = { id: "pstore" };
      store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: "cbase-p-pstore" });
      write(path.join(projectClaudeDir(p.id), "projects", "-somewhere", "s-back.jsonl"), "x\n");
      const turn = sessionForStart({ sid: "s-back", provider: "claude", instance: null, cwd: ws.path });
      assert.equal(turn.status, "copied");
      assert.equal(turn.target, path.join(b, "projects", sessionSlug(real(ws.path)), "s-back.jsonl"));
    });
  }, { claude });
});

// ── (7) CLI home ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("(7a) createCliHome: three folders, .claude.json once and only with oauthAccount/userID/hasCompletedOnboarding (0600); without ops it throws", async () => {
  await withData(async (data) => {
    const home = path.join(data, "user");
    write(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@b" }, userID: "u1", hasCompletedOnboarding: true, projects: { "/w": {} }, numStartups: 9 }));
    await withEnvironment({ CBASE_CONTAINER: undefined, CBASE_DIND: undefined, CLAUDE_CONFIG_DIR: undefined }, async () => {
      assert.throws(() => createCliHome("p1", { home }), (e) => e.code === "NO_OPS" && e.status === 404);
      assert.ok(!fs.existsSync(path.join(data, "projects")), "without ops nothing is created");
    });
    await withEnvironment({ ...OPS, CLAUDE_CONFIG_DIR: undefined }, async () => {
      const r = createCliHome("p1", { home });
      const h = path.join(data, "projects", "p1", "home");
      assert.equal(r.home, h);
      for (const n of [".claude", ".codex", ".local"]) assert.ok(fs.statSync(path.join(h, n)).isDirectory(), n);
      const cj = path.join(h, ".claude", ".claude.json");
      assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cj, "utf8"))).sort(), [...CLAUDE_JSON_FIELDS].sort());
      assert.equal(fs.statSync(cj).mode & 0o777, 0o600);
      fs.writeFileSync(cj, "{\"own\":1}");
      assert.equal(createCliHome("p1", { home }).reason, "existing");
      assert.equal(fs.readFileSync(cj, "utf8"), "{\"own\":1}", "a second call overwrites nothing");
    });
  });
});

test("(7b) Codex trust: the level of the workspace entry, appended in place (same inode, rest byte-equal), idempotent", async () => {
  const r = disposable("session-trust");
  try {
    const cfg = path.join(r, "config.toml");
    const prior = 'model = "gpt-5.6-sol"\n\n[projects."/home/agent/workspaces/geo"]\ntrust_level = "untrusted"\n\n[projects."/home/agent/workspaces/other"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(cfg, prior);
    const inode = fs.statSync(cfg).ino;
    await withEnvironment({ CBASE_CONTAINER: undefined }, async () => {
      assert.throws(() => enterCodexTrust({ configPath: cfg, wsPath: "/home/agent/workspaces/geo", projectPath: "/home/agent/workspaces/geo/till" }), (e) => e.code === "NO_OPS");
    });
    await withEnvironment(OPS, async () => {
      const a = { configPath: cfg, wsPath: "/home/agent/workspaces/geo", projectPath: "/home/agent/workspaces/geo/till" };
      assert.deepEqual(enterCodexTrust(a), { status: "entered", stage: "untrusted" });
      assert.deepEqual(enterCodexTrust(a), { status: "present", stage: "untrusted" });
      const after = fs.readFileSync(cfg, "utf8");
      assert.equal(after.slice(0, prior.length), prior, "the rest is byte-equal");
      assert.equal(after.slice(prior.length), '\n[projects."/home/agent/workspaces/geo/till"]\ntrust_level = "untrusted"\n');
      assert.equal((after.match(/geo\/till/g) || []).length, 1, "twice => one entry");
      assert.equal(fs.statSync(cfg).ino, inode, "the same inode — the bind in the project container sees the change");
      assert.deepEqual(enterCodexTrust({ ...a, configPath: path.join(r, "missing.toml") }), { status: "no-file" });
    });
    // Pure: without a workspace entry "trusted", without a final line end a break before it, quotation marks escaped.
    assert.deepEqual(codexTrustText('x = 1', { wsPath: "/w", projectPath: '/w/a"b' }), { attachment: '\n\n[projects."/w/a\\"b"]\ntrust_level = "trusted"\n', stage: "trusted" });
    assert.equal(codexTrustText("[projects.'/w/p']\ntrust_level = \"trusted\"\n", { wsPath: "/w", projectPath: "/w/p" }).attachment, null, "recognized in single quotes too");
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("(7c) copyLocal: the venv link stays a link; state/ and share/<x> only into the assigned project, share/uv into every one", async () => {
  await withData(async (data) => {
    const home = path.join(data, "user");
    const local = path.join(home, ".local");
    write(path.join(local, "share", "uv", "tools", "orbit", "bin", "orbit"), "#!/bin/sh\n");
    fs.mkdirSync(path.join(local, "bin"), { recursive: true });
    fs.symlinkSync(path.join(local, "share", "uv", "tools", "orbit", "bin", "orbit"), path.join(local, "bin", "orbit"));
    write(path.join(local, "state", "orbit-mcp", "checkLog.jsonl"), "secret-p1\n");
    write(path.join(local, "share", "foreign", "x"), "foreign\n");
    // Two projects; only the first points with its .env at state/orbit-mcp.
    const p1 = path.join(data, "ws", "orbit");
    const p2 = path.join(data, "ws", "till");
    write(path.join(p1, ".env"), `CHECK_LOG_PATH=${path.join(local, "state", "orbit-mcp", "checkLog.jsonl")}\n`);
    write(path.join(p2, ".env"), "PORT=3000\n");
    const assignment = new Map();
    for (const [id, filePath] of [["p1", p1], ["p2", p2]]) for (const v of localReferences(filePath, { home })) assignment.set(v, [...(assignment.get(v) || []), id]);
    assert.deepEqual([...assignment.keys()], ["state/orbit-mcp"]);

    await withEnvironment(OPS, async () => {
      const b1 = copyLocal("p1", assignment, { home });
      const b2 = copyLocal("p2", assignment, { home });
      const target = (id, rel) => path.join(data, "projects", id, "home", ".local", rel);
      for (const id of ["p1", "p2"]) {
        const link = target(id, "bin/orbit");
        assert.ok(fs.lstatSync(link).isSymbolicLink(), `${id}: bin/orbit stayed a link (cp -a)`);
        assert.equal(fs.readlinkSync(link), path.join(local, "share", "uv", "tools", "orbit", "bin", "orbit"), "the target unchanged (absolute, mounted at the same path)");
        assert.ok(fs.existsSync(target(id, "share/uv/tools/orbit/bin/orbit")), `${id}: share/uv`);
        assert.ok(!fs.existsSync(target(id, "share/foreign")), `${id}: share/foreign not copied without an assignment`);
      }
      assert.equal(fs.readFileSync(target("p1", "state/orbit-mcp/checkLog.jsonl"), "utf8"), "secret-p1\n");
      assert.ok(!fs.existsSync(target("p2", "state")), "p2 does not carry p1's state");
      assert.deepEqual(b1.withoutAssignment, ["share/foreign"]);
      assert.deepEqual(b2.withoutAssignment, ["share/foreign"]);
      assert.deepEqual(b2.otherProject, ["state/orbit-mcp"]);
      assert.deepEqual(copyLocal("p1", assignment, { home }).copied, [], "a second run overwrites nothing");
    });
    await withEnvironment({ CBASE_CONTAINER: undefined }, async () => {
      assert.throws(() => copyLocal("p3", assignment, { home }), (e) => e.code === "NO_OPS");
    });
  });
});

// ── (8) The relocation of a project ──────────────────────────────────────────────────────────────────────────────────

test("(8) pullSessionsOfTheProject: chat and subagents of a project move in one go into the project's home", async () => {
  await withAgentsServer(async ({ base, chat, root, ws }) => {
    const b = path.join(root, "b-home", ".claude");
    await withEnvironment({ CLAUDE_CONFIG_DIR: b }, async () => {
      const projPath = path.join(ws.path, "till");
      fs.mkdirSync(projPath);
      const p = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Till", path: projPath }) });
      await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
      store.updateChat(chat.id, { claudeSessionId: "s-chat-8" });
      store.rememberSubagent(chat.id, { agentId: "a8", name: "eight", provider: "claude", model: HAIKU, sessionId: "s-sub-8", state: "finished", status: "completed", cwd: ws.path });
      write(path.join(b, "projects", sessionSlug(real(ws.path)), "s-chat-8.jsonl"), "c\n");
      write(path.join(b, "projects", sessionSlug(real(ws.path)), "s-sub-8.jsonl"), "s\n");
      const report = pullSessionsOfTheProject(p.id, { cwdFor: () => projPath });
      assert.deepEqual(report.map((z) => [z.agentId, z.status]), [[null, "copied"], ["a8", "copied"]]);
      assert.ok(fs.existsSync(path.join(projectClaudeDir(p.id), "projects", sessionSlug(real(projPath)), "s-chat-8.jsonl")), "the chat in the slug of the new working folder");
      assert.ok(fs.existsSync(path.join(projectClaudeDir(p.id), "projects", sessionSlug(real(ws.path)), "s-sub-8.jsonl")), "the subagent in the slug of ITS working folder");
      assert.ok(fs.existsSync(path.join(b, "projects", sessionSlug(real(ws.path)), "s-chat-8.jsonl")), "the old ones stay until the confirmation");
    });
  }, { claude });
});

// ── (9) Back to B when deleting a project ────────────────────────────────────────────────────────────────────────────────
// fetchSessionsBack: EVERY session of a home (per id, not per chat) — the newest wins; Claude into the slug of the copy that already
// lies at the target (it is overwritten, no second one next to it), otherwise into that of the source, with `<sid>/`; a newer one at
// the target stays ("present"); Codex under the same relative path; an empty or missing home is nothing. The path via the routes
// (without/with purge, workspace not): see the project-box delete test.
test("(9) fetchSessionsBack: every session of the project home to B — newest wins, slug of the copy at the target, otherwise the source's", async () => {
  const { fetchSessionsBack } = await import("../electron/server/runs/session-transfer.js");
  const from = disposable("back-of");
  const after = disposable("back-after");
  try {
    const pc = path.join(from, ".claude", "projects", "-inContainer");
    // s-new: only in the project, with <sid>/ — moves into the source's slug.
    write(path.join(pc, "s-new.jsonl"), "new\n", 2000);
    write(path.join(pc, "s-new", "tool-results", "a.txt"), "a");
    // s-old-in-b: in B an OLDER copy under the workspace's slug — the newer one from the project replaces EXACTLY it.
    write(path.join(pc, "s-old-in-b.jsonl"), "project\n", 2000);
    write(path.join(after, ".claude", "projects", "-workspace", "s-old-in-b.jsonl"), "b\n", 1000);
    // s-new-in-b: NEWER in B — stays as it is.
    write(path.join(pc, "s-new-in-b.jsonl"), "project\n", 1000);
    write(path.join(after, ".claude", "projects", "-workspace", "s-new-in-b.jsonl"), "b newer\n", 3000);
    // Codex: the same relative path.
    const rel = path.join("sessions", "2026", "09", "29", "rollout-2026-09-29T10-00-00-t-back.jsonl");
    write(path.join(from, ".codex", rel), "r\n", 2000);

    const claude = fetchSessionsBack({ kind: "claude", from: path.join(from, ".claude"), destination: path.join(after, ".claude") });
    assert.deepEqual(claude.map((z) => [z.sid, z.status]), [["s-new", "copied"], ["s-new-in-b", "present"], ["s-old-in-b", "copied"]]);
    const b = (slug, name) => path.join(after, ".claude", "projects", slug, name);
    assert.equal(fs.readFileSync(b("-inContainer", "s-new.jsonl"), "utf8"), "new\n");
    assert.equal(fs.readFileSync(b("-inContainer", path.join("s-new", "tool-results", "a.txt")), "utf8"), "a", "the folder <sid>/ did not move along");
    assert.equal(fs.readFileSync(b("-workspace", "s-old-in-b.jsonl"), "utf8"), "project\n", "the older copy in B was not replaced");
    assert.equal(fs.existsSync(b("-inContainer", "s-old-in-b.jsonl")), false, "a second copy next to the one in B — the CLI would take the one in its cwd's slug");
    assert.equal(fs.readFileSync(b("-workspace", "s-new-in-b.jsonl"), "utf8"), "b newer\n", "a newer copy in B was overwritten");
    assert.ok(fs.existsSync(path.join(pc, "s-new.jsonl")), "the source stays");

    const codex = fetchSessionsBack({ kind: "codex", from: path.join(from, ".codex"), destination: path.join(after, ".codex") });
    assert.deepEqual(codex.map((z) => [z.sid, z.status]), [["t-back", "copied"]]);
    assert.equal(fs.readFileSync(path.join(after, ".codex", rel), "utf8"), "r\n");
    // Once more: everything "present", nothing doubled.
    assert.deepEqual(fetchSessionsBack({ kind: "codex", from: path.join(from, ".codex"), destination: path.join(after, ".codex") }).map((z) => z.status), ["present"]);
    // A missing home is nothing.
    assert.deepEqual(fetchSessionsBack({ kind: "claude", from: path.join(from, "exists-not"), destination: path.join(after, ".claude") }), []);
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(after, { recursive: true, force: true });
  }
});
