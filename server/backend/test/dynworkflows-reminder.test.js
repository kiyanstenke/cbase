// Ultracode reminders and the guide for writing workflows (server/backend/electron/server/dynworkflows/reminder.js,
// guide.md, the setter runs/do-run.js setTurnPreamble and the queue hand-over runs/queue.js injectNextRunInput). Main seam
// with the agent harness: real server, real cbase MCP server, real routes; only the provider is faked. Proven at the fake
// Claude's prompt log — what the main agent gets as a user message per turn, and that none of it is in its arguments
// (system prompt).
//
// Counter-tests (which sabotage turns which test red):
//   - in reminder.js replace `humanFrom(inputs)` by all inputs (counting over all turns) => "cadence" falls (the completion,
//     channel and schedule turns get the reminder and shift the tight one);
//   - drop `setTurnPreamble(ultracodePreamble)` in server.js => "cadence", "routes", "keyword" and "restart" fall;
//   - leave out the preamble in queue.js injectNextRunInput => "bundle" falls.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import { FINISHED_MARKER } from "../electron/server/runs/completionNotice.js";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import * as store from "../electron/server/store.js";
import {
  GUIDE_FILE, REMINDER_OFF, REMINDER_TIGHT, REMINDER_TICK, REMINDER_FULL, KEYWORD_SET, guideText, reminderStep,
} from "../electron/server/dynworkflows/reminder.js";
import { startScript } from "../electron/server/dynworkflows/sandbox.js";
import { CATALOG_NAMES } from "../electron/mcp/catalog.js";

// ── The count alone ─────────────────────────────────────────────────────────────────────────────────────────────
test("count: full at the first user turn in the mode, tight after every ten more, off notice only after an on notice", () => {
  let s = { reported: 0, turns: 0 };
  const kinds = [];
  for (let i = 0; i < 25; i++) { const r = reminderStep({ enabled: true, ...s }); kinds.push(r.kind); s = r.fresh; }
  assert.equal(REMINDER_TICK, 10);
  assert.deepEqual(kinds.map((a, i) => (a ? `${i}:${a}` : null)).filter(Boolean), ["0:full", "10:tight", "20:tight"]);
  const out = reminderStep({ enabled: false, ...s });
  assert.deepEqual([out.kind, out.fresh], ["off", { reported: 0, turns: 0 }]);
  assert.equal(reminderStep({ enabled: false, ...out.fresh }).kind, null, "only ONE off notice");
  assert.equal(reminderStep({ enabled: false, reported: 0, turns: 0 }).kind, null, "a chat that was never on hears nothing");
  assert.equal(reminderStep({ enabled: true, ...out.fresh }).kind, "full", "switched on again: the full one again");
});

// ── The guide: versioned, cbase tools, runnable examples ──────────────────────────────────────────
const GUIDE_RAW = fs.readFileSync(GUIDE_FILE, "utf8");

test("guide: names the reference version, explains only tools that exist, and goes to the model without comments", () => {
  assert.match(GUIDE_RAW, /^<!-- Reference-Version: \d+\.\d+\.\d+ -->$/m, "stamp for the follow-along guard");
  const text = guideText();
  assert.ok(!text.includes("<!--") && !text.includes("Reference-Version"), "origin and stamp do not go to the model");
  const named = [...new Set(text.match(/\bcbase_[a-z_]+/g))];
  assert.ok(named.includes("cbase_dynamic_workflow"), "the tool is named as it is named in cbase");
  for (const n of named) assert.ok(CATALOG_NAMES.includes(n), `${n} is not a tool of the cbase MCP server`);
  assert.ok(!/Workflow tool|\bWorkflow\(|\bAgent tool\b|\/workflows|ToolSearch/.test(text), "no Claude Code tools that do not exist in cbase");
  // The marker of a completion notice is not in it: a reader looking for it in the text would otherwise take a user turn
  // with the guide for a report (the fakes of dynworkflows-approval.test.js depend on that).
  assert.ok(!text.includes(FINISHED_MARKER), "no <task-notification> in the guide");
  assert.match(text, /provider::model/);
  assert.match(text, /`repo`/);
});

// The smallest valid value from a schema: every list with ONE entry ("up to ten" loops end that way), booleans true.
function exampleValue(s) {
  if (!s || typeof s !== "object") return "x";
  if (s.type === "object") return Object.fromEntries(Object.entries(s.properties || {}).map(([k, v]) => [k, exampleValue(v)]));
  if (s.type === "array") return [exampleValue(s.items)];
  if (s.type === "boolean") return true;
  if (s.type === "number" || s.type === "integer") return 1;
  return "x";
}
// What the guide's snippets presuppose (they say so: "stand there as constants of their own").
const SCHEMA_FINDINGS = { type: "object", properties: { findings: { type: "array", items: { type: "object", properties: { title: { type: "string" }, file: { type: "string" } }, required: ["title", "file"] } } }, required: ["findings"] };
const ENVIRONMENT = {
  values: {
    DIMENSIONS: [{ key: "bugs", prompt: "Find bugs." }, { key: "perf", prompt: "Find perf problems." }],
    FINDINGS_SCHEMA: SCHEMA_FINDINGS,
    VERDICT_SCHEMA: { type: "object", properties: { isReal: { type: "boolean" } }, required: ["isReal"] },
    BUGS_SCHEMA: { type: "object", properties: { bugs: { type: "array", items: { type: "string" } } }, required: ["bugs"] },
  },
};

const EXAMPLES = [...GUIDE_RAW.matchAll(/^([ \t]*)```javascript\n([\s\S]*?)^[ \t]*```$/gm)].map((m) => m[2].split("\n").map((z) => z.slice(m[1].length)).join("\n"));

test("guide: every code example runs in the sandbox without parse and runtime errors", async () => {
  assert.ok(EXAMPLES.length >= 8, `too few examples found (${EXAMPLES.length}) — the search itself would otherwise be green`);
  for (const [i, code] of EXAMPLES.entries()) {
    const script = code.trimStart().startsWith("export const meta");
    const calls = [];
    const run = startScript({
      ...(script ? { script: code } : { body: code, exampleEnvironment: ENVIRONMENT }),
      host: { agent: (a) => { calls.push(a.prompt); return a.opts?.schema ? exampleValue(a.opts.schema) : `Text ${a.n}`; } },
    });
    try {
      const r = await run.end;
      assert.equal(r.ok, true, `example ${i + 1}: ${r.error?.kind}: ${r.error?.text}\n${code}`);
      assert.deepEqual(r.failures, [], `example ${i + 1}: no branch may die silently`);
    } finally { run.abort(); }
  }
});

// ── The main seam ──────────────────────────────────────────────────────────────────────────────────────────────────
// The main agent stores its user message per turn and whether its arguments (system prompt) carry any of it.
const MAIN = `
  fs.appendFileSync(path.join(LOCATION, "prompts.jsonl"), JSON.stringify({ text, sys: /cbase-ultracode|Ultracode is/.test(joined) }) + "\\n");
  const gateName = (String(text).match(/GATE:(\\w+)/) || [])[1];
  if (gateName) await gate(gateName);
  say({ type: "assistant", message: { id: "c-" + turn + "-" + Date.now(), content: [{ type: "text", text: "ok" }] } });
  finished();
  say({ type: "result", result: "ok", session_id: "main-session" });`;
const claude = fakeClaude({ main: MAIN, sub: "finished();" });

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const patch = (url, body) => json(url, { method: "PATCH", body: JSON.stringify(body) });
// The fakes (child processes) write the logs while the test reads — only completed lines (jsonl.mjs).
const prompts = (root) => readJsonl(path.join(root, "prompts.jsonl"));
// What a user message carries: the kind of reminder, plus "+guide" (guide) and "+word" (keyword sentence).
function kind(t) {
  const a = t.includes(REMINDER_FULL) ? "full" : t.includes(REMINDER_TIGHT) ? "tight" : t.includes(REMINDER_OFF) ? "off" : "";
  return a + (t.includes("<cbase-ultracode-guide>") ? "+guide" : "") + (t.includes(KEYWORD_SET) ? "+word" : "") || "-";
}
// A turn from the human's hand or from another cause — each until idle.
async function human(ctx, chatId, text) {
  await post(`${ctx.base}/api/chats/${chatId}/message`, { text });
  await ctx.waitForIdle();
}
async function other(ctx, chatId, cause, text) {
  const prompt = cause === "agent" ? `${FINISHED_MARKER}${text}` : text;
  deliverUserPrompt(store.getChat(chatId), { prompt, display: prompt, cause });
  await ctx.waitForTruthy(() => prompts(ctx.root).some((p) => p.text.includes(text)), `turn ${cause}`);
  await ctx.waitForIdle();
}
async function inMode(ctx, chatId) {
  await patch(`${ctx.base}/api/chats/${chatId}`, { model: "claude-sonnet-5" }); // Haiku 4.5 has no grades, so no mode
  // Exactly the body that web (chat/chatModelChoice.ts pickEffort) sends for the picker AND `/effort ultracode`.
  await patch(`${ctx.base}/api/chats/${chatId}`, { ultracode: true });
  assert.equal(store.getChat(chatId).ultracode, true, "the mode is set");
}
// The kinds of the turns, in order.
const kindsFrom = (root, from = 0) => prompts(root).slice(from).map((p) => { assert.equal(p.sys, false, "none of it in the system prompt"); return kind(p.text); });

test("cadence: full reminder with guide, tight one in the tenth user turn after, off notice — completion, channel and schedule turns scattered between do not count and get nothing", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat, root } = ctx;
    await human(ctx, chat.id, "Before, without mode");
    await inMode(ctx, chat.id);
    const desired = [];
    for (let i = 0; i < 12; i++) {
      await human(ctx, chat.id, `User ${i}`);
      desired.push(i === 0 ? "full+guide" : i === 10 ? "tight" : "-");
      if (i === 1 || i === 5 || i === 9) {
        for (const cause of ["agent", "channel", "schedule"]) { await other(ctx, chat.id, cause, `${cause} after ${i}`); desired.push("-"); }
      }
    }
    await patch(`${ctx.base}/api/chats/${chat.id}`, { ultracode: false });
    await other(ctx, chat.id, "channel", "Channel after switching off");
    desired.push("-");
    await human(ctx, chat.id, "After switching off");
    desired.push("off");
    await human(ctx, chat.id, "One more");
    desired.push("-");
    assert.deepEqual(kindsFrom(root), ["-", ...desired]);
    const texts = prompts(root).map((p) => p.text);
    assert.ok(texts[1].startsWith("<cbase-ultracode>") && texts[1].endsWith("\n\n---\n\nUser 0"), "the reminder stands before what was typed, separated by the divider (like the silent hints)");
  }, { claude });
});

test("routes: the reminder hangs on the stored mode — creating a chat in the mode triggers it just like the PATCH", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws, root } = ctx;
    // The body that web sends for a new chat with ultracode preselected (chatModelChoice.ts effortForCreation).
    const fresh = await post(`${base}/api/chats`, { workspaceId: ws.id, provider: "claude", model: "claude-sonnet-5", effort: "high", ultracode: true, permissionMode: "bypassPermissions" });
    await patch(`${base}/api/chats/${fresh.id}`, { title: "Fresh" });
    assert.equal(store.getChat(fresh.id).ultracode, true);
    await human(ctx, fresh.id, "First");
    await human(ctx, fresh.id, "Second");
    assert.deepEqual(kindsFrom(root), ["full+guide", "-"]);
    // Off and on again BETWEEN two turns: no notice, as in the reference (last reported is "on").
    await patch(`${base}/api/chats/${fresh.id}`, { ultracode: false });
    await patch(`${base}/api/chats/${fresh.id}`, { ultracode: true });
    await human(ctx, fresh.id, "Third");
    assert.deepEqual(kindsFrom(root, 2), ["-"]);
    // With the chat its state falls.
    assert.equal(store.readUltracodeReminder(fresh.id).reported, 1);
    await json(`${base}/api/chats/${fresh.id}`, { method: "DELETE" });
    assert.deepEqual(store.readUltracodeReminder(fresh.id), { reported: 0, turns: 0 });
  }, { claude });
});

test("keyword: \"ultracode\" in a human message loads the guide for exactly this turn — the same word in channel, schedule, event and completion notice loads nothing", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat, root } = ctx;
    await human(ctx, chat.id, "Please check with ultracode");
    await human(ctx, chat.id, "And now without");
    for (const cause of ["channel", "schedule", "event", "agent"]) await other(ctx, chat.id, cause, `Please ultracode (${cause}).`);
    assert.deepEqual(kindsFrom(root), ["+guide+word", "-", "-", "-", "-", "-"]);
    assert.equal(store.getChat(chat.id).ultracode, false, "the chat was never in the mode");
  }, { claude });
});

test("bundle: a user turn that begins at the queue hand-over carries the reminder — two bundled messages are ONE turn", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, gate } = ctx;
    await inMode(ctx, chat.id);
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Lead-in GATE:v" });
    await gate.reached("v");
    const two = await post(`${base}/api/chats/${chat.id}/message`, { text: "Second" });
    const three = await post(`${base}/api/chats/${chat.id}/message`, { text: "Third" });
    assert.equal(two.queued && three.queued, true, "both wait behind the running turn");
    gate.open("v");
    await ctx.waitForTruthy(() => prompts(root).length >= 2, "the injected turn");
    await ctx.waitForIdle();
    const p = prompts(root);
    assert.equal(p.length, 2, "lead-in and ONE bundle turn");
    assert.ok(p[1].text.includes("Second") && p[1].text.includes("Third"));
    assert.deepEqual(kindsFrom(root), ["full+guide", "-"], "the full one came with the lead-in; the bundle counts once");
    assert.deepEqual(store.readUltracodeReminder(chat.id), { reported: 1, turns: 1 });
  }, { claude });
});

test("restart: the counter is in the database — the tight reminder comes in the right turn after the restart, not from zero again", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat, root } = ctx;
    await inMode(ctx, chat.id);
    for (let i = 0; i < 6; i++) await human(ctx, chat.id, `Before restart ${i}`);
    await ctx.restart();
    for (let i = 0; i < 6; i++) await human(ctx, chat.id, `After restart ${i}`);
    assert.deepEqual(kindsFrom(root), ["full+guide", "-", "-", "-", "-", "-", "-", "-", "-", "-", "tight", "-"]);
  }, { claude });
});
