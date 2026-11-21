// The prefixes at the beginning of a session after a compaction. What cbase puts before the input only once per session — the agenda
// block (runs/agenda-block.js) and the full ultracode reminder with its guide (dynworkflows/reminder.js) — hangs on ONE question in
// runs/do-run.js (`preambleResumed`): does the context of this turn still carry the session's beginning? Before, the ultracode
// reminder counted per CHAT (`reported` stayed 1 forever after the first full one — measured on three main chats with 11–13
// compactions), and a compaction by the PROVIDER in the middle of a resumed session was seen by neither. Plus two findings of the
// same check: the chain of summaries (the next compaction did not know the previous one) and a summary that stayed on the chat
// after an aborted first turn.
//
// Counter-tests (each shown red once):
//   - reminder.js reminderStep: `|| !resumed` removed                                          => "Count", "Claude", "Bundle", "Retry" red
//   - do-run.js: `!hints.compacted &&` removed                                                 => "Claude", "Bundle", "Codex" red
//   - do-run.js handleRunEvent: the line with isProviderCompaction removed                     => "Claude", "Bundle", "Codex" red
//   - do-run.js injectionPreamble: `!runCompacted.has(chatId)` replaced by `true`              => "Bundle" red
//   - do-run.js resume retry: `preambleResumed ? null : turnPreambleText` replaced by `turnPreambleText` => "Retry" red
//   - codex.js: the call of codexCompactedFrom at process end removed                          => "Codex" red
//   - post-run.js: `previous` not prepended                                                    => "Chain" red
//   - do-run.js abort: `...(injectSummary ? { contextSummary: "" } : {})` removed              => "Abort" red

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fakeClaude, fakeCodex, json, withAgentsServer } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import * as store from "../electron/server/store.js";
import { REMINDER_OFF, REMINDER_TIGHT, REMINDER_FULL, reminderStep } from "../electron/server/dynworkflows/reminder.js";
import { COMPACTION_TEXT, isProviderCompaction } from "../electron/server/runs/hints.js";
import { codexRolloutSize, codexCompactedFrom } from "../electron/server/providers/connectors/codex.js";

// ── The rule alone ─────────────────────────────────────────────────────────────────────────────────────────────────────
test("Count: without a resumed session the full reminder comes again in the mode — even if the chat already got it", () => {
  assert.equal(reminderStep({ enabled: true, reported: 1, turns: 4 }).kind, null, "resumed: only counted");
  assert.deepEqual(reminderStep({ enabled: true, reported: 1, turns: 4, resumed: false }), { kind: "full", fresh: { reported: 1, turns: 0 } });
  assert.deepEqual(reminderStep({ enabled: true, reported: 1, turns: 9, resumed: false }).kind, "full", "not the tight one — the new context does not know it");
  assert.equal(reminderStep({ enabled: false, reported: 1, turns: 4, resumed: false }).kind, "off", "the off notice stays as it was");
  assert.equal(reminderStep({ enabled: false, reported: 0, turns: 0, resumed: false }).kind, null);
});

test("Event: compact_boundary (Claude, Codex) and harness/compacted (loop engine) of the main stream are compactions, nothing else", () => {
  assert.equal(isProviderCompaction({ type: "system", subtype: "compact_boundary", session_id: "s", compact_metadata: { trigger: "auto", pre_tokens: 1 } }), true);
  assert.equal(isProviderCompaction({ type: "system", subtype: "compact_boundary", session_id: "s", source: "codex" }), true);
  assert.equal(isProviderCompaction({ type: "harness", subtype: "compacted", chars: 10 }), true);
  assert.equal(isProviderCompaction({ type: "system", subtype: "compact_boundary", parent_tool_use_id: "toolu_1" }), false, "a subagent is not the main stream");
  for (const e of [{ type: "system", subtype: "init" }, { type: "system", subtype: "microcompact_boundary" }, { type: "harness", subtype: "compacting" }, null]) {
    assert.equal(isProviderCompaction(e), false, JSON.stringify(e));
  }
});

test("Codex rollout: a compaction counts only in the growth since the process start — compacted and context_compacted", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-session-beginning-codex-"));
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const id = "019a0000-0000-7000-8000-00000000abcd";
    const file = path.join(home, "sessions", "2026", "11", "04", `rollout-2026-11-04T00-00-00-${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const row = (o) => fs.appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...o })}\n`);
    row({ type: "session_meta", payload: { id } });
    // A QUOTE of the word in the text is no compaction (it stands escaped in the row).
    row({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "{\"type\":\"compacted\"} context_compacted" }] } });
    assert.equal(codexCompactedFrom(id, null, 0), false, "a quote does not count");
    const a = codexRolloutSize(id);
    row({ type: "event_msg", payload: { type: "context_compacted" } });
    assert.equal(codexCompactedFrom(id, null, a), true, "context_compacted in the growth");
    const b = codexRolloutSize(id);
    row({ type: "turn_context", payload: {} });
    assert.equal(codexCompactedFrom(id, null, b), false, "a compaction BEFORE the start of this process does not count again");
    const c = codexRolloutSize(id);
    row({ type: "compacted", payload: { message: "", replacement_history: [] } });
    assert.equal(codexCompactedFrom(id, null, c), true, "compacted in the growth");
    assert.equal(codexCompactedFrom("other-thread", null, 0), false, "without a rollout: nothing");
  } finally {
    if (prior === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── The main seam ──────────────────────────────────────────────────────────────────────────────────────────────────────
// The main agent stores its input per turn; "VERDICHTE" (the marker the harness fakes recognise) makes it compact in the middle of the turn like the CLI (compact_boundary in
// stream-json), "GATE:x" holds it at a gate; a resumed session "way" ends like a lost one (exit 1, no result) — then doRun runs the
// resume retry without a session.
const MAIN = `
  if (arg("--resume") === "way") process.exit(1);
  fs.appendFileSync(path.join(LOCATION, "prompts.jsonl"), JSON.stringify({ text, resume: arg("--resume") }) + "\\n");
  say({ type: "system", subtype: "init", session_id: "main-session" }); // like the CLI: the session is fixed from the start
  if (String(text).includes("VERDICHTE")) say({ type: "system", subtype: "compact_boundary", session_id: "main-session", uuid: "cb-" + turn, compact_metadata: { trigger: "auto", pre_tokens: 970484, post_tokens: 11527 } });
  const gateName = (String(text).match(/GATE:(\\w+)/) || [])[1];
  if (gateName) await gate(gateName);
  say({ type: "assistant", message: { id: "c-" + turn + "-" + Date.now(), content: [{ type: "text", text: "ok" }] } });
  finished();
  say({ type: "result", result: "ok", session_id: "main-session" });`;
// Oneshots: the compaction (cbase) answers with a numbered summary, everything else (title) with "Title".
const ONESHOT = `
  const list = path.join(LOCATION, "oneshots.jsonl");
  const prior = fs.existsSync(list) ? fs.readFileSync(list, "utf8").split("\\n").filter((z) => z.includes("You are compacting")).length : 0;
  fs.appendFileSync(list, JSON.stringify({ prompt }) + "\\n");
  respond(prompt.includes("You are compacting") ? "SUMMARY-" + (prior + 1) : "Title");`;
const claude = fakeClaude({ main: MAIN, oneshot: ONESHOT });

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body ?? {}) });
const patch = (url, body) => json(url, { method: "PATCH", body: JSON.stringify(body) });
const prompts = (root) => readJsonl(path.join(root, "prompts.jsonl"));
const compactionPrompts = (root) => readJsonl(path.join(root, "oneshots.jsonl")).map((o) => o.prompt).filter((p) => p.includes("You are compacting"));
// What an input carries: kind of the ultracode reminder (+guide), agenda block (+agenda), compaction hint (+hint).
// The agenda block at the CLOSING fence: the fixed sentence in the system prompt names the opening marker, and with Codex it stands in the input's prefix.
function kind(t) {
  const a = t.includes(REMINDER_FULL) ? "full" : t.includes(REMINDER_TIGHT) ? "tight" : t.includes(REMINDER_OFF) ? "off" : "";
  return (a + (t.includes("<cbase-ultracode-guide>") ? "+guide" : "") + (t.includes("</cbase-agenda>") ? "+agenda" : "")
    + (t.includes(COMPACTION_TEXT) ? "+hint" : "")) || "-";
}
async function human(ctx, chatId, text) {
  await post(`${ctx.base}/api/chats/${chatId}/message`, { text });
  await ctx.waitForTruthy(() => prompts(ctx.root).some((p) => p.text.endsWith(text)), `input "${text}"`);
  await ctx.waitForIdle();
  return prompts(ctx.root).filter((p) => p.text.endsWith(text)).at(-1);
}
async function inModeWithAgenda(ctx, chatId) {
  await patch(`${ctx.base}/api/chats/${chatId}`, { model: "claude-sonnet-5" }); // Haiku 4.5 carries no grades, so no mode
  await patch(`${ctx.base}/api/chats/${chatId}`, { ultracode: true });
  assert.equal(store.getChat(chatId).ultracode, true);
  await json(`${ctx.base}/api/chats/${chatId}/agenda`, { method: "PUT", body: JSON.stringify({ title: "Plan", steps: [{ op: "fresh", text: "Step one", status: "in_work" }] }) });
}

test("Claude: after compact_boundary, after /compact and after /clear agenda and full reminder with guide come again — nothing in between", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await inModeWithAgenda(ctx, chat.id);
    const queue = [];
    const turn = async (text) => { const p = await human(ctx, chat.id, text); queue.push(`${text}:${kind(p.text)}${p.resume ? "" : "+new"}`); return p; };

    await turn("One");
    await turn("Two");
    await turn("Three VERDICHTE"); // the CLI compacts in the middle of this turn
    await turn("Four"); // the same session (--resume), but compacted: the beginning comes again
    await turn("Five");
    assert.deepEqual(store.openHints(chat.id), [], "the hint is used up");

    const c1 = await post(`${base}/api/chats/${chat.id}/compact`);
    assert.equal(c1.ok, true, JSON.stringify(c1));
    const six = await turn("Six");
    // The reference message (runs/compaction-baseline.js summaryMessage) instead of an own wrapper.
    assert.ok(six.text.startsWith("This session continues an earlier conversation"), "the summary stands before it");
    await turn("Seven");

    assert.equal((await post(`${base}/api/chats/${chat.id}/clear`)).ok, true);
    await turn("Eight");
    await turn("Nine");

    assert.deepEqual(queue, [
      "One:full+guide+agenda+new",
      "Two:-",
      "Three VERDICHTE:-",
      "Four:full+guide+agenda+hint",
      "Five:-",
      "Six:full+guide+agenda+new",
      "Seven:-",
      "Eight:full+guide+agenda+new",
      "Nine:-",
    ]);
    assert.deepEqual(store.readUltracodeReminder(chat.id), { reported: 1, turns: 1 }, "the counter restarts with every full one");
  }, { claude });
});

test("Bundle: if the CLI compacts in the running process, the handed-over user turn carries the full reminder — the next run the agenda too", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, gate } = ctx;
    await inModeWithAgenda(ctx, chat.id);
    await human(ctx, chat.id, "Zero");
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Prelude VERDICHTE GATE:v" });
    await gate.reached("v");
    const two = await post(`${base}/api/chats/${chat.id}/message`, { text: "Handover" });
    assert.equal(two.queued, true, "waits behind the running turn");
    gate.open("v");
    await ctx.waitForTruthy(() => prompts(root).some((p) => p.text.endsWith("Handover")), "the handed-over turn");
    await ctx.waitForIdle();
    const afterwards = await human(ctx, chat.id, "Afterwards");
    const p = prompts(root);
    assert.equal(p.length, 4, "Zero, Prelude, ONE handed-over turn, Afterwards");
    assert.deepEqual(p.map((x) => kind(x.text)), ["full+guide+agenda", "-", "full+guide", "full+guide+agenda+hint"]);
    assert.equal(afterwards.resume, "main-session");
  }, { claude });
});

test("Retry: if the resumed session is lost, the resume retry recomputes the prefix — full reminder with agenda in the new session", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat } = ctx;
    await inModeWithAgenda(ctx, chat.id);
    await human(ctx, chat.id, "One");
    await human(ctx, chat.id, "Two");
    store.updateChat(chat.id, { claudeSessionId: "way" });
    const three = await human(ctx, chat.id, "Three");
    assert.equal(three.resume, "", "the retry runs without a session");
    assert.equal(kind(three.text), "full+guide+agenda");
    assert.deepEqual(prompts(ctx.root).map((p) => kind(p.text)), ["full+guide+agenda", "-", "full+guide+agenda"]);
  }, { claude });
});

test("Chain: the second compaction summarizes the first one too — the summary stands at its marker", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await human(ctx, chat.id, "Job A");
    await human(ctx, chat.id, "Continue B");
    assert.equal((await post(`${base}/api/chats/${chat.id}/compact`)).ok, true);
    const marker = store.listMessages(chat.id).filter((m) => m.role === "meta" && m.text.includes("\"compacted\":true")).map((m) => JSON.parse(m.text));
    assert.equal(marker.at(-1).summary, "SUMMARY-1");
    assert.doesNotMatch(compactionPrompts(root)[0], /This session continues an earlier conversation/, "the first has no previous one");
    await human(ctx, chat.id, "After the first C");
    await human(ctx, chat.id, "Still D");
    assert.equal((await post(`${base}/api/chats/${chat.id}/compact`)).ok, true);
    const second = compactionPrompts(root)[1];
    // The chain as in the reference: the message of the previous compaction is the first message of the section.
    assert.match(second, /\n\[User·[0-9a-f]+\]: This session continues an earlier conversation[^\n]*\nSUMMARY-1\n/);
    assert.ok(second.includes("After the first C") && !second.includes("Job A"), "the history since then, not the one before");
    // After /clear there is no previous one.
    assert.equal((await post(`${base}/api/chats/${chat.id}/clear`)).ok, true);
    await human(ctx, chat.id, "New E");
    await human(ctx, chat.id, "New F");
    assert.equal((await post(`${base}/api/chats/${chat.id}/compact`)).ok, true);
    assert.doesNotMatch(compactionPrompts(root)[2], /This session continues an earlier conversation|SUMMARY-/);
  }, { claude });
});

test("Abort: if the first turn after a compaction aborts, the summary is brought in with its session — it does not stay on the chat", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, gate } = ctx;
    await human(ctx, chat.id, "Job A");
    await human(ctx, chat.id, "Continue B");
    assert.equal((await post(`${base}/api/chats/${chat.id}/compact`)).ok, true);
    assert.match(store.getChat(chat.id).contextSummary, /^This session continues an earlier conversation[^\n]*\nSUMMARY-1\n/);
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Long GATE:a" });
    await gate.reached("a");
    await post(`${base}/api/chats/${chat.id}/stop`);
    await ctx.waitForIdle();
    const c = store.getChat(chat.id);
    assert.equal(c.claudeSessionId, "main-session", "the session of the aborted turn is saved");
    assert.equal(c.contextSummary, "", "and with it the summary brought in");
    const p = prompts(root).find((x) => x.text.endsWith("Long GATE:a"));
    assert.ok(p.text.includes("SUMMARY-1"), "the aborted turn carried it");
  }, { claude });
});

test("Codex: if Codex compacts in the turn (rollout), the next turn carries the agenda and the hint — the one after does not", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws, root } = ctx;
    const prior = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(root, "codex-home"); // in the throwaway folder: the fake writes rollouts like the real CLI
    try {
      const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "codex", model: "gpt-5.6-sol", permissionMode: "bypassPermissions" }) });
      await patch(`${base}/api/chats/${chat.id}`, { title: "Codex" });
      await json(`${base}/api/chats/${chat.id}/agenda`, { method: "PUT", body: JSON.stringify({ title: "Plan", steps: [{ op: "fresh", text: "Step one", status: "in_work" }] }) });
      // The inputs stand verbatim in the rollout (response_item message role user).
      const inputs = () => {
        const out = [];
        const go = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) go(p); else if (e.name.endsWith(".jsonl")) out.push(...readJsonl(p)); } };
        go(path.join(root, "codex-home", "sessions"));
        return out.filter((z) => z.type === "response_item" && z.payload?.role === "user").map((z) => z.payload.content[0].text);
      };
      let n = 0;
      const turn = async (text) => {
        await post(`${base}/api/chats/${chat.id}/message`, { text });
        n += 1;
        await ctx.waitForLog(chat.id, (log) => log.filter((m) => m.role === "assistant").length >= n);
        await ctx.waitForIdle();
        const t = inputs().filter((e) => e.endsWith(text)).at(-1);
        assert.ok(t, `input "${text}" in the rollout`);
        return kind(t);
      };
      assert.deepEqual([await turn("One"), await turn("Two VERDICHTE"), await turn("Three"), await turn("Four")], ["+agenda", "-", "+agenda+hint", "-"]);
    } finally {
      if (prior === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior;
    }
  }, { claude, codex: fakeCodex() });
});
