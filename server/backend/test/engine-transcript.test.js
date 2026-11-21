// The memory of a third-party-provider chat between two messages.
//
// A stateless provider has no `--resume`: whatever is not reconstructed here is gone for the next run.
// Guard: a transcript that keeps only user/assistant TEXT forgets the files read and commands run.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildTranscript, transcriptBudgetChars } from "../electron/server/providers/transcript.js";
import { completionNotice } from "../electron/server/runs/completionNotice.js";
import { buildMessage } from "../electron/server/runs/message-marker.js";
import { cardsHistory } from "../electron/server/runs/question-history.js";

const tool = (id, name, input = {}, parent = null) => ({ role: "tool", text: JSON.stringify({ id, name, input, parent, detail: "" }) });
const result = (id, res, isError = false) => ({ role: "tool_result", text: JSON.stringify({ id, result: res, isError }) });

test("tool history survives: call and result are rebuilt as blocks", () => {
  const rows = [
    { role: "user", text: "Look at server.js" },
    { role: "thinking", text: JSON.stringify({ text: "think think", parent: null }) },
    { role: "assistant", text: "I will have a look." },
    tool("t1", "Read", { file_path: "/x/server.js" }),
    result("t1", "1\tconst a = 1"),
    { role: "assistant", text: "It says const a = 1." },
    { role: "user", text: "And then?" }, // current prompt, arrives separately as spec.input
  ];
  const out = buildTranscript(rows, { contextWindow: 200_000 });

  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(out[0].content, "Look at server.js");
  // Text and tool call belong in ONE assistant turn.
  const blocks = out[1].content;
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "text");
  assert.equal(blocks[1].type, "tool_use");
  assert.deepEqual({ id: blocks[1].id, name: blocks[1].name }, { id: "t1", name: "Read" });
  // The result follows as a user turn with the matching tool_use_id.
  assert.equal(out[2].content[0].type, "tool_result");
  assert.equal(out[2].content[0].tool_use_id, "t1");
  assert.match(out[2].content[0].content, /const a = 1/);
  // Thinking blocks without a signature cannot be replayed and stay out.
  assert.ok(!JSON.stringify(out).includes("think think"));
});

test("parallel calls stay paired, aborted ones get a result", () => {
  const paired = buildTranscript([
    { role: "user", text: "go" },
    tool("a", "Read", { file_path: "/1" }),
    tool("b", "Read", { file_path: "/2" }),
    result("a", "one"),
    result("b", "two"),
  ], { dropTrailingUser: false });
  // One assistant turn with two tool_use, one user turn with two tool_result.
  assert.equal(paired[1].content.filter((b) => b.type === "tool_use").length, 2);
  assert.equal(paired[2].content.filter((b) => b.type === "tool_result").length, 2);

  // Crashed run: tool_use without a result. Anthropic rejects unpaired blocks outright.
  const orphan = buildTranscript([
    { role: "user", text: "go" },
    tool("x", "Bash", { command: "sleep 999" }),
  ], { dropTrailingUser: false });
  const last = orphan[orphan.length - 1];
  assert.equal(last.role, "user");
  assert.equal(last.content[0].tool_use_id, "x");
  assert.equal(last.content[0].is_error, true);
});

test("subagent rows stay out (their context no longer exists)", () => {
  const out = buildTranscript([
    { role: "user", text: "go" },
    tool("t1", "Task", { prompt: "check this" }),
    tool("child", "Read", { file_path: "/y" }, "t1"), // child call of the subagent
    result("child", "content"),
    result("t1", "subagent result"),
  ], { dropTrailingUser: false });
  const flat = JSON.stringify(out);
  assert.ok(flat.includes("subagent result"));
  assert.ok(!flat.includes('"id":"child"'), "child calls do not belong in the main thread");
  // …and the leftover child result must not leave an unpaired block.
  const ids = out.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
  assert.deepEqual(ids, ["t1"]);
});

test("/clear and compaction cut off the lookback", () => {
  const before = [
    { role: "user", text: "very old" },
    { role: "assistant", text: "also old" },
  ];
  const afterClear = buildTranscript([
    ...before,
    { role: "clear", text: "" },
    { role: "user", text: "fresh" },
    { role: "assistant", text: "fresh" },
  ], { dropTrailingUser: false });
  assert.deepEqual(afterClear.map((m) => m.content), ["fresh", "fresh"]);

  const afterCompact = buildTranscript([
    ...before,
    { role: "meta", text: JSON.stringify({ compacted: true }) },
    { role: "user", text: "afterwards" },
  ], { dropTrailingUser: false });
  assert.deepEqual(afterCompact.map((m) => m.content), ["afterwards"]);
});

test("the budget follows the context window, not a fixed number", () => {
  // A 1M model must not get the same 60 kB lookback as a 128k model.
  assert.ok(transcriptBudgetChars(1_000_000) > transcriptBudgetChars(128_000));
  assert.equal(transcriptBudgetChars(0), transcriptBudgetChars(128_000)); // fallback
  assert.ok(transcriptBudgetChars(8_000) >= 60_000); // lower bound

  // Trimmed from the back: the NEWEST history stays.
  const big = "x".repeat(30_000);
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push({ role: "user", text: `question ${i} ${big}` });
    rows.push({ role: "assistant", text: `answer ${i} ${big}` });
  }
  const out = buildTranscript(rows, { contextWindow: 20_000, dropTrailingUser: false }); // small budget
  const flat = JSON.stringify(out);
  assert.ok(flat.includes("answer 9"), "the newest must stay");
  assert.ok(!flat.includes("question 0"), "the oldest must go");
});

test("trimming never leaves a result without its call", () => {
  const big = "y".repeat(80_000);
  const rows = [
    { role: "user", text: "old" },
    tool("t1", "Read", { file_path: "/large" }),
    result("t1", big),           // huge result: the cut lands right here
    { role: "assistant", text: "finished" },
    { role: "user", text: "and now" },
    { role: "assistant", text: "ok" },
  ];
  const out = buildTranscript(rows, { contextWindow: 8_000, dropTrailingUser: false });
  // The first message is never a tool_result (its tool_use would lie before it) …
  const first = out[0];
  const firstIsOrphanResult = Array.isArray(first.content) && first.content.some((b) => b.type === "tool_result");
  assert.equal(firstIsOrphanResult, false);
  // … and never an assistant turn: Anthropic requires user as the first entry.
  assert.equal(out[0].role, "user");
});

test("attachments of earlier messages stay findable as a PATH", () => {
  const out = buildTranscript([
    { role: "user", text: "What is in the picture?", attachments: [{ file: "abc.png", mime: "image/png" }] },
    { role: "assistant", text: "A cube." },
  ], { attachmentDir: "/attachments/chat1", dropTrailingUser: false });
  assert.match(out[0].content, /\/attachments\/chat1\/abc\.png/);
});

// ── Question cards ───────────────────────────────────────────────────────────
// Claude and Codex keep in their session what the agent learned from a card; the engine only reads it here. Guarded:
// `answers` is an ARRAY (runs/ask.js normalizeAskAnswers) and must not arrive as "0: [object Object]"; a card that a human
// message bypassed must show as closed from the follow-up turn on, not only as "[Question to the user]" (the "card closed"
// notice is not a history row).
const ask = (requestId, ...questions) => ({ role: "ask", text: JSON.stringify({ requestId, questions: questions.map((question) => ({ question, options: [{ label: "A" }, { label: "B" }] })) }) });
const response = (requestId, answers, extra = {}) => ({ role: "ask_answer", text: JSON.stringify({ requestId, answers, ...extra }) });
const wfRow = (kind) => ({ role: "workflow", text: JSON.stringify({ kind, name: "GEO", total: 3 }) });
const texts = (out) => out.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
const TO = "[Question card closed, without a selection]";

test("question answered: per answer the question plus selection/text, verbatim as the agent received it", () => {
  const out = buildTranscript([
    { role: "user", text: "Set up the database." },
    ask("r1", "Which database?", "Where does it live?"),
    response("r1", [
      { header: "DB", question: "Which database?", selected: ["SQLite"], text: "" },
      { header: "Location", question: "Where does it live?", selected: [], text: "in the volume" },
    ]),
    { role: "user", text: "DB: SQLite\nLocation: in the volume" }, // askAnswerDisplay, the user bubble
    { role: "assistant", text: "Taking SQLite in the volume." },
    { role: "user", text: "further" },
  ], { contextWindow: 200_000 });
  const everything = texts(out).join("\n");
  assert.ok(!everything.includes("[object Object]"), everything);
  assert.equal(texts(out)[2], [
    "[Answer to your question — the user selected in the chat]",
    "",
    "Question: Which database?",
    "Selected: SQLite",
    "",
    "Question: Where does it live?",
    "Own answer: in the volume",
    "",
    "Continue on this basis.",
  ].join("\n"));
  assert.ok(!everything.includes(TO), "a selection does not close the card \"without a selection\"");
});

test("question dismissed (dismissAsk): \"card closed, without a selection\" with the reason", () => {
  const out = buildTranscript([
    { role: "user", text: "Go." },
    ask("r1", "Which taxonomy?"),
    response("r1", [], { dismissed: "skip" }),
    { role: "assistant", text: "On to the next step." },
  ], { dropTrailingUser: false });
  const closed = texts(out).find((t) => t.startsWith(TO));
  assert.ok(closed, `no "card closed" line:\n${texts(out).join("\n---\n")}`);
  assert.match(closed, /Your question card is closed: the workflow step it belonged to was skipped\./);
  assert.match(closed, /Question on the card: “Which taxonomy\?”/);
  assert.ok(!texts(out).some((t) => t.includes("Answer to your question")), "no answers, no answer line");
});

test("question bypassed: the human message carries the card-closed notice in the follow-up turn, the completion notice and agent message do not", () => {
  const notice = completionNotice({ agentId: "a-1", description: "On the side", status: "completed", report: "finished" }, { toolUseId: "toolu_x" });
  const post = buildMessage({ from: "Chat B", text: "I am done." });
  const out = buildTranscript([
    { role: "user", text: "Review is running." },
    ask("r1", "Create the issue like this?"),
    { role: "assistant", text: "The card is at the top of the chat." },
    { role: "user", text: notice },
    { role: "user", text: post },
    { role: "user", text: "Do something else first." },
    { role: "assistant", text: "Will do." },
    { role: "user", text: "And one more thing." },
    { role: "assistant", text: "Ok." },
    { role: "user", text: "And now?" }, // current prompt, its turn carries the notice itself (runs/queue.js)
  ], { contextWindow: 200_000 });
  const t = texts(out);
  assert.equal(t.find((x) => x.endsWith("Do something else first.")), [
    TO,
    "Your question card is closed: the human did not choose on it but wrote this turn's message — "
      + "if it answers your question, it counts as the answer, otherwise the question is bypassed. It can no longer be clicked, a selection "
      + "on it will not arrive any more — do not refer to it any more. If you still need the decision, ask again (cbase_ask as a new card "
      + "or in text).",
    "Question on the card: “Create the issue like this?”",
    "",
    "---",
    "",
    "Do something else first.",
  ].join("\n"));
  assert.equal(t.filter((x) => x.includes(TO)).length, 1, `exactly once, on the message that closed it:\n${t.join("\n---\n")}`);
  assert.equal(t.find((x) => x.startsWith("<task-notification>")), notice, "the completion notice closes no card");
  assert.equal(t.find((x) => x.startsWith("<cbase-message")), post, "an agent message closes no card");
  assert.ok(t.includes("And one more thing."), "a closed card is not reported twice");
});

test("question in a running workflow: free text does not close, only the answer or the end does; window from the history rows", () => {
  const out = buildTranscript([
    { role: "user", text: "Build the spec." },
    wfRow("start"),
    ask("r1", "Which taxonomy?"),
    { role: "user", text: "Where did you see the mockup?" }, // side question: the run holds the step at the card
    { role: "assistant", text: "In the design/ folder." },
    response("r1", [], { dismissed: "run-done" }),             // finishWorkflow: dismissAsk before the end row
    wfRow("end"),
    ask("r2", "Another pass?"),
    { role: "user", text: "No, commit first." },         // outside the run: bypassed
    { role: "assistant", text: "Commit." },
  ], { dropTrailingUser: false });
  const t = texts(out);
  assert.equal(t.find((x) => x.endsWith("Where did you see the mockup?")), "Where did you see the mockup?", "the side question does not close");
  const closed = t.filter((x) => x.startsWith(TO));
  assert.equal(closed.length, 2, t.join("\n---\n"));
  assert.match(closed[0], /closed: the workflow run ended\.[\s\S]*“Which taxonomy\?”/);
  assert.match(closed[1], /otherwise the question is bypassed\.[\s\S]*“Another pass\?”[\s\S]*---\n\nNo, commit first\.$/);

  // A run without an end row is still running: no message inside it closes the card.
  const open = buildTranscript([wfRow("start"), ask("r1", "Which taxonomy?"), { role: "user", text: "Side question?" }, { role: "assistant", text: "Answer." }], { dropTrailingUser: false });
  assert.ok(!texts(open).some((x) => x.includes(TO)), texts(open).join("\n---\n"));
});

test("question from cbase_ask: the card sits behind its call's result, never between call and result", () => {
  // This is how the DB holds it: the route writes `ask` DURING the tool call.
  const out = buildTranscript([
    { role: "user", text: "Review is running." },
    { role: "assistant", text: "I will ask." },
    tool("t1", "mcp__cbase__cbase_ask", { questions: [{ question: "Create the issue like this?" }] }),
    ask("r1", "Create the issue like this?"),
    result("t1", JSON.stringify({ ok: true, requestId: "r1" })),
    { role: "assistant", text: "Question asked." },
    { role: "user", text: "Do something else first." },
    { role: "assistant", text: "Ok." },
  ], { dropTrailingUser: false });
  const i = out.findIndex((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" && b.id === "t1"));
  assert.ok(i >= 0, JSON.stringify(out));
  assert.equal(out[i + 1].role, "user");
  assert.deepEqual(out[i + 1].content.map((b) => [b.type, b.tool_use_id]), [["tool_result", "t1"]], "the result follows the call immediately");
  assert.equal(out[i + 2].content, "[Question to the user]\nCreate the issue like this?", "the card sits behind the result");
  assert.match(texts(out).find((t) => t.endsWith("Do something else first.")), /^\[Question card closed, without a selection\]/);

  // If the result never came (run aborted), the card sits behind the backfilled result.
  const aborted = buildTranscript([
    { role: "user", text: "go" },
    tool("t1", "mcp__cbase__cbase_ask", {}),
    ask("r1", "Create the issue like this?"),
  ], { dropTrailingUser: false });
  assert.deepEqual(aborted.slice(1).map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.type).join("+"))),
    ["tool_use", "tool_result", "[Question to the user]\nCreate the issue like this?"]);
});

test("question rule: ONE version for openAskOf and the engine transcript (runs/question-history.js)", () => {
  // openAskOf asks with the workflow state of NOW (fixed), the transcript computes the window per row: the same function.
  const rows = [wfRow("start"), ask("r1", "Which taxonomy?"), { role: "user", text: "Side question?" }];
  assert.equal(cardsHistory(rows, { workflowOpen: true }).open?.requestId, "r1", "fixed open: the side question does not close");
  assert.equal(cardsHistory(rows, { workflowOpen: false }).open, null, "fixed closed: it closes, the start row does not count then");
  assert.equal(cardsHistory(rows).open?.requestId, "r1", "from the rows: the run is open");
  assert.equal(cardsHistory([ask("r1", "F?"), response("r1", [{ question: "F?", selected: ["A"], text: "" }])]).open, null, "answered means closed");
  assert.deepEqual([...cardsHistory([ask("r1", "F?"), response("r1", [{ question: "F?", selected: ["A"], text: "" }])]).closedCards.keys()], [], "… and not \"without a selection\"");
  assert.equal(cardsHistory([ask("r1", "F?"), ask("r2", "G?")]).open?.requestId, "r2", "the newest card counts");
  // /clear closes always, even inside a run (like chatBubbles.ts closeAsks and listOpenAsks); no "without a selection",
  // the lookback starts behind it.
  const cleared = [ask("r1", "F?"), { role: "clear", text: JSON.stringify({ cleared: true, at: 1 }) }];
  for (const o of [{}, { workflowOpen: true }, { workflowOpen: false }]) {
    assert.equal(cardsHistory(cleared, o).open, null, `closed after /clear (${JSON.stringify(o)})`);
  }
  assert.equal(cardsHistory([wfRow("start"), ...cleared]).open, null, "also inside a run, from the rows");
  assert.deepEqual([...cardsHistory(cleared).closedCards.keys()], []);
  assert.ok(!texts(buildTranscript([...cleared, { role: "user", text: "Start over." }, { role: "assistant", text: "Gladly." }], { dropTrailingUser: false })).some((t) => t.includes(TO)),
    "the first message after /clear bypasses no card");

  // Bound, not copied: both readers import the rule, and only this file defines it.
  const server = new URL("../electron/server/", import.meta.url);
  const read = (rel) => fs.readFileSync(new URL(rel, server), "utf8");
  assert.match(read("providers/transcript.js"), /import \{[^}]*\bcardsHistory\b[^}]*\} from "\.\.\/runs\/question-history\.js"/);
  assert.match(read("runs/ask.js"), /import \{[^}]*\bcardsHistory\b[^}]*\} from "\.\/question-history\.js"/);
  assert.match(read("runs/ask.js"), /function openAskOf\(chatId\) \{[^}]*cardsHistory\(store\.listMessages\(chatId\)/);
  const defined = [];
  const go = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") go(p); continue; }
      if (!e.name.endsWith(".js")) continue;
      if (/(?:const|let|function)\s+(?:closesCard|cardsHistory)\b/.test(fs.readFileSync(p, "utf8"))) defined.push(path.relative(fileURLToPath(server), p));
    }
  };
  go(fileURLToPath(server));
  assert.deepEqual(defined, ["runs/question-history.js"]);
});

test("empty history yields an empty transcript", () => {
  assert.deepEqual(buildTranscript([], {}), []);
  assert.deepEqual(buildTranscript([{ role: "user", text: "only the current prompt" }], {}), []);
});
