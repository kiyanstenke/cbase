// Pausing the goal: the goal strip in the composer — trash, pause, expand.
//
// A set goal (`chats.goal`) is in the system prompt of every run (runs/do-run.js, goalPrompt), and after every run the goal gate
// (runs/post-run.js goalGateAfterRun) judges via a judge oneshot and continues by itself on "open". A paused goal
// (`chats.goal_paused`, store/chats.js initTargetPauseSchema) rests: no goal in the system prompt, no verdict, no continuation —
// read FRESH from the row, because pausing often happens in the middle of a run. The contract with the clients (web, iOS):
// `goalPaused` on the chat object; PATCH takes it as a boolean (else 400), `true` only with a goal (else 400); every write of
// `goal` without the field cancels the pause; resuming starts no run; the fork inherits goal and pause.
//
// Waiting is on events (gate files, /api/runs/active `quiet` via quiet.mjs), never on a duration.
//
// COUNTER-TESTS (each turns the named test red):
//  · post-run.js reads `chat.goalPaused` (the state from the start of the run) instead of the row ⇒ "pause during the run"
//    (the judge judges, the continuation runs);
//  · the check after the verdict removed ⇒ "pause during the verdict" (the "continuing" line is there although nothing
//    continues); the check before the continuation (`fresh.goalPaused`) removed ⇒ a second turn runs;
//  · do-run.js without the pause condition ⇒ "paused: no goal in the system prompt …";
//  · store/chats.js updateChat without `goal_paused = 0` ⇒ the PATCH test (a new goal would stay paused).
//
// Second reading:
//  · without any fix (no check in the alarm clock auto-continue.js, none in the head of doRun, none in resume.js) ⇒ "parked
//    continuation" (the clock starts it: {"ok":true}), "restart" (restart, 1 turn) and "doRun itself" (the continuation begins);
//  · only doRun without check (clock and restart still ask) ⇒ "doRun itself";
//  · only the clock without check (doRun still catches it) ⇒ "parked continuation" — the line "limit reset — the run is
//    continued" with its notice announced a run that did not come;
//  · only resume.js without check (doRun still catches it) ⇒ "restart" (marker "resumed", no separator);
//  · the gate reads the goal from the start of the run (`chat.goal`) ⇒ "the goal that applies NOW" (the judge judges a deleted
//    goal); `appliesStill` without the text comparison ⇒ the same test (the new goal is continued with the verdict about the old
//    one); the verdict line BEFORE waiting for the compaction ⇒ "compaction" ("continuing" line);
//  · without the event ⇒ "harness/target"; without the old/new comparison ⇒ the same test (event without change).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import * as store from "../electron/server/store.js";
import { fireAutoContinue } from "../electron/server/runs/auto-continue.js";
import { compactChatContext } from "../electron/server/runs/post-run.js";
import { doRun } from "../electron/server/runs/do-run.js";
import { resumeInterruptedWork } from "../electron/server/runs/resume.js";

// Main agent: logs per turn the text and whether the goal was in the system prompt; with "WITH-GATE" it waits at the gate
// "main" (the run stays open until the test opens it). It answers "still open", to the continuation of the goal gate "done".
// If "LIMIT-ONCE" is in the goal, the first continuation fails at the usage limit (CLI wording, reset in an hour — so only the
// test wakes it): twice, because an exit ≠ 0 without result on resume makes doRun repeat once without a session (the same turn);
// again only when the test deletes the marker <LOCATION>/limit-seen. Judge (oneshot): "achieved" exactly when the last answer
// is "done" — so open after the first turn, achieved after the continuation; if "JUDGE-GATE" is in the goal, it waits at the
// gate "judge". The compaction (oneshot "You are compacting …" — its prompt also names the "overarching target", so it is
// recognized first) waits at the gate "compact" as long as <LOCATION>/compact-gate exists.
const fake = fakeClaude({
  main: `
  const sp = arg("--append-system-prompt");
  fs.appendFileSync(path.join(LOCATION, "main.jsonl"), JSON.stringify({ text: text.slice(0, 2000), target: sp.includes("# Target of this chat") }) + "\\n");
  const limitSeen = (() => { try { return Number(fs.readFileSync(path.join(LOCATION, "limit-seen"), "utf8")) || 0; } catch { return 0; } })();
  if (text.includes("[Target gate]") && text.includes("LIMIT-ONCE") && limitSeen < 2) {
    fs.writeFileSync(path.join(LOCATION, "limit-seen"), String(limitSeen + 1));
    process.stderr.write("Claude usage limit reached · resets at " + new Date(Date.now() + 3600000).toISOString() + "\\n");
    process.exit(1);
  }
  if (text.includes("WITH-GATE")) await gate("main");
  const t = text.includes("[Target gate]") ? "done" : "still open";
  say({ type: "assistant", message: { id: "m-" + process.pid + "-" + turn, content: [{ type: "text", text: t }] } });
  finished();
  say({ type: "result", result: t, session_id: "main-session" });`,
  oneshot: `
  const compaction = prompt.includes("You are compacting");
  const target = !compaction && prompt.includes("overarching target");
  fs.appendFileSync(path.join(LOCATION, "oneshots.jsonl"), JSON.stringify({ kind: compaction ? "compaction" : target ? "target" : "otherwise" }) + "\\n");
  if (compaction) {
    const summary = () => respond("SUMMARY");
    if (fs.existsSync(path.join(LOCATION, "compact-gate"))) gate("compact").then(summary); else summary();
  } else if (!target) respond("SUMMARY");
  else {
    const achieved = prompt.includes("Last answer of the agent:\\ndone");
    const verdict = () => respond(JSON.stringify({ achieved, note: achieved ? "reached" : "not yet" }));
    if (prompt.includes("JUDGE-GATE")) gate("judge").then(verdict); else verdict();
  }`,
});

// The fake CLI (a child process) writes the logs while the test reads — only complete lines (jsonl.mjs).
const rows = (file) => (fs.existsSync(file) ? readJsonl(file) : []);
const mainTurns = (root) => rows(path.join(root, "main.jsonl"));
const verdicts = (root) => rows(path.join(root, "oneshots.jsonl")).filter((o) => o.kind === "target");
const targetRows = (log) => log.filter((z) => z.role === "goal").map((z) => JSON.parse(z.text));

// Status AND body — `json` throws on every non-2xx.
async function response(url, init) {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init?.headers || {}) } });
  return { status: res.status, body: await res.json() };
}
const limitRows = (log) => log.filter((z) => z.role === "limit").map((z) => JSON.parse(z.text));

// Without an account (as in agent-limit-parking.test.js): parking and waking ask the account's windows (limit-gate.js
// limitWindowsFor) — without the developer's HOME, keychain and OAuth token there are none, and the reset from the message counts.
async function withoutAccount(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-target-pause-account-"));
  const prior = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  try {
    const shim = path.join(root, "shim");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "security"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    for (const d of ["home", "codex-home"]) fs.mkdirSync(path.join(root, d));
    process.env.HOME = path.join(root, "home");
    process.env.CODEX_HOME = path.join(root, "codex-home");
    process.env.PATH = `${shim}:${process.env.PATH}`;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn(`Cleaning up ${root}: ${e.code || e.message}`); }
  }
}

// The SSE stream of a chat (as in agent-lifetime.test.js) — `shutdown()` belongs in the finally: an open reader would hold
// server.close, and the first failure would turn into a hang.
async function openStream(url, waitForTruthy) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal, headers: { Accept: "text/event-stream", Connection: "close" } });
  assert.equal(res.status, 200);
  const events = [];
  const pump = (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))); } catch { /* partial line */ } }
          }
        }
      }
    } catch { /* abort on close */ }
  })();
  return {
    events,
    wait: (p, what) => waitForTruthy(() => events.find(p) || null, what),
    async shutdown() { ac.abort(); await pump; },
  };
}

test("PATCH goalPaused: a boolean, only with a goal; every write of goal cancels the pause; the fork inherits it; resuming starts nothing", async () => {
  await withAgentsServer(async ({ base, chat, root, waitForQuiet }) => {
    const url = `${base}/api/chats/${chat.id}`;
    const patch = (body) => json(url, { method: "PATCH", body: JSON.stringify(body) });
    const patchRaw = (body) => response(url, { method: "PATCH", body: JSON.stringify(body) });

    assert.equal((await json(url)).goalPaused, false, "the field is always on the chat — false without a pause");

    // Not a boolean ⇒ 400, null too (a missing field is no statement, a misspelled one neither).
    for (const wrong of ["yes", "true", 1, 0, null, {}]) {
      const r = await patchRaw({ goalPaused: wrong });
      assert.equal(r.status, 400, `goalPaused: ${JSON.stringify(wrong)} ⇒ 400`);
      assert.match(r.body.error, /goalPaused/);
    }
    // true without a non-empty goal ⇒ 400 — neither stored nor in the same body.
    for (const body of [{ goalPaused: true }, { goal: "", goalPaused: true }, { goal: "   ", goalPaused: true }]) {
      const r = await patchRaw(body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} ⇒ 400`);
      assert.match(r.body.error, /Ohne Ziel|no goal/);
    }
    // false without a goal is no contradiction (nothing rests) — 200, stays false.
    assert.equal((await patch({ goalPaused: false })).goalPaused, false);

    let c = await patch({ goal: "Goal one" });
    assert.deepEqual([c.goal, c.goalPaused], ["Goal one", false]);
    c = await patch({ goalPaused: true });
    assert.deepEqual([c.goal, c.goalPaused], ["Goal one", true], "paused, the goal stays");
    assert.equal((await json(url)).goalPaused, true, "GET delivers the pause");

    // A 400 writes NOTHING, no neighboring field in the same body either.
    const r = await patchRaw({ title: "Renamed", goalPaused: "no" });
    assert.equal(r.status, 400);
    c = await json(url);
    assert.deepEqual([c.title, c.goalPaused], ["Agent-E2E", true], "the rejected PATCH changed nothing");

    // A foreign field leaves the pause alone.
    c = await patch({ pinned: true });
    assert.equal(c.goalPaused, true, "a PATCH without goal does not cancel the pause");

    // Every write of goal without goalPaused cancels it: new goal, the same once more, cleared.
    c = await patch({ goal: "Goal two" });
    assert.deepEqual([c.goal, c.goalPaused], ["Goal two", false], "a new goal is not paused");
    await patch({ goalPaused: true });
    c = await patch({ goal: "Goal two" });
    assert.equal(c.goalPaused, false, "setting the same goal once more also cancels the pause");
    await patch({ goalPaused: true });
    c = await patch({ goal: "" });
    assert.deepEqual([c.goal, c.goalPaused], ["", false], "cleared: no goal, no pause");

    // Both fields in one body: both apply.
    c = await patch({ goal: "Goal three", goalPaused: true });
    assert.deepEqual([c.goal, c.goalPaused], ["Goal three", true], "goal and pause in one go");

    // The fork inherits goal and pause — otherwise a resting goal would wake up there on the first run.
    const fork = await json(`${url}/fork`, { method: "POST" });
    assert.deepEqual([fork.goal, fork.goalPaused], ["Goal three", true], "the fork carries goal and pause");

    // Resuming starts no run by itself.
    c = await patch({ goalPaused: false });
    assert.deepEqual([c.goal, c.goalPaused], ["Goal three", false]);
    await waitForQuiet();
    assert.equal(mainTurns(root).length, 0, "no turn after resuming");
    assert.equal(verdicts(root).length, 0, "no verdict after resuming");
    assert.equal((await json(`${url}/log`)).filter((z) => z.role === "user" || z.role === "assistant").length, 0, "no history was created");
  }, { claude: fake });
});

test("paused: no goal in the system prompt, no verdict, no continuation — once resumed the goal works again from the next run", async () => {
  await withAgentsServer(async ({ base, chat, ws, root, waitForQuiet }) => {
    const url = `${base}/api/chats/${chat.id}`;
    await json(url, { method: "PATCH", body: JSON.stringify({ goal: "Write the report", goalPaused: true }) });

    await json(`${url}/message`, { method: "POST", body: JSON.stringify({ text: "First question" }) });
    await waitForQuiet();
    let turns = mainTurns(root);
    assert.equal(turns.length, 1, `exactly one turn, no continuation: ${JSON.stringify(turns)}`);
    assert.equal(turns[0].target, false, "the paused goal was NOT in the system prompt");
    assert.equal(verdicts(root).length, 0, "the judge was not called");
    assert.deepEqual(targetRows(await json(`${url}/log`)), [], "no goal row in the history");
    let c = await json(url);
    assert.deepEqual([c.goal, c.goalPaused], ["Write the report", true], "goal and pause are unchanged");
    // The list carries the field too (the chat now has a history and is in it).
    const list = await json(`${base}/api/chats?workspaceId=${ws.id}`);
    assert.equal(list.find((x) => x.id === chat.id)?.goalPaused, true, "the chat list delivers the pause");

    // Counter-test: resumed — the next run carries the goal, the judge says "open", the gate continues, the continuation
    // finishes, the judge says "achieved" and clears the goal (the pause stays 0).
    await json(url, { method: "PATCH", body: JSON.stringify({ goalPaused: false }) });
    await json(`${url}/message`, { method: "POST", body: JSON.stringify({ text: "Second question" }) });
    await waitForQuiet();
    turns = mainTurns(root);
    assert.equal(turns.length, 3, `the turn and one continuation: ${JSON.stringify(turns)}`);
    assert.equal(turns[1].target, true, "once resumed the goal is in the system prompt again");
    assert.match(turns[2].text, /\[Target gate\]/, "the goal gate continuation ran");
    assert.equal(verdicts(root).length, 2, "two verdicts: open, then achieved");
    assert.deepEqual(targetRows(await json(`${url}/log`)).map((z) => z.achieved), [false, true]);
    c = await json(url);
    assert.deepEqual([c.goal, c.goalPaused], ["", false], "achieved: goal cleared, no pause");
  }, { claude: fake });
});

test("pause during the run: afterwards nobody judges and nothing is continued — read from the row, not from the start of the run", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForQuiet }) => {
    const url = `${base}/api/chats/${chat.id}`;
    await json(url, { method: "PATCH", body: JSON.stringify({ goal: "Write the report" }) });

    await json(`${url}/message`, { method: "POST", body: JSON.stringify({ text: "WITH-GATE please work" }) });
    await gate.reached("main");
    const c = await json(url, { method: "PATCH", body: JSON.stringify({ goalPaused: true }) });
    assert.equal(c.goalPaused, true, "pausing works in the middle of a run");
    gate.open("main");
    await waitForQuiet();

    const turns = mainTurns(root);
    assert.equal(turns.length, 1, `no continuation: ${JSON.stringify(turns)}`);
    assert.equal(turns[0].target, true, "the run began unpaused — with the goal in the system prompt");
    assert.equal(verdicts(root).length, 0, "no judge judged after the run");
    assert.deepEqual(targetRows(await json(`${url}/log`)), [], "no goal row");
    const after = await json(url);
    assert.deepEqual([after.goal, after.goalPaused], ["Write the report", true]);
  }, { claude: fake });
});

test("pause during the verdict: the verdict lapses without a row, the continuation does not start", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForQuiet }) => {
    const url = `${base}/api/chats/${chat.id}`;
    await json(url, { method: "PATCH", body: JSON.stringify({ goal: "JUDGE-GATE: write the report" }) });

    await json(`${url}/message`, { method: "POST", body: JSON.stringify({ text: "First question" }) });
    await gate.reached("judge");
    await json(url, { method: "PATCH", body: JSON.stringify({ goalPaused: true }) });
    gate.open("judge"); // the judge says "open" — without the pause that would mean: a "continuing" row and a second turn
    await waitForQuiet();

    let turns = mainTurns(root);
    assert.equal(turns.length, 1, `no continuation: ${JSON.stringify(turns)}`);
    assert.equal(verdicts(root).length, 1, "the judge ran (it had been called already)");
    assert.deepEqual(targetRows(await json(`${url}/log`)), [], "its verdict lapsed without a row");
    let c = await json(url);
    assert.deepEqual([c.goal, c.goalPaused], ["JUDGE-GATE: write the report", true]);

    // Counter-test in the same chat (the gate is open now): resumed, the judge says "open" and the gate continues.
    await json(url, { method: "PATCH", body: JSON.stringify({ goalPaused: false }) });
    await json(`${url}/message`, { method: "POST", body: JSON.stringify({ text: "Second question" }) });
    await waitForQuiet();
    turns = mainTurns(root);
    assert.equal(turns.length, 3, `without pause: the turn and one continuation: ${JSON.stringify(turns)}`);
    const gz = targetRows(await json(`${url}/log`));
    assert.equal(gz[0]?.continuing, true, "without pause: \"continuing\"");
    assert.deepEqual(gz.map((z) => z.achieved), [false, true]);
    c = await json(url);
    assert.deepEqual([c.goal, c.goalPaused], ["", false]);
  }, { claude: fake });
});

// ── Second reading: goal that applies now, parked and interrupted continuations, event ──────────────────────────────────────────────────────────────────────────────

// The order of a goal gate continuation as post-run.js goalGateAfterRun builds it (the fake recognizes "[Target gate]").
const RESUMPTION = "[Target gate] Automatic continuation by the cbase harness: according to the check, the target of this chat is NOT yet achieved.\nTarget: Write the report";

test("the verdict is about the goal that applies NOW — deleted in the middle of a run: no verdict; changed during the verdict: it lapses", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForQuiet }) => {
    const url = `${base}/api/chats/${chat.id}`;
    const patch = (body) => json(url, { method: "PATCH", body: JSON.stringify(body) });

    // Deleted while the run is running: the run began with the goal (`chat` from the start of the run still carries it).
    await patch({ goal: "Write the report" });
    await json(`${url}/message`, { method: "POST", body: JSON.stringify({ text: "WITH-GATE please work" }) });
    await gate.reached("main");
    await patch({ goal: "" });
    gate.open("main");
    await waitForQuiet();
    assert.equal(mainTurns(root).length, 1, `no continuation: ${JSON.stringify(mainTurns(root))}`);
    assert.equal(mainTurns(root)[0].target, true, "the run began with the goal in the system prompt");
    assert.equal(verdicts(root).length, 0, "nobody judges a deleted goal");
    assert.deepEqual(targetRows(await json(`${url}/log`)), [], "no \"continuing\" row for a goal that no longer exists");

    // Changed while the judge judges: its verdict is about the old goal — it lapses, the new one stays untouched (not
    // continued with the old verdict, and an "achieved" would have cleared it).
    await patch({ goal: "JUDGE-GATE: the old goal" });
    await json(`${url}/message`, { method: "POST", body: JSON.stringify({ text: "Second question" }) });
    await gate.reached("judge");
    await patch({ goal: "The new goal" });
    gate.open("judge");
    await waitForQuiet();
    assert.equal(mainTurns(root).length, 2, `no continuation with the verdict about the old goal: ${JSON.stringify(mainTurns(root))}`);
    assert.equal(verdicts(root).length, 1, "the judge ran (it had been called already)");
    assert.deepEqual(targetRows(await json(`${url}/log`)), [], "its verdict lapsed without a row");
    const c = await json(url);
    assert.deepEqual([c.goal, c.goalPaused], ["The new goal", false], "the new goal stays untouched");
  }, { claude: fake });
});

test("pause while the goal gate waits for a compaction — no \"continuing\" row, no continuation", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForTruthy, waitForQuiet }) => {
    const url = `${base}/api/chats/${chat.id}`;
    const patch = (body) => json(url, { method: "PATCH", body: JSON.stringify(body) });
    await patch({ goal: "JUDGE-GATE: write the report" });
    fs.writeFileSync(path.join(root, "compact-gate"), "1");

    await json(`${url}/message`, { method: "POST", body: JSON.stringify({ text: "First question" }) });
    await gate.reached("judge"); // the turn is over, the judge is judging
    // A compaction begins in the verdict window — in operation a parked compact row at its reset (fireAutoContinueInner asks only
    // `running`); the route /compact rejects the window. It waits at the gate "compact".
    const compaction = compactChatContext(store.getChat(chat.id));
    await gate.reached("compact");
    gate.open("judge"); // "open" — the gate wants to continue and waits for the end of the compaction
    // The verdict is there when only the compaction oneshot is still running (providers/index.js running oneshots — counted up to
    // the finally of runOnce; from there the gate runs to its wait loop without another tick).
    await waitForTruthy(async () => ((await json(`${base}/api/runs/active`)).open.oneshots === 1 ? true : null), "only the compaction oneshot is still running");
    await patch({ goalPaused: true });
    gate.open("compact");
    const v = await compaction;
    assert.equal(v.ok, true, `the compaction ran through: ${JSON.stringify(v)}`);
    await waitForQuiet();

    assert.equal(mainTurns(root).length, 1, `no continuation: ${JSON.stringify(mainTurns(root))}`);
    assert.equal(verdicts(root).length, 1);
    assert.deepEqual(targetRows(await json(`${url}/log`)), [], "no \"continuing\" row — nothing was continued");
    const c = await json(url);
    assert.deepEqual([c.goal, c.goalPaused], ["JUDGE-GATE: write the report", true]);
  }, { claude: fake });
});

test("parked goal gate continuation — paused it does not start at the reset, the row is dropped with a history line; without pause the reset continues", async () => {
  await withoutAccount(() => withAgentsServer(async ({ base, chat, root, waitForQuiet }) => {
    const url = `${base}/api/chats/${chat.id}`;
    const patch = (body) => json(url, { method: "PATCH", body: JSON.stringify(body) });
    // A turn "still open" → the judge says "open" → the continuation fails at the limit and parks (reset in an hour).
    const parkResumption = async (question) => {
      fs.rmSync(path.join(root, "limit-seen"), { force: true });
      await json(`${url}/message`, { method: "POST", body: JSON.stringify({ text: question }) });
      await waitForQuiet(); // a wait row is no open work (it waits for a clock)
      const row = store.getPendingResume(chat.id);
      if (!row) assert.fail(`the continuation does not wait at the limit — turns ${JSON.stringify(mainTurns(root))}, history ${JSON.stringify(await json(`${url}/log`)).slice(0, 3000)}`);
      assert.equal(row.kind || "run", "run");
      assert.equal(row.goalDepth, 1, "the wait row carries the depth of the continuation");
      assert.match(row.prompt, /\[Target gate\]/);
    };
    await patch({ goal: "LIMIT-ONCE: write the report" });
    await parkResumption("First question");
    const parked = mainTurns(root).length;
    assert.equal(parked, 3, "the turn and the continuation that parked at the limit (attempt with session and repetition without)");

    await patch({ goalPaused: true });
    // The alarm clock at the reset (without an account there are no windows — the limit counts as over; not "try now").
    const r = await fireAutoContinue(chat.id);
    assert.equal(r.reason, "target", `the clock discards the continuation: ${JSON.stringify(r)}`);
    await waitForQuiet();
    assert.equal(mainTurns(root).length, parked, `no continuation ran at the reset: ${JSON.stringify(mainTurns(root))}`);
    assert.ok(!store.getPendingResume(chat.id), "the wait row is gone");
    assert.equal((await json(`${url}/auto-continue`)).wait ?? null, null, "no wait strip any more");
    const lz = limitRows(await json(`${url}/log`));
    assert.ok(!lz.some((l) => l.kind === "resume"), `no "limit reset — the run is continued" row: ${JSON.stringify(lz)}`);
    assert.equal(lz.at(-1)?.kind, "cancel", JSON.stringify(lz));
    assert.match(lz.at(-1)?.text || "", /Das Ziel ruht|goal is paused/);
    let c = await json(url);
    assert.deepEqual([c.goal, c.goalPaused], ["LIMIT-ONCE: write the report", true], "goal and pause stand");

    // Counter-test without pause: the same situation, the reset continues, the continuation finishes, the judge clears the goal.
    await patch({ goalPaused: false });
    await parkResumption("Second question");
    const prior = mainTurns(root).length;
    const r2 = await fireAutoContinue(chat.id);
    assert.equal(r2.ok, true, `without pause the clock starts: ${JSON.stringify(r2)}`);
    await waitForQuiet();
    const turns = mainTurns(root);
    assert.equal(turns.length, prior + 1, `without pause the continuation ran: ${JSON.stringify(turns)}`);
    assert.match(turns.at(-1).text, /\[Target gate\]/);
    c = await json(url);
    assert.deepEqual([c.goal, c.goalPaused], ["", false], "the continuation finished, the judge cleared the goal");
  }, { claude: fake }));
});

test("a continuation interrupted by a restart (active_runs) does not start again with a resting goal — otherwise it does", async () => {
  await withAgentsServer(async ({ base, chat, root, waitForQuiet }) => {
    const url = `${base}/api/chats/${chat.id}`;
    const patch = (body) => json(url, { method: "PATCH", body: JSON.stringify(body) });
    // This is how a restart in the middle of the continuation leaves the chat: its active_runs row (do-run.js setActiveRun). The
    // harness switches off the follow-up start (CBASE_RESTART_GRACE_MS) — the test calls it itself.
    const interrupted = () => store.setActiveRun(chat.id, { kind: "chat", prompt: RESUMPTION, goalDepth: 1, startedAt: Date.now() });

    await patch({ goal: "Write the report", goalPaused: true });
    interrupted();
    resumeInterruptedWork();
    await waitForQuiet();
    assert.equal(mainTurns(root).length, 0, "no restart");
    assert.ok(!store.listActiveRuns().some((x) => x.chatId === chat.id), "the active_runs row is gone");
    let log = await json(`${url}/log`);
    assert.ok(log.some((z) => z.role === "hint" && /nicht wieder aufgenommen|not resumed/.test(z.text)), "a separator says why");
    assert.ok(!log.some((z) => z.role === "meta" && /"resumed"/.test(z.text)), "no \"resumed\" marker");
    assert.equal((await json(`${base}/api/runs/active`)).runs, 0);

    // Counter-test: the same row without pause starts again — the continuation finishes, the judge clears the goal.
    await patch({ goalPaused: false });
    interrupted();
    resumeInterruptedWork();
    await waitForQuiet();
    const turns = mainTurns(root);
    assert.equal(turns.length, 1, `without pause: restart: ${JSON.stringify(turns)}`);
    assert.match(turns[0].text, /\[Target gate\]/);
    log = await json(`${url}/log`);
    assert.ok(log.some((z) => z.role === "meta" && /"resumed"/.test(z.text)), "with the \"resumed\" marker");
    const c = await json(url);
    assert.deepEqual([c.goal, c.goalPaused], ["", false]);
  }, { claude: fake });
});

test("doRun itself does not let the continuation of a resting goal begin — every way, also one without its own check", async () => {
  await withAgentsServer(async ({ base, chat, root, waitForQuiet }) => {
    const url = `${base}/api/chats/${chat.id}`;
    const patch = (body) => json(url, { method: "PATCH", body: JSON.stringify(body) });
    await patch({ goal: "Write the report", goalPaused: true });
    // A caller without its own check (clock and restart ask themselves, the gate right before its doRun).
    await doRun(store.getChat(chat.id), RESUMPTION, { goalDepth: 1 });
    await waitForQuiet();
    assert.equal(mainTurns(root).length, 0, "the continuation did not begin");
    const active = await json(`${base}/api/runs/active`);
    assert.deepEqual([active.runs, active.busy], [0, false], "and the chat is not shown as running");
    assert.ok(!store.listActiveRuns().some((x) => x.chatId === chat.id), "no active_runs row");
    // Counter-test in the same chat: an ordinary run (goalDepth 0) begins — just without the resting goal in the system prompt.
    await doRun(store.getChat(chat.id), "First question", {});
    await waitForQuiet();
    assert.deepEqual(mainTurns(root).map((t) => [t.text, t.target]), [["First question", false]]);
  }, { claude: fake });
});

test("if a PATCH changes goal or pause, harness/target goes to EVERY reader of the chat — nothing without a change", async () => {
  await withAgentsServer(async ({ base, chat, barrier, waitForTruthy }) => {
    const url = `${base}/api/chats/${chat.id}`;
    const patch = (body) => json(url, { method: "PATCH", body: JSON.stringify(body) });
    const a = await openStream(`${url}/stream`, waitForTruthy);
    const b = await openStream(`${url}/stream`, waitForTruthy);
    try {
      await a.wait((e) => e.subtype === "connected", "reader a connected");
      await b.wait((e) => e.subtype === "connected", "reader b connected");
      const targets = (s) => s.events.filter((e) => e.type === "harness" && e.subtype === "target");
      const state = (s) => targets(s).map((e) => [e.goal, e.goalPaused]);
      const both = async () => { await barrier(a); await barrier(b); };

      await patch({ goal: "Write the report" });
      await patch({ goalPaused: true });
      await both();
      const expected = [["Write the report", false], ["Write the report", true]];
      for (const s of [a, b]) assert.deepEqual(state(s), expected, "both readers: set, then paused");
      assert.deepEqual(Object.keys(targets(a)[0]).sort(), ["goal", "goalPaused", "subtype", "type"], "exactly the fields of the contract");

      // Without a change of goal or pause: no event — a foreign field, the same value once more, a 400.
      await patch({ pinned: true });
      await patch({ title: "Renamed" });
      await patch({ goalPaused: true });
      assert.equal((await response(url, { method: "PATCH", body: JSON.stringify({ goalPaused: "yes" }) })).status, 400);
      await both();
      for (const s of [a, b]) assert.deepEqual(state(s), expected, "no event without a change");

      // The same goal once more cancels the pause (a change), resuming, clearing — each with the state of the row.
      await patch({ goal: "Write the report" });
      await patch({ goal: "Another goal", goalPaused: true });
      await patch({ goalPaused: false });
      await patch({ goal: "" });
      await both();
      const afterwards = [...expected, ["Write the report", false], ["Another goal", true], ["Another goal", false], ["", false]];
      for (const s of [a, b]) assert.deepEqual(state(s), afterwards);
    } finally {
      await a.shutdown();
      await b.shutdown();
    }
  }, { claude: fake });
});
