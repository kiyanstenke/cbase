// cbase's compaction, modelled on Claude Code's behaviour with cbase's own wording — the guard.
//
// What it holds:
//   1. The shape of the request and the message: prelude, nine sections, optional addition, postscript; the safety and user
//      sentence in place; the note on a truncated head and the mask of the file call. (The numbers and the review state against
//      the measured reference are checked privately, outside this tree.)
//   2. The pure building blocks: rounds, truncation on "Prompt is too long" (gap / 20 % / at least one / never all / marker),
//      formatting, message, attachments (file selection, budget, reference, skills, background status).
//   3. The real path through the server (fake Claude, fake OpenRouter): /compact with instruction, the last round stays verbatim,
//      three retries after "Prompt is too long" (the fourth failure gives up, nothing is written), the attachments in the first
//      turn afterwards — and only there —, the chain (the previous compaction's files stay), the same for the loop engine.
//
// Counter-tests (which sabotage turns which test red):
//   - PTL_ATTEMPTS 3 -> 2 in compaction-baseline.js => "three retries" red (the fourth call is missing).
//   - JOB with eight sections => "Shape" red.
//   - post-run.js without `keep` (toSummarize = messages) => "/compact ... last round verbatim" red.
//   - do-run.js without `attachment` in rawInput => "Attachments in the first turn" red (Claude) and "Loop engine" red.
//   - FILE_CALL without the mask => "Shape" red (mask).
//   - post-run.js with `headerTruncated: !auto && raw.truncated` => "Auto compaction ... says the head is missing" red.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import * as store from "../electron/server/store.js";
import * as v from "../electron/server/runs/compaction-baseline.js";
import { compactChatContext } from "../electron/server/runs/post-run.js";
import { attachmentRefs, fileAttachments, backgroundTexts, withLineNumbers, skillAttachment } from "../electron/server/runs/compaction-attachments.js";

const count = (re, t) => (t.match(re) || []).length;

// ── 1. The shape of the request and the message ───────────────────────────────────────────────────────────────────────────────
test("Shape: the job is prelude + nine sections + optional addition + postscript; safety and user sentence in place; note and mask", () => {
  assert.ok(v.PRELUDE("FORM").includes("FORM.\n\n"), "prelude: the response form closes it");
  assert.ok(v.ANALYSIS.includes(`\n   - ${v.SAFETY}\n2. `), "analysis: the safety sentence is the last point of 1.");
  for (let i = 1; i <= 9; i++) assert.match(v.JOB, new RegExp(`^${i}\\. `, "m"), `section ${i}`);
  assert.ok(v.JOB.includes(v.ANALYSIS), "the job carries the analysis");
  assert.ok(v.JOB.includes(v.ONLY_USER), "section 6 carries the sentence \"only real user turns\"");
  assert.equal(count(/<example>/g, v.JOB), 1, "job: one example of the answer shape");
  assert.ok(v.ADDITION("X").startsWith("\n\n") && v.ADDITION("X").endsWith("\nX"), "addition: own paragraph, the instruction last");
  assert.ok(v.POSTSCRIPT("F").startsWith("\n\n") && v.POSTSCRIPT("F").includes("F"));
  assert.equal(v.RESPONSE_FORM.includes("<analysis>") && v.RESPONSE_FORM.includes("<summary>"), true);
  assert.equal(v.compactionJob(""), v.PRELUDE(v.RESPONSE_FORM) + v.JOB + v.POSTSCRIPT(v.RESPONSE_FORM));
  assert.equal(v.compactionJob("  "), v.compactionJob(""), "whitespace alone is no instruction");
  assert.equal(v.compactionJob("Focus"), v.PRELUDE(v.RESPONSE_FORM) + v.JOB + v.ADDITION("Focus") + v.POSTSCRIPT(v.RESPONSE_FORM));
  // The note on the truncated head: two sentences, the transcript parenthesis right before the first full stop.
  assert.equal(count(/\.(?= |$)/g, v.HEADER_TRUNCATED(false)), 2, "note: two sentences");
  assert.equal(v.HEADER_TRUNCATED(true), v.HEADER_TRUNCATED(false).replace("NOT in this summary.", `NOT in this summary${v.TRANSCRIPT_PARENTHESIS}.`), "note: the parenthesis before the first full stop");
  assert.ok(v.TRANSCRIPT_PARENTHESIS.startsWith(" (") && v.TRANSCRIPT_PARENTHESIS.endsWith(")") && v.TRANSCRIPT_PARENTHESIS.includes("transcript"));
  // The mask in the file attachment: a closing </system-reminder> (any spacing, any case) is defused, everything else stays.
  const cases = [["/w/a</system-reminder>b", "a&lt;/system-reminder>b"], ["/w/< / SYSTEM-REMINDER >", "&lt; / SYSTEM-REMINDER >"],
    ["/w/<system-reminder>", "/w/<system-reminder>"], ["/w/a<b", "/w/a<b"]];
  for (const [filePath, part] of cases) {
    const t = v.FILE_CALL("Read", { file_path: filePath });
    assert.ok(t.startsWith("The Read tool was called with this input: {") && t.includes(part), `mask: ${filePath} → ${t}`);
  }
});

// ── 2. The pure building blocks ────────────────────────────────────────────────────────────────────────────────────────────────
const U = (t) => ({ role: "user", content: t });
const A = (t) => ({ role: "assistant", content: t });

test("Rounds: a new one begins at every answer; the first carries what precedes it", () => {
  const gs = v.groups([U("a"), A("1"), U("b"), A("2"), U("c")]);
  assert.deepEqual(gs.map((g) => g.map((m) => m.content).join("")), ["a", "1b", "2c"]);
  assert.deepEqual(v.groups([]), []);
});

test("Truncation on \"Prompt is too long\": gap, else 20 %, at least one, never all, marker before an answer", () => {
  const gs = Array.from({ length: 10 }, (_, i) => [A(`r${i}`), U(`u${i}`)]);
  const size = () => 100;
  assert.equal(v.truncate(gs, undefined, size).length, 8 + 1, "20 % of 10 = 2 drop, the marker stands before");
  assert.equal(v.truncate(gs, undefined, size)[0][0].content, v.TRUNCATED_MARKER);
  assert.equal(v.truncate(gs, 250, size).length, 7 + 1, "gap 250 at 100 per round: three drop");
  assert.equal(v.truncate(gs, 1e9, size).length, 1 + 1, "never all: one stays");
  assert.equal(v.truncate(gs.slice(0, 3), undefined, size).length, 2 + 1, "at least one drops (20 % of 3 rounded down = 0)");
  assert.equal(v.truncate([[A("x")]], undefined, size), null, "one round: nothing left to truncate");
  const withMarker = v.truncate(gs, undefined, size);
  assert.equal(v.truncate(withMarker, undefined, size).filter((g) => g[0].truncatedMarker).length, 1, "the marker does not count and stands only once");
  const userFront = [[U("a")], [U("b"), A("1")], [U("c")]];
  assert.equal(v.truncate(userFront, undefined, size)[0][0].content, "b", "if the rest starts with the user, no marker");
  assert.equal(v.tokenGap(new Error("Prompt is too long: 250000 tokens > 200000 maximum")), 50000);
  assert.equal(v.tokenGap(new Error("Prompt is too long")), undefined);
  assert.equal(v.isPromptTooLong(new Error("prompt is too long")), true);
  assert.equal(v.isPromptTooLong(new Error("This model's maximum context length is 1000 tokens")), true);
  assert.equal(v.isPromptTooLong(new Error("rate limit")), false);
});

test("Formatting and message: <analysis> dropped, <summary> becomes \"Summary:\", sentences in the reference's order", () => {
  assert.equal(v.formatSummary("<analysis>\nsecret\n</analysis>\n\n<summary>\n1. A\n\n\n\n2. B\n</summary>"), "Summary:\n1. A\n\n2. B");
  assert.equal(v.formatSummary("plain text"), "plain text");
  assert.equal(v.summaryMessage("S"), `${v.INTRO}\nS`);
  assert.equal(v.summaryMessage("S", { transcript: "/t.txt", headerTruncated: true, keep: "[Assistant]: x" }),
    `${v.INTRO}\nS\n${v.TRANSCRIPT_SET}/t.txt\n${v.HEADER_TRUNCATED(true)}\n${v.KEEP}\n\n[Assistant]: x`);
  assert.ok(!v.HEADER_TRUNCATED(false).includes("Transcript"));
  assert.ok(v.HEADER_TRUNCATED(true).includes(v.TRANSCRIPT_PARENTHESIS));
  assert.equal(v.messageAsText(U("hi"), ""), "[User]: hi", "without an id no \"·\"");
  assert.equal(v.messageAsText(U("hi"), "ab12"), "[User·ab12]: hi");
});

test("Attachments: the latest five files without memory files, Read form, reference above 5,000 tokens, budget; skills; status", () => {
  const rows = [];
  let id = 0;
  const tool = (name, input, ts, extra = {}) => rows.push({ id: ++id, role: "tool", ts, text: JSON.stringify({ name, input, id: `t${id}`, ...extra }) });
  for (let i = 0; i < 7; i++) tool("Read", { file_path: `/w/d${i}.txt` }, 100 + i);
  tool("Read", { file_path: "/w/CLAUDE.md" }, 200);
  tool("Edit", { file_path: "/w/d0.txt" }, 300); // touched again => the latest
  tool("Read", { file_path: "relative.txt" }, 301); // absolute paths only
  tool("Read", { file_path: "/w/sub.txt" }, 302, { parent: "toolu_x" }); // a subagent has its own read state
  tool("mcp__cbase__cbase_skill", { name: "latch" }, 400);
  rows.push({ id: ++id, role: "tool_result", ts: 401, text: JSON.stringify({ id: `t${id - 1}`, result: JSON.stringify({ body: "Skill text" }), isError: false }) });
  const refs = attachmentRefs(rows);
  assert.deepEqual(refs.files.map((d) => d.path), ["/w/d0.txt", "/w/d6.txt", "/w/d5.txt", "/w/d4.txt", "/w/d3.txt"]);
  assert.deepEqual(refs.skills.map((s) => s.name), ["latch"]);
  // The chain: what the previous compaction restored stays until newer ones displace it.
  const further = attachmentRefs([{ id: 99, role: "tool", ts: 500, text: JSON.stringify({ name: "Read", input: { file_path: "/w/fresh.txt" }, id: "n" }) }], refs);
  assert.deepEqual(further.files.map((d) => d.path), ["/w/fresh.txt", "/w/d0.txt", "/w/d6.txt", "/w/d5.txt", "/w/d4.txt"]);
  assert.deepEqual(further.skills.map((s) => s.name), ["latch"]);

  const content = { "/w/a.txt": "one\ntwo", "/w/large.txt": "x".repeat(v.FILE_TOKEN_MAX * 4 + 40) };
  const read = (p) => (p in content ? { text: content[p], truncated: false } : null);
  const texts = fileAttachments([{ path: "/w/a.txt", at: 2 }, { path: "/w/large.txt", at: 1 }, { path: "/w/missing.txt", at: 3 }], { read });
  assert.deepEqual(texts, [
    `${v.FILE_CALL("Read", { file_path: "/w/a.txt" })}\n\n${v.FILE_RESULT("Read", "1\tone\n2\ttwo")}`,
    v.FILE_TOO_LARGE("/w/large.txt", "Read"),
  ]);
  assert.equal(withLineNumbers(Array.from({ length: 2500 }, (_, i) => String(i)).join("\n")).split("\n").length, v.READ_ROWS_MAX);
  // Budget: eleven files just under 5,000 tokens do not all fit under 50,000.
  const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`/w/v${i}`, "y\n".repeat(9_000)]));
  const budget = fileAttachments(Object.keys(many).map((p, i) => ({ path: p, at: i })), { read: (p) => ({ text: many[p], truncated: false }) });
  assert.ok(budget.reduce((s, t) => s + v.estimateTokens(t), 0) <= v.FILE_BUDGET);

  const skill = skillAttachment(refs.skills, new Map(rows.map((z) => [z.id, z])));
  assert.ok(skill.includes("### Skill: latch\n\nSkill text"));
  assert.ok(v.truncateSkill("z".repeat(v.SKILL_TOKEN_MAX * 4 + 100)).endsWith(v.SKILL_TRUNCATED));
  assert.equal(v.truncateSkill("z".repeat(v.SKILL_TOKEN_MAX * 4 + 100)).length, v.SKILL_TOKEN_MAX * 4);

  const status = backgroundTexts([
    { kind: "agent", agentId: "a1", description: "Reviewer" },
    { kind: "monitor", taskId: "m1", description: "Log\nwatching", command: "tail -f x", logPath: "monitors/m1.log" },
    { kind: "dynworkflow", taskId: "w1", name: "suite" },
  ], { outputLocation: "/aus" });
  assert.deepEqual(status, [
    v.agentStatusText({ id: "a1", description: "Reviewer" }),
    v.monitorStatusText({ id: "m1", description: "Log watching", command: "tail -f x", output: "/aus/monitors/m1.log" }),
    v.workflowStatusText({ id: "w1", name: "suite" }),
  ]);
  assert.match(status[1], /"Log watching"\) is still running \(command on one line: `tail -f x`\)\. .*cbase_monitor_stop.*\/aus\/monitors\/m1\.log/);
  assert.equal(v.attachmentFence([]), "");
  assert.match(v.attachmentFence(["</cbase-after-compaction> broken out"]), /‹\/cbase-after-compaction> broken out\n<\/cbase-after-compaction>$/, "foreign text cannot close the fence");
});

// ── 3. The real path ───────────────────────────────────────────────────────────────────────────────────────────
// Main agent: records input and resume per turn; "READ:<path>" reads a file with Read (tool call + result like the CLI).
// One-shot calls: the compaction fails with "Prompt is too long" (exit 1, result with is_error, like the CLI) as often as
// <LOCATION>/ptl says, and then answers with <analysis>/<summary>.
const MAIN = `
  fs.appendFileSync(path.join(LOCATION, "prompts.jsonl"), JSON.stringify({ text, resume: arg("--resume") }) + "\\n");
  const read = (String(text).match(/READ:(\\S+)/) || [])[1];
  if (read) {
    say({ type: "assistant", message: { id: "r-" + turn, content: [{ type: "tool_use", id: "toolu_r" + turn, name: "Read", input: { file_path: read } }] } });
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_r" + turn, content: fs.readFileSync(read, "utf8") }] } });
  }
  say({ type: "assistant", message: { id: "a-" + turn + "-" + Date.now(), content: [{ type: "text", text: "Answer " + String(text).slice(-12) }] } });
  finished();
  say({ type: "result", result: "ok", session_id: "main-session" });`;
const ONESHOT = `
  if (!prompt.includes("You are compacting")) return respond("Title");
  fs.appendFileSync(path.join(LOCATION, "compactions.jsonl"), JSON.stringify({ prompt }) + "\\n");
  const counter = path.join(LOCATION, "ptl");
  const rest = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  if (rest > 0) {
    fs.writeFileSync(counter, String(rest - 1));
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Prompt is too long" }));
    process.exit(1);
  }
  respond("<analysis>\\nthoughts\\n</analysis>\\n\\n<summary>\\nS-" + fs.readFileSync(path.join(LOCATION, "compactions.jsonl"), "utf8").split("\\n").filter(Boolean).length + "\\n</summary>");`;
const claude = fakeClaude({ main: MAIN, oneshot: ONESHOT });

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body ?? {}) });
const prompts = (root) => readJsonl(path.join(root, "prompts.jsonl"));
const compactions = (root) => readJsonl(path.join(root, "compactions.jsonl")).map((o) => o.prompt);
const markers = (chatId) => store.listMessages(chatId).filter((m) => m.role === "meta" && m.text.includes("\"compacted\":true")).map((m) => JSON.parse(m.text));
async function human(ctx, chatId, text) {
  await post(`${ctx.base}/api/chats/${chatId}/message`, { text });
  await ctx.waitForTruthy(() => prompts(ctx.root).some((p) => p.text.endsWith(text)), `input "${text}"`);
  await ctx.waitForIdle();
  return prompts(ctx.root).filter((p) => p.text.endsWith(text)).at(-1);
}

test("/compact: instruction as additional instructions, the last round stays verbatim, the marker carries summary and transcript", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await human(ctx, chat.id, "Question one");
    await human(ctx, chat.id, "Question two");
    const r = await post(`${base}/api/chats/${chat.id}/compact`, { instruction: "Only the tests" });
    assert.equal(r.ok, true, JSON.stringify(r));
    const [p] = compactions(root);
    assert.ok(p.endsWith(v.compactionJob("Only the tests")), "the reference job with the instruction at the end");
    assert.match(p, /\[User·[0-9a-f]{6}\]: Question one/);
    assert.match(p, /\[User·[0-9a-f]{6}\]: Question two/, "the question of the last round belongs to the head (the round begins with the answer)");
    assert.doesNotMatch(p, /Answer Question two/, "the last round does not go into the summary");
    const m = markers(chat.id).at(-1);
    assert.equal(m.summary, "Summary:\nS-1");
    assert.equal(m.keep, "[Assistant]: Answer Question two");
    assert.ok(fs.readFileSync(m.transcript, "utf8").includes("[Assistant]: Answer Question two"), "the transcript carries the whole section");
    const summary = store.getChat(chat.id).contextSummary;
    assert.equal(summary, v.summaryMessage("Summary:\nS-1", { transcript: m.transcript, keep: m.keep }));
    const three = await human(ctx, chat.id, "Question three");
    assert.equal(three.resume, "", "fresh session");
    assert.ok(three.text.startsWith(summary), "the reference message comes first");
    // Without an instruction no addition (the body may be absent).
    await post(`${base}/api/chats/${chat.id}/compact`);
    assert.ok(compactions(root)[1].endsWith(v.compactionJob("")));
  }, { claude });
});

test("\"Prompt is too long\": three retries with a shorter head each — the fourth failure gives up and writes nothing", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    for (const t of ["F1", "F2", "F3", "F4", "F5", "F6", "F7"]) await human(ctx, chat.id, t);
    fs.writeFileSync(path.join(root, "ptl"), "3");
    const r = await post(`${base}/api/chats/${chat.id}/compact`);
    assert.equal(r.ok, true, JSON.stringify(r));
    const ps = compactions(root);
    assert.equal(ps.length, 1 + v.PTL_ATTEMPTS, "one attempt and three retries");
    // Each attempt drops the oldest round (20 % of seven, rounded down, at least one): first F1, then answer 1 with F2, then F3.
    for (let i = 0; i < 4; i++) {
      for (let k = 1; k <= 7; k++) {
        const existing = new RegExp(`\\]: F${k}\\n`).test(ps[i]);
        assert.equal(existing, k > i, `attempt ${i}: F${k} ${k > i ? "still there" : "gone"}`);
      }
    }
    assert.ok(ps[1].includes(v.TRUNCATED_MARKER), "the rest begins with an answer: the marker stands before");
    const m = markers(chat.id).at(-1);
    assert.equal(m.truncated, true);
    assert.ok(store.getChat(chat.id).contextSummary.includes(v.HEADER_TRUNCATED(true)), "/compact says the head is missing");

    // Always too long: 1 + 3 calls, then an error — no marker, the session stays.
    for (const t of ["F8", "F9", "F10", "F11", "F12", "F13", "F14"]) await human(ctx, chat.id, t);
    fs.writeFileSync(path.join(root, "ptl"), "99");
    const prior = compactions(root).length;
    const markersPrior = markers(chat.id).length;
    const session = store.getChat(chat.id).claudeSessionId;
    const res = await fetch(`${base}/api/chats/${chat.id}/compact`, { method: "POST" });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /auch nach 3 Kürzungen zu lang/);
    assert.equal(compactions(root).length - prior, 1 + v.PTL_ATTEMPTS);
    assert.equal(markers(chat.id).length, markersPrior, "nothing written");
    assert.equal(store.getChat(chat.id).claudeSessionId, session, "the session stays");
    assert.equal(store.getPendingResume(chat.id), null, "\"too long\" is no limit: nothing parked");
  }, { claude });
});

// Since 2.1.322 the full summary (the auto compaction) also reports the truncated head — up to 2.1.296 only the ladder did.
test("Auto compaction after \"Prompt is too long\": everything is summarised (no kept round), and the message says the head is missing", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat, root } = ctx;
    for (const t of ["G1", "G2", "G3", "G4", "G5", "G6", "G7"]) await human(ctx, chat.id, t);
    fs.writeFileSync(path.join(root, "ptl"), "1");
    const r = await compactChatContext(store.getChat(chat.id), { auto: true, percent: 60 });
    assert.equal(r.ok, true, JSON.stringify(r));
    const ps = compactions(root);
    assert.equal(ps.length, 2, "one attempt and one retry");
    assert.match(ps[1], /Answer G7/, "auto: the last round also goes into the summary");
    assert.doesNotMatch(ps[1], /\]: G1\n/, "the head dropped");
    const m = markers(chat.id).at(-1);
    assert.equal(m.auto, true);
    assert.equal(m.truncated, true);
    assert.equal(m.keep, undefined, "auto keeps no round verbatim");
    assert.equal(store.getChat(chat.id).contextSummary,
      v.summaryMessage("Summary:\nS-2", { transcript: m.transcript, headerTruncated: true }), "introduction, summary, transcript, note");
    assert.ok(store.getChat(chat.id).contextSummary.endsWith(v.HEADER_TRUNCATED(true)));
    // Without truncation no note — on the auto path too.
    for (const t of ["G8", "G9"]) await human(ctx, chat.id, t);
    assert.equal((await compactChatContext(store.getChat(chat.id), { auto: true, percent: 60 })).ok, true);
    assert.ok(!store.getChat(chat.id).contextSummary.includes(v.HEADER_TRUNCATED(true)) && !store.getChat(chat.id).contextSummary.includes(v.HEADER_TRUNCATED(false)));
  }, { claude });
});

test("Attachments in the first turn after the compaction — the last-read file fresh from disk, without CLAUDE.md; nothing in the next turn; the chain keeps the file", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, ws } = ctx;
    const file = path.join(ws.path, "note.txt");
    fs.writeFileSync(file, "old\n");
    fs.writeFileSync(path.join(ws.path, "CLAUDE.md"), "Memory\n");
    await human(ctx, chat.id, `Read READ:${file}`);
    await human(ctx, chat.id, `Read READ:${path.join(ws.path, "CLAUDE.md")}`);
    fs.writeFileSync(file, "Line one\nLine two\n"); // freshly read, not from the history
    assert.equal((await post(`${base}/api/chats/${chat.id}/compact`)).ok, true);
    const first = await human(ctx, chat.id, "Continue");
    const expected = `${v.FILE_CALL("Read", { file_path: file })}\n\n${v.FILE_RESULT("Read", "1\tLine one\n2\tLine two\n3\t")}`;
    assert.ok(first.text.includes("<cbase-after-compaction>"), first.text.slice(0, 400));
    assert.ok(first.text.includes(expected), "the file in Read form");
    assert.doesNotMatch(first.text.split("<cbase-after-compaction>")[1], /Memory/, "CLAUDE.md is in the system prompt, not in the attachment");
    assert.ok(first.text.indexOf(v.INTRO) < first.text.indexOf("<cbase-after-compaction>"), "summary, then attachment, then input");
    const second = await human(ctx, chat.id, "Once more");
    assert.equal(second.resume, "main-session");
    assert.ok(!second.text.includes("cbase-after-compaction"), "the resumed session already carries it");
    // The second compaction without new reads: the file stays (the reference fills its read state with the restored ones).
    assert.equal((await post(`${base}/api/chats/${chat.id}/compact`)).ok, true);
    const third = await human(ctx, chat.id, "Afterwards");
    assert.ok(third.text.includes(expected), "the file of the previous compaction is there again");
    assert.ok(compactions(root)[1].includes(v.INTRO), "the chain: the previous summary stands in the section");
  }, { claude });
});

test("Loop engine (OpenRouter): the same path — reference job, message before it, the read file in the first turn afterwards", async () => {
  let probe = "";
  await withAgentsServer(async (ctx) => {
    const { base, ws, engine } = ctx;
    probe = path.join(ws.path, "engine.txt");
    fs.writeFileSync(probe, "E1\n");
    const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "openrouter", model: "m1", permissionMode: "bypassPermissions" }) });
    const turn = async (text) => { await post(`${base}/api/chats/${chat.id}/message`, { text }); await ctx.waitForIdle(); };
    await turn("Read the file");
    await turn("And on");
    assert.equal((await post(`${base}/api/chats/${chat.id}/compact`)).ok, true);
    const job = engine.requests.filter((a) => a.stream === false).map((a) => a.messages.map((m) => String(m.content)).join("\n")).find((t) => t.includes("You are compacting"));
    assert.ok(job && job.endsWith(v.compactionJob("")), "the reference job");
    const prior = engine.requests.length;
    await turn("After the compaction");
    const fresh = engine.requests.slice(prior).find((a) => a.stream !== false);
    const user = fresh.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    assert.ok(user.includes(v.INTRO), "the reference message");
    assert.ok(user.includes(v.FILE_CALL("Read", { file_path: probe })), "the read file");
    assert.ok(user.includes("1\tE1"), "fresh, in Read form");
  }, { engine: { tool: () => ({ name: "Read", input: { file_path: probe } }) } });
});
