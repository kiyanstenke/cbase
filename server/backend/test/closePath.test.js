// The ONE closing path of chat work (chats/erase.js).
//
// Every path that deletes a chat clears the SAME list: shells of the terminal bar, scratch, MCP file, the output
// folder of the subagents (`<id>.agents`), the MCP files per subagent (`<id>.agent-<n>.mcp.json`), attachments and
// browser profile, its silent hints (`chat_hints`), the stock of its subagents (`subagents` with
// `subagent_history`), the graph starts of graph workflows (`graph_starts`) - and closes its channels. Measured on
// the routes: chat, folder permanently (from the archive), workspace. What belongs to ANOTHER chat stays (a
// neighbor with a prefix-like name). Plus the source-text guard: no store delete call that takes chats goes past
// this path.
//
// Counter-tests: without the lines for `.agents` and `.agent-*.mcp.json` the test is red at the first path; without
// the line for the output location (`outputs/<id>`) in chats/erase.js tidyUp likewise; without
// `store.deleteSubagents(id)` it is red at the first path ("the subagent stock is gone"); without
// `store.deleteGraphStartsFor(id)` red ("the graph starts are gone"); a delete route that bypasses the closing path
// turns the terminal check ("terminal of the chat dead") and the source guard red.
//
// CLI sessions: every path takes the CLI sessions of the chat and its subagent with it - Claude
// `projects/<slug>/<sid>.jsonl` with `<sid>/`, Codex rollout - in B (CLAUDE_CONFIG_DIR/CODEX_HOME of the test) AND
// in the home of a runtime folder `<data>/projects/<pid>/home` (without an instance row); a foreign rollout whose
// name merely ENDS in the id, and everything of the neighbor, stay. The second test holds the exceptions: a fork
// carries the session of its original (fork deleted => stays, original afterwards => gone), likewise a subagent of
// another chat; symlinks in place of `<sid>.jsonl`/`<sid>/` fall themselves, their target stays, a slug symlink is
// not entered; the empty slug of a worktree agent falls, a shared empty one stays.
// Counter-tests: chats/erase.js without the session lines => both session tests red ("chat: session gone ...",
// "original deleted: ..."); fork exception off => the second red; without collectSubagents => both red; sessions only
// of the passed chats (not of every chat on the workspace path) => the first red ("workspace: ..."); Codex found by
// suffix instead of id => the first red (the foreign rollout fell); without the worktree slug => the second red; only
// the home of B => both red (the project home kept the session).
// EARLIER sessions fall too - `/clear`, `/compact`, provider switch of the chat and of the global provider,
// restart of a subagent overwrite the carrying column; since then `previous_sessions` (two triggers in
// store/subagents.js) keeps the old id. The third test drives these paths through the real routes; in the first,
// each delete path additionally carries an earlier session of the chat and of its subagent (the neighbor too, they
// stay).
// Counter-tests: store/subagents.js, chats/sessions.js, chats/erase.js without the earlier-session handling => the
// first and third red ("chat: session gone" at the earlier one, "before /compact: session gone"); sabotaged singly,
// each makes both red: trigger on chats off, trigger on subagenten off (WHEN 0), chatSessions without earlier,
// collectSubagents without earlier, collectChat with only the first id, the rows do not fall (deletePreviousSessions off).
//
// Outer loop: every path takes the chat's own outer-loop agents with their rows, plus runs, notes and activation of
// a workspace agent on the chat and the CLI sessions of both runs (chats/sessions.js via
// store.outerLoopSessionsOf) - the workspace agent itself stays (except on the workspace path), everything of the
// neighbor too. Counter-tests: without `store.deleteOuterLoopChat(id)` in chats/erase.js tidyUp => the first test
// red at the first path ("outer loop: the chat's own agent is gone"); without the outer-loop session rows in
// chats/sessions.js sessionsBeforeDeletion => red at the session of the run ("chat: session gone").
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 node --test server/backend/test/closePath.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withServer, makeWorkspace, makeChat, json, ok, waitForIdle } from "./server-harness.mjs";
import * as store from "../electron/server/store.js";
import { db as rawDb } from "../electron/server/store/db.js";
import { compacting, running } from "../electron/server/runs/state.js";
import { sessionSlug } from "../electron/server/runs/session-transfer.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "electron", "server");

// What a chat leaves outside its rows - per entry a path that must be gone after the delete.
function seedBacklogs(dataDir, id) {
  const scratch = path.join(dataDir, "scratch");
  const files = {
    "Scratch": path.join(scratch, id, "note.txt"),
    "MCP-File": path.join(scratch, `${id}.mcp.json`),
    "Subagent output": path.join(scratch, `${id}.agents`, "agent-1.md"),
    "MCP-File Subagent 1": path.join(scratch, `${id}.agent-1.mcp.json`),
    "MCP-File Subagent 2": path.join(scratch, `${id}.agent-2.mcp.json`),
    "Attachments": path.join(dataDir, "attachments", id, "image.png"),
    // The output location (runs/outputs.js) - outputs of the subagents and scripts of the dynamic workflows.
    "Output location: Subagent": path.join(dataDir, "outputs", id, "agents", "agent-1.output"),
    "Output location: Workflow script": path.join(dataDir, "outputs", id, "workflows", "script.js"),
    "Browser profile": path.join(dataDir, "playwright-profiles", `chat-${id}`, "Preferences"),
  };
  for (const p of Object.values(files)) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "x"); }
  return files;
}

// A graph workflow start (store/graph-starts.js) - earmarked, without a run.
function seedGraphStart(chatId) {
  store.createGraphStart({ id: `gs-${crypto.randomUUID()}`, chatId, workflowId: "wf-close", workflowName: "Closing",
    shortName: "close", status: "earmarked" });
}

// An orphaned subagent in the stock (store/subagents.js) - with one log row. Its session is one per chat (it falls
// with the chat; a shared one would stay - the fork exception is held by the "sessions" test below). It ran before
// under ANOTHER session (a restart without resume stores the same record with a new session,
// providers/agent-runtime.js) - the earlier one falls with the chat too.
const subSession = (chatId) => `sub-${chatId}`;
const subPrevious = (chatId) => `subearlier-${chatId}`;
function seedSubagent(chatId) {
  store.rememberSubagent(chatId, { agentId: "averw0000-1", name: "part", provider: "claude", model: "", sessionId: subPrevious(chatId), state: "running" });
  store.rememberSubagent(chatId, { agentId: "averw0000-1", name: "part", provider: "claude", model: "", sessionId: subSession(chatId), state: "orphaned" });
  store.subagentRow(chatId, "averw0000-1", { role: "user", text: "Job" });
}

// The CLI homes of the test - B via CLAUDE_CONFIG_DIR/CODEX_HOME (read on every call) and the home of a runtime folder
// `<data>/projects/<pid>/home` (without an instance row: so it stays after a delete without purge - the closing path
// searches there anyway). `back()` in the finally restores the environment.
function setHomes(root, dataDir) {
  const prior = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  const b = path.join(root, "b-home");
  const p = path.join(dataDir, "projects", "p-n55", "home");
  process.env.CLAUDE_CONFIG_DIR = path.join(b, ".claude");
  process.env.CODEX_HOME = path.join(b, ".codex");
  return {
    homes: { claude: [path.join(b, ".claude"), path.join(p, ".claude")], codex: [path.join(b, ".codex"), path.join(p, ".codex")] },
    back: () => { for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } },
  };
}

// A session in EVERY home: Claude `projects/<slug>/<sid>.jsonl` with `<sid>/tool-results/`, Codex the rollout. -> the paths.
function seedSession(homes, sid, slug = "-ws-slug") {
  const paths = [];
  for (const h of homes.claude) {
    const folder = path.join(h, "projects", slug);
    fs.mkdirSync(path.join(folder, sid, "tool-results"), { recursive: true });
    fs.writeFileSync(path.join(folder, `${sid}.jsonl`), "{}\n");
    fs.writeFileSync(path.join(folder, sid, "tool-results", "t1.txt"), "x");
    paths.push(path.join(folder, `${sid}.jsonl`), path.join(folder, sid));
  }
  for (const h of homes.codex) {
    const p = path.join(h, "sessions", "2026", "10", "02", `rollout-2026-10-02T08-00-00-${sid}.jsonl`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{}\n");
    paths.push(p);
  }
  return paths;
}
const isPresent = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

// Seed the sessions of a chat and its subagent - plus a FOREIGN Codex rollout whose name merely ENDS in the id
// (thread `foreign-<sid>`): nothing may hit it, the id is searched, never a pattern. Plus an EARLIER session each of
// the chat (the column was cleared like by `/clear`, then set again - store/subagents.js `previous_sessions`) and of
// its subagent. -> { way: [...], stays: [...], sids: [carried, earlier] }
function seedChatSessions(homes, chatId) {
  const previous = crypto.randomUUID();
  store.updateChat(chatId, { claudeSessionId: previous });
  store.updateChat(chatId, { claudeSessionId: null });
  const sid = crypto.randomUUID();
  store.updateChat(chatId, { claudeSessionId: sid });
  const foreign = path.join(homes.codex[1], "sessions", "2026", "10", "02", `rollout-2026-10-02T09-00-00-foreign-${sid}.jsonl`);
  const way = [...seedSession(homes, sid), ...seedSession(homes, previous), ...seedSession(homes, subSession(chatId), "-ws-slug-agent"),
    ...seedSession(homes, subPrevious(chatId), "-ws-slug-agent")];
  fs.writeFileSync(foreign, "{}\n");
  return { way, stays: [foreign], sids: [sid, previous] };
}

// The outer loop of a chat: a chat-own agent with a finished run with session and note, plus a workspace agent with
// activation, a finished run with session and a note on this chat. -> { own, wsAgent, way } (`way`: the paths of the
// two sessions in all homes - they fall with the chat).
function seedOuterLoop(homes, chatId, wsId) {
  const newAgent = (fields) => store.createOuterLoopAgent({ id: crypto.randomUUID(), workspaceId: wsId, trigger: [{ kind: "run_end" }],
    provider: "claude", model: "m", ...fields });
  const own = newAgent({ name: "Own", chatId });
  const wsAgent = newAgent({ name: "Ws" });
  const way = [];
  for (const a of [own, wsAgent]) {
    const runId = crypto.randomUUID();
    const sid = crypto.randomUUID();
    store.createOuterLoopRun({ id: runId, agentId: a.id, chatId, trigger: "quiet" });
    store.outerLoopRunEnd(runId, { state: "finished", sessionId: sid });
    store.createOuterLoopNote({ agentId: a.id, chatId, runId, text: `Note from ${a.name}` });
    way.push(...seedSession(homes, sid));
  }
  store.setOuterLoopActive(wsAgent.id, chatId, true);
  return { own, wsAgent, way };
}
const outerLoopState = (chatId, ol) => ({
  own: Boolean(store.outerLoopAgent(ol.own.id)),
  wsAgent: Boolean(store.outerLoopAgent(ol.wsAgent.id)),
  runs: [ol.own.id, ol.wsAgent.id].flatMap((aid) => store.outerLoopRunsOfAgent(aid).items).filter((l) => l.chatId === chatId).length,
  notes: store.outerLoopNotes(chatId).items.length,
  active: Boolean(store.outerLoopActiveRow(ol.wsAgent.id, chatId)),
});

async function withTerminal(base, wid, chatId, all) {
  const r = await json(`${base}/api/workspaces/${wid}/terminal`, { method: "POST", body: JSON.stringify({ cols: 80, rows: 24, tag: `chat:${chatId}` }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.available, true, `node-pty missing: ${JSON.stringify(r.body)}`);
  all.push(r.body.id);
  return r.body.id;
}
const alive = async (base, id) => (await json(`${base}/api/terminal/${id}/exists`)).body.exists;

test("every delete path of a chat goes through the ONE closing path: shells, scratch, MCP, subagents, attachments, profile, CLI sessions gone", async () => {
  await withServer(async ({ base, root, wsPath, scratchDir }) => {
    const dataDir = path.dirname(scratchDir);
    const { homes, back } = setHomes(root, dataDir);
    const ws = await makeWorkspace(base, "Closing", wsPath);
    const all = [];
    // A neighbor that must keep everything - its id shares no prefix, its files stand beside.
    const neighbor = await makeChat(base, ws.id);
    const neighborLeftovers = seedBacklogs(dataDir, neighbor.id);
    store.createHint(neighbor.id, "Hint of the neighbor", { source: "test" });
    seedSubagent(neighbor.id);
    seedGraphStart(neighbor.id);
    const neighborSessions = seedChatSessions(homes, neighbor.id);
    const neighborOuterLoop = seedOuterLoop(homes, neighbor.id, ws.id);
    neighborSessions.way.push(...neighborOuterLoop.way); // the neighbor's "way" means: must STAY (checkSessions)
    try {
      const neighborShell = await withTerminal(base, ws.id, neighbor.id, all);
      // Session of the chat and its subagent gone in B AND in the project home, the foreign rollout and everything of the neighbor there.
      const checkSessions = (way, sessions, id) => {
        for (const p of sessions.way) assert.equal(isPresent(p), false, `${way}: session gone (${path.relative(root, p)})`);
        for (const p of sessions.stays) assert.ok(isPresent(p), `${way}: the foreign rollout stays (${path.relative(root, p)})`);
        for (const p of [...neighborSessions.way, ...neighborSessions.stays]) assert.ok(isPresent(p), `${way}: the neighbor's session stays (${path.relative(root, p)})`);
        // The rows of the earlier sessions fall with the chat, the neighbor's stay.
        assert.deepEqual(store.chatSessions([id]), new Map(), `${way}: no session of the chat left in the stock`);
        assert.deepEqual(store.previousSubagentSessions(id), [], `${way}: no earlier session of its subagent left in the stock`);
        assert.deepEqual(store.chatSessions([neighbor.id]).get(neighbor.id), neighborSessions.sids, `${way}: the neighbor's sessions stay in the stock`);
        assert.deepEqual(store.previousSubagentSessions(neighbor.id), [{ agentId: "averw0000-1", sid: subPrevious(neighbor.id) }], `${way}: the earlier one of its subagent too`);
      };
      const check = async (way, id, shell, leftovers, sessions) => {
        checkSessions(way, sessions, id);
        // The chat-own agent with rows, runs, notes and activation gone; the workspace agent stays (except with the
        // workspace); at the neighbor everything stands.
        assert.deepEqual(outerLoopState(id, sessions.outerLoop), { own: false, wsAgent: way !== "Workspace", runs: 0, notes: 0, active: false },
          `${way}: outer loop: the chat-own agent is gone, runs, notes and activation on the chat too`);
        assert.deepEqual(outerLoopState(neighbor.id, neighborOuterLoop), { own: true, wsAgent: true, runs: 2, notes: 2, active: true },
          `${way}: the neighbor's outer loop stays`);
        assert.equal(await alive(base, shell), false, `${way}: terminal of the chat dead`);
        for (const [what, p] of Object.entries(leftovers)) {
          // The output location must be gone AS A WHOLE (outputs/<id>), not just the seeded file.
          const location = what.startsWith("Output location") ? path.dirname(path.dirname(p))
            : what === "Subagent output" || what === "Scratch" || what === "Attachments" || what === "Browser profile" ? path.dirname(p) : p;
          assert.equal(fs.existsSync(location), false, `${way}: ${what} gone (${path.relative(dataDir, location)})`);
        }
        assert.equal(store.getChat(id), undefined, `${way}: the row is gone`);
        assert.deepEqual(store.openHints(id), [], `${way}: the silent hints are gone`);
        assert.equal(store.openHints(neighbor.id).length, 1, `${way}: the neighbor's hint stays`);
        assert.deepEqual(store.subagentsOf(id), [], `${way}: the subagent stock is gone`);
        assert.equal(store.readSubagent(id, "averw0000-1"), null, `${way}: with its log`);
        assert.equal(store.readSubagent(neighbor.id, "averw0000-1")?.rows.length, 1, `${way}: the neighbor's stock stays`);
        assert.deepEqual(store.graphStartsOf(id), [], `${way}: the graph starts are gone`);
        assert.equal(store.graphStartsOf(neighbor.id).length, 1, `${way}: the neighbor's graph start stays`);
        assert.equal(await alive(base, neighborShell), true, `${way}: the neighbor's terminal lives`);
        for (const [what, p] of Object.entries(neighborLeftovers)) assert.ok(fs.existsSync(p), `${way}: ${what} of the neighbor stays`);
      };
      const prepare = async (id) => {
        store.createHint(id, "open hint", { source: "test" });
        seedSubagent(id);
        seedGraphStart(id);
        const sessions = seedChatSessions(homes, id);
        sessions.outerLoop = seedOuterLoop(homes, id, ws.id);
        sessions.way.push(...sessions.outerLoop.way);
        return { shell: await withTerminal(base, ws.id, id, all), leftovers: seedBacklogs(dataDir, id), sessions };
      };

      // 1. Delete a chat.
      const c = await makeChat(base, ws.id);
      let v = await prepare(c.id);
      assert.equal((await json(`${base}/api/chats/${c.id}`, { method: "DELETE" })).status, 200);
      await check("Chat", c.id, v.shell, v.leftovers, v.sessions);

      // 2. Folder permanently (from the archive).
      const f = await ok(`${base}/api/chat-folders`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, name: "Way", kind: "normal" }) });
      const fc = await makeChat(base, ws.id);
      await ok(`${base}/api/chats/${fc.id}`, { method: "PATCH", body: JSON.stringify({ folderId: f.id }) });
      v = await prepare(fc.id);
      assert.equal((await json(`${base}/api/chat-folders/${f.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) })).status, 200);
      assert.equal((await json(`${base}/api/chat-folders/${f.id}?permanently=1`, { method: "DELETE" })).status, 200);
      // Archiving already ended the shell - the terminal counts here only as "not back".
      await check("Folder permanently", fc.id, v.shell, v.leftovers, v.sessions);

      // 3. Delete a workspace - a separate one so the neighbor above stays; its chat takes everything along.
      const ws2Path = path.join(root, "second-workspace");
      fs.mkdirSync(ws2Path, { recursive: true });
      const ws2 = await makeWorkspace(base, "Second", ws2Path);
      const w = await makeChat(base, ws2.id);
      const wLeftovers = seedBacklogs(dataDir, w.id);
      store.createHint(w.id, "open hint", { source: "test" });
      seedSubagent(w.id);
      seedGraphStart(w.id);
      const wSessions = seedChatSessions(homes, w.id); // the workspace path learns its chats only from the store's report
      wSessions.outerLoop = seedOuterLoop(homes, w.id, ws2.id);
      wSessions.way.push(...wSessions.outerLoop.way);
      const wShell = await withTerminal(base, ws2.id, w.id, all);
      assert.equal((await json(`${base}/api/workspaces/${ws2.id}`, { method: "DELETE" })).status, 200);
      await check("Workspace", w.id, wShell, wLeftovers, wSessions);
    } finally {
      for (const id of all) await fetch(`${base}/api/terminal/${id}`, { method: "DELETE" }).catch(() => {});
      back();
    }
  });
});

// The exceptions and limits. A fork carries the session of its original (fork_pending) - deleting the fork (also the
// rollback of a half-created one, the same path) leaves it standing, only deleting the original afterwards takes it;
// likewise a session a subagent of another chat carries. In the project home a symlink in place of `<sid>.jsonl` or
// `<sid>/` falls itself, its target stays; a slug folder that is a symlink is not entered. The empty slug of a
// worktree agent falls, a shared empty slug stays.
test("sessions: a fork keeps the session it carries; symlinks fall themselves, their target stays; the empty slug of a worktree agent falls", async () => {
  await withServer(async ({ base, root, wsPath, scratchDir }) => {
    const dataDir = path.dirname(scratchDir);
    const { homes, back } = setHomes(root, dataDir);
    try {
      const ws = await makeWorkspace(base, "Sessions", wsPath);
      const erase = async (id) => assert.equal((await json(`${base}/api/chats/${id}`, { method: "DELETE" })).status, 200);

      // 1. Fork: first the fork, then the original.
      const a = await makeChat(base, ws.id);
      const sid = crypto.randomUUID();
      store.updateChat(a.id, { claudeSessionId: sid });
      const aPaths = seedSession(homes, sid);
      const fork = await ok(`${base}/api/chats/${a.id}/fork`, { method: "POST" });
      assert.equal(store.getChat(fork.id).claudeSessionId, sid, "the fork carries the session of its original");
      await erase(fork.id);
      for (const p of aPaths) assert.ok(isPresent(p), `fork deleted: the original's session stays (${path.relative(root, p)})`);
      await erase(a.id);
      for (const p of aPaths) assert.equal(isPresent(p), false, `original deleted: its session is gone (${path.relative(root, p)})`);

      // 2. A session a subagent of ANOTHER chat carries stays - until it falls too.
      const c = await makeChat(base, ws.id);
      const d = await makeChat(base, ws.id);
      const shared = `shared-${crypto.randomUUID()}`;
      for (const chat of [c, d]) store.rememberSubagent(chat.id, { agentId: "ag0000-1", provider: "codex", sessionId: shared, state: "finished" });
      const gPaths = seedSession(homes, shared);
      await erase(c.id);
      for (const p of gPaths) assert.ok(isPresent(p), `the subagent of the other chat still carries it (${path.relative(root, p)})`);
      await erase(d.id);
      for (const p of gPaths) assert.equal(isPresent(p), false, `nobody carries it any more (${path.relative(root, p)})`);

      // 3. Symlinks in the project home - the target lies outside and stays.
      const outside = path.join(root, "outside");
      fs.mkdirSync(path.join(outside, "folder"), { recursive: true });
      fs.mkdirSync(path.join(outside, "slug-target"), { recursive: true });
      const v = await makeChat(base, ws.id);
      const vsid = crypto.randomUUID();
      store.updateChat(v.id, { claudeSessionId: vsid });
      fs.writeFileSync(path.join(outside, "file.jsonl"), "B\n");
      fs.writeFileSync(path.join(outside, "folder", "content.txt"), "B\n");
      fs.writeFileSync(path.join(outside, "slug-target", `${vsid}.jsonl`), "B\n");
      const pSlug = path.join(homes.claude[1], "projects", "-ws-reference");
      fs.mkdirSync(pSlug, { recursive: true });
      fs.symlinkSync(path.join(outside, "file.jsonl"), path.join(pSlug, `${vsid}.jsonl`));
      fs.symlinkSync(path.join(outside, "folder"), path.join(pSlug, vsid));
      fs.symlinkSync(path.join(outside, "slug-target"), path.join(homes.claude[1], "projects", "-ws-slug-reference"));
      await erase(v.id);
      assert.equal(isPresent(path.join(pSlug, `${vsid}.jsonl`)), false, "the symlink in place of <sid>.jsonl fell");
      assert.equal(isPresent(path.join(pSlug, vsid)), false, "the symlink in place of <sid>/ fell");
      assert.equal(fs.readFileSync(path.join(outside, "file.jsonl"), "utf8"), "B\n", "the target of the file symlink fell");
      assert.equal(fs.readFileSync(path.join(outside, "folder", "content.txt"), "utf8"), "B\n", "the target of the folder symlink fell");
      assert.ok(isPresent(path.join(outside, "slug-target", `${vsid}.jsonl`)), "a slug symlink was entered");

      // 4. The worktree agent: its empty slug falls in both homes, a shared empty slug stays.
      const w = await makeChat(base, ws.id);
      const wtDir = path.join(root, "wt-root", "agent-awt0000-1");
      fs.mkdirSync(wtDir, { recursive: true });
      const wsid = crypto.randomUUID();
      store.rememberSubagent(w.id, { agentId: "awt0000-1", provider: "claude", sessionId: wsid, state: "finished", cwd: wtDir, worktree: { dir: wtDir, repo: wsPath, branch: "cbase/agent-awt0000-1" } });
      const wtSlug = sessionSlug(fs.realpathSync(wtDir));
      const wPaths = seedSession(homes, wsid, wtSlug);
      const sharedSlug = path.join(homes.claude[1], "projects", "-ws-shared-empty");
      fs.mkdirSync(sharedSlug, { recursive: true });
      await erase(w.id);
      for (const p of wPaths) assert.equal(isPresent(p), false, `worktree agent: session gone (${path.relative(root, p)})`);
      for (const h of homes.claude) assert.equal(isPresent(path.join(h, "projects", wtSlug)), false, `worktree agent: its empty slug fell (${path.relative(root, h)})`);
      assert.ok(isPresent(sharedSlug), "a shared empty slug did not stay");
    } finally { back(); }
  });
});

// EARLIER sessions of a chat fall too. The closing path used to read only the CARRIED one (`chats.claude_session_id`,
// `subagents.session`) - and ordinary actions overwrite it without keeping the old id: `/clear`, `/compact`, the
// provider switch of the chat, the switch of the global provider (for every chat without a fixed provider), for the
// subagent a restart without resume. Every path here through the REAL route (the subagent through the record the core
// writes), each with a session of its own in B and in the project home; after the delete every one is gone. Plus: an
// earlier session a fork still CARRIES stays until its delete; everything of the neighbor (its earlier one too) stays.
test("sessions: earlier sessions fall too - after /clear, /compact, provider switch of the chat and of the global provider, restart of a subagent", async () => {
  await withServer(async ({ base, root, wsPath, scratchDir }) => {
    const dataDir = path.dirname(scratchDir);
    const { homes, back } = setHomes(root, dataDir);
    const globalPrior = (await ok(`${base}/api/provider`)).active;
    try {
      const ws = await makeWorkspace(base, "Earlier", wsPath);
      const erase = async (id) => assert.equal((await json(`${base}/api/chats/${id}`, { method: "DELETE" })).status, 200);
      const paths = new Map(); // cause -> the seeded paths of its session
      const set = (chatId, cause) => {
        const sid = crypto.randomUUID();
        store.updateChat(chatId, { claudeSessionId: sid });
        paths.set(cause, seedSession(homes, sid, "-ws-previous"));
        return sid;
      };
      const cleared = (chatId, cause) => assert.equal(store.getChat(chatId).claudeSessionId ?? null, null, `${cause}: the route discarded the session`);
      const c = await makeChat(base, ws.id);

      // 1. /clear - first a fork that inherits the session (fork_pending): it stays as long as the fork carries it.
      const beforeClear = set(c.id, "before /clear");
      const fork = await ok(`${base}/api/chats/${c.id}/fork`, { method: "POST" });
      assert.equal(store.getChat(fork.id).claudeSessionId, beforeClear, "the fork carries the session before /clear");
      assert.equal((await ok(`${base}/api/chats/${c.id}/clear`, { method: "POST" })).ok, true, "/clear took effect");
      cleared(c.id, "/clear");

      // 2. /compact - the compaction through the fake CLI (oneshot answers "title"), needs two log rows.
      set(c.id, "before /compact");
      store.addMessage(c.id, "user", "Question");
      store.addMessage(c.id, "assistant", "Response");
      assert.equal((await ok(`${base}/api/chats/${c.id}/compact`, { method: "POST" })).ok, true, "/compact took effect");
      cleared(c.id, "/compact");

      // 3. Provider switch of the chat.
      set(c.id, "before provider switch");
      await ok(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ provider: "codex" }) });
      cleared(c.id, "provider switch");

      // 4. Switch of the global provider - it discards the session of every chat WITHOUT a fixed provider.
      store.updateChat(c.id, { provider: "" });
      set(c.id, "before global switch");
      await ok(`${base}/api/provider`, { method: "POST", body: JSON.stringify({ provider: globalPrior === "codex" ? "claude" : "codex" }) });
      cleared(c.id, "global switch");
      await ok(`${base}/api/provider`, { method: "POST", body: JSON.stringify({ provider: globalPrior }) });

      // 5. A subagent restarted without resume: the same record, a new session.
      const subA = crypto.randomUUID(), subB = crypto.randomUUID();
      store.rememberSubagent(c.id, { agentId: "aneu0000-1", provider: "claude", sessionId: subA, state: "running" });
      store.rememberSubagent(c.id, { agentId: "aneu0000-1", provider: "claude", sessionId: subB, state: "finished" });
      paths.set("Subagent before the restart", seedSession(homes, subA, "-ws-previous-agent"));
      paths.set("Subagent", seedSession(homes, subB, "-ws-previous-agent"));

      // 6. The carried session; plus a neighbor with an earlier one (via /clear) and a carried one.
      set(c.id, "supported");
      const neighbor = await makeChat(base, ws.id);
      const neighborPaths = [];
      for (const cause of ["neighbor earlier", "neighbor carried"]) {
        if (cause === "neighbor carried") assert.equal((await ok(`${base}/api/chats/${neighbor.id}/clear`, { method: "POST" })).ok, true);
        set(neighbor.id, cause);
        neighborPaths.push(...paths.get(cause));
        paths.delete(cause);
      }

      await erase(c.id);
      for (const [cause, list] of paths) {
        for (const p of list) {
          if (cause === "before /clear") assert.ok(isPresent(p), `the fork still carries the session before /clear - it stays (${path.relative(root, p)})`);
          else assert.equal(isPresent(p), false, `${cause}: session gone (${path.relative(root, p)})`);
        }
      }
      for (const p of neighborPaths) assert.ok(isPresent(p), `the neighbor's sessions stay (${path.relative(root, p)})`);
      assert.deepEqual(store.chatSessions([c.id]), new Map(), "no session of the chat left in the stock");
      assert.deepEqual(store.previousSubagentSessions(c.id), [], "no earlier one of its subagent left in the stock");
      assert.equal(store.chatSessions([neighbor.id]).get(neighbor.id).length, 2, "both sessions of the neighbor stay in the stock");

      await erase(fork.id);
      for (const p of paths.get("before /clear")) assert.equal(isPresent(p), false, `fork deleted: the session before /clear is gone (${path.relative(root, p)})`);
    } finally {
      await json(`${base}/api/provider`, { method: "POST", body: JSON.stringify({ provider: globalPrior }) }).catch(() => {});
      back();
    }
  });
});

// The counter-check at the store: the subagent stock hangs on NO cascade - deleted past the closing path, it stays.
// That is exactly why the closing path is the guard, and the source guard below holds it.
test("deleted past the closing path => the subagent stock stays (the database does not clear it)", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Past", wsPath);
    const c = await makeChat(base, ws.id);
    seedSubagent(c.id);
    store.deleteChat(c.id);
    assert.equal(store.getChat(c.id), undefined);
    assert.equal(store.subagentsOf(c.id).length, 1, "without the closing path the row stays");
    assert.equal(store.readSubagent(c.id, "averw0000-1").rows.length, 1, "and its log");
    store.deleteSubagents(c.id);
  });
});

// Deleting a workspace must check open work - a running turn, a compaction or a goal verdict would otherwise keep
// writing after the delete under a chat id no delete path reaches any more. It asks per chat of the workspace the same
// query as the chat route and the archive (runs/archive.js deleteObstacles): 409 with `open` per chat, and NOTHING
// happened - then, without open work, 200.
test("a workspace with a running turn or a running compaction is 409 like the chat route - nothing deleted; afterwards 200", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Work", wsPath);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);
    const erase = () => json(`${base}/api/workspaces/${ws.id}`, { method: "DELETE" });
    const nothingHappened = (what) => {
      assert.ok(store.getWorkspace(ws.id), `${what}: the workspace is gone despite 409`);
      assert.ok(store.getChat(a.id) && store.getChat(b.id), `${what}: a chat is gone despite 409`);
    };
    running.add(a.id);
    try {
      const r = await erase();
      assert.equal(r.status, 409, `the workspace fell under a running turn: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body.open.map((o) => [o.chatId, o.reason]), [[a.id, "running"]]);
      assert.match(r.body.error, /Workspace/);
      nothingHappened("running");
    } finally { running.delete(a.id); }
    compacting.add(b.id);
    try {
      const r = await erase();
      assert.equal(r.status, 409, `the workspace fell under a running compaction: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body.open.map((o) => [o.chatId, o.reason]), [[b.id, "compacted"]]);
      nothingHappened("compacted");
    } finally { compacting.delete(b.id); }
    const r = await erase();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!store.getWorkspace(ws.id) && !store.getChat(a.id) && !store.getChat(b.id), "without open work everything falls");
  });
});

// A deleted workspace takes its channels with files, its git accesses and its per-workspace settings along. Those settings are
// NOT in a table with workspace_id but in app_settings under a key ending in `.<wid>` (approval marks through the real route; a
// leftover GitLab token of an old installation, `gitlab.token.<wid>`, through the store). A neighbor workspace keeps its own (the
// delete hits only the suffix of THIS id).
// Counter-test: a store/workspaces.js that does not clear these => red ("the GitLab token ... survived").
test("a deleted workspace takes channels with files, git accesses and its settings along - the neighbor keeps its own", async () => {
  await withServer(async ({ base, root, wsPath }) => {
    const ws = await makeWorkspace(base, "Falls", wsPath);
    store.createChannel({ id: "channel-m31", workspaceId: ws.id, name: "K" });
    const channelDir = path.join(root, "data-root", "data", "channel-files", "channel-m31");
    fs.mkdirSync(channelDir, { recursive: true });
    fs.writeFileSync(path.join(channelDir, "note.txt"), "from the channel");
    store.setGitCred(ws.id, "gitlab.example", "maintainer", "secret-m31");
    const marks = (wid) => ok(`${base}/api/workspaces/${wid}/approval-marks`, { method: "PUT", body: JSON.stringify({ tools: ["cbase_agent_send"] }) });
    await marks(ws.id);
    store.setSetting(`gitlab.token.${ws.id}`, "glpat-SECRET-m31");
    fs.mkdirSync(path.join(wsPath, "neighbor"), { recursive: true });
    const neighbor = await makeWorkspace(base, "Neighbor", path.join(wsPath, "neighbor"));
    await marks(neighbor.id);
    store.setSetting(`gitlab.token.${neighbor.id}`, "glpat-NEIGHBOR");
    const withSuffix = (wid) => rawDb.prepare("SELECT key FROM app_settings WHERE substr(key, ?) = ?").all(-(wid.length + 1), `.${wid}`).map((x) => x.key).sort();
    assert.ok(withSuffix(ws.id).length >= 2, `precondition: per-workspace settings stood (${withSuffix(ws.id).join(", ")})`);

    const r = await json(`${base}/api/workspaces/${ws.id}`, { method: "DELETE" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(store.getSetting(`gitlab.token.${ws.id}`), "", "the GitLab token (in plain text) survived its workspace");
    assert.deepEqual(withSuffix(ws.id), [], "per-workspace settings survived it");
    assert.equal(store.getSetting(`gitlab.token.${neighbor.id}`), "glpat-NEIGHBOR", "the token of the neighbor workspace fell too");
    assert.ok(!store.getChannel("channel-m31"), "the channel survived its workspace");
    assert.equal(fs.existsSync(channelDir), false, "the channel files stayed");
    assert.deepEqual(store.listGitCreds(ws.id), [], "the git accesses (in plain text) survived their workspace");
  });
});

test("source text: no store delete call that takes chats goes past the closing path", () => {
  const files = [];
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "store" && e.name !== "node_modules") run(p); }
      else if (e.name.endsWith(".js")) files.push(p);
    }
  };
  run(SERVER);
  const violations = [];
  let deleteChatPlaces = 0;
  for (const file of files) {
    const rel = path.relative(SERVER, file);
    const rows = fs.readFileSync(file, "latin1").split("\n");
    rows.forEach((z, i) => {
      if (/^\s*(\/\/|\*)/.test(z)) return;
      if (/\bdeleteChat\(/.test(z)) {
        deleteChatPlaces++;
        if (rel !== path.join("chats", "erase.js")) violations.push(`${rel}:${i + 1} calls deleteChat - only chats/erase.js may`);
      }
      // The store path that takes chats along in one go runs only as a row delete INSIDE the closing path.
      if (/\bdeleteWorkspace\(/.test(z) && !/closeChats\(/.test(z)) {
        violations.push(`${rel}:${i + 1} deletes chats past the closing path: ${z.trim()}`);
      }
    });
  }
  assert.ok(deleteChatPlaces >= 1, "the closing path itself calls deleteChat - the guard reads the right files");
  assert.deepEqual(violations, []);
});
