// The result assignment (src/lib/tool-result.ts): WHERE a tool_result lands when the last bubble
// is not an assistant bubble, and that an unknown result touches nothing. No browser: the helper
// is the core of a repair of the chat views: `mutateLast` only looked in the LAST bubble, and after
// "Approve" the card hangs as a bubble of its own behind the call, so the result went nowhere and
// the group spun until reload.
//
// Counter-test against that mutateLast revision: case 1 (card bubble behind the call) would fail:
// the last bubble has no blocks, the call would stay `done: undefined`. Case 3 would also fail for
// a version that returns `[...prev]` instead of `prev` at the end: then every foreign hit
// re-renders the whole history.
//
// Run:  node --test web/test/tool-result.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

// Like tool-summary.test.mjs: compile the real source with the local tsc and import it.
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-tool-result-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "tool-result.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { applyToolInput, applyToolResult, mutateUnderParent } = await import(pathToFileURL(path.join(out, "tool-result.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

const tool = (id, extra = {}) => ({ kind: "tool", id, name: "Bash", detail: "", count: 1, ...extra });

test("Card bubble behind the call: the result lands in bubble 0, not in the last one", () => {
  const prev = [
    { role: "assistant", blocks: [tool("X")] },
    { role: "approval", blocks: [] },
  ];
  const next = applyToolResult(prev, "X", "ok", false);
  assert.notEqual(next, prev);
  assert.deepEqual(next[0].blocks[0], { ...tool("X"), result: "ok", resultIsError: false, done: true });
  // The card bubble stays the same object, and so does the history before it.
  assert.equal(next[1], prev[1]);
  assert.equal(next.length, 2);
  // And the input is untouched (no mutation).
  assert.equal(prev[0].blocks[0].done, undefined);
});

test("Subagent: the result of a child call finds its child, the Task block stays open", () => {
  const prev = [{ role: "assistant", blocks: [tool("P", { name: "Task", children: [tool("X")] })] }];
  const next = applyToolResult(prev, "X", "finished", true);
  assert.notEqual(next, prev);
  const task = next[0].blocks[0];
  assert.equal(task.done, undefined);
  assert.deepEqual(task.children[0], { ...tool("X"), result: "finished", resultIsError: true, done: true });
});

test("Unknown id: the return value is the same array (no re-render)", () => {
  const prev = [
    { role: "assistant", blocks: [tool("X")] },
    { role: "user", blocks: [tool("Y")] }, // a user bubble is never searched
  ];
  assert.equal(applyToolResult(prev, "Y", "x", false), prev);
  assert.equal(applyToolResult(prev, "Z", "x", false), prev);
  assert.equal(applyToolResult([], "X", "x", false).length, 0);
});

// ── Placing the content of a subagent ────────────────────────────────────────
// The same search in the other direction: not "where does the result belong" but "where does the
// TEXT belong that a subagent is writing right now". The histories had a `mutateBlocks` for this
// that only looked in the last bubble and wrote into the MAIN BUBBLE on a miss.
//
// COUNTER-TEST: putting the old fallback back (replace the final `return prev` by appending to the
// last bubble) fails the third case below, and with it the promise that an orphaned subagent
// stream does not end up in the answer of the main agent (two streams in one text block, mixed
// character by character).
const append = (text) => (blocks) => {
  const copy = [...blocks];
  const last = copy[copy.length - 1];
  if (last?.kind === "text") copy[copy.length - 1] = { kind: "text", text: last.text + text };
  else copy.push({ kind: "text", text });
  return copy;
};

test("Subagent text: the call stands two bubbles further up, and is found anyway", () => {
  const prev = [
    { role: "assistant", blocks: [tool("P", { name: "Task" })] },
    { role: "approval", blocks: [] },
    { role: "assistant", blocks: [{ kind: "text", text: "The main agent writes." }] },
  ];
  const next = mutateUnderParent(prev, "P", append("Subagent report."));
  assert.notEqual(next, prev);
  assert.deepEqual(next[0].blocks[0].children, [{ kind: "text", text: "Subagent report." }]);
  // The main agent's bubble stays untouched: the same object, the same text.
  assert.equal(next[2], prev[2]);
  assert.equal(next[2].blocks[0].text, "The main agent writes.");
});

test("Subagent text: a child of the child is found as well", () => {
  const prev = [{ role: "assistant", blocks: [tool("P", { name: "Task", children: [tool("K")] })] }];
  const next = mutateUnderParent(prev, "K", append("deep"));
  assert.deepEqual(next[0].blocks[0].children[0].children, [{ kind: "text", text: "deep" }]);
});

test("Orphaned subagent text: NOTHING is touched, least of all the main bubble", () => {
  const prev = [{ role: "assistant", blocks: [{ kind: "text", text: "The main agent writes." }] }];
  const next = mutateUnderParent(prev, "unknown", append("12 KB report"));
  // The same array (no re-render) and above all: no foreign text in the answer.
  assert.equal(next, prev);
  assert.equal(prev[0].blocks.length, 1);
  assert.equal(prev[0].blocks[0].text, "The main agent writes.");
  // A user bubble never becomes the substitute parent either.
  const onlyUser = [{ role: "user", blocks: [tool("P")] }];
  assert.equal(mutateUnderParent(onlyUser, "P", append("x")), onlyUser);
});

// ── Filling in the input (the start of a tool from the loop engine) ──────────────────────────
// The block is created at the start of the call (content_block_start), its input arrives with the finished call; in between
// a bubble of its own can attach (monitor line, approval card of the previous call). A search in the LAST bubble then did not
// find it, and the histories created a second row. The same search as for the result.
// COUNTER-TEST: the same search only over `prev.at(-1)` fails the first case (the same array back, the row would stay empty).
test("applyToolInput: the input finds the block behind a card bubble, also as a child; without a hit the same array", () => {
  const prev = [
    { role: "assistant", blocks: [{ kind: "text", text: "I am starting." }, tool("X", { detail: "old" })] },
    { role: "monitor", blocks: [] },
  ];
  const next = applyToolInput(prev, "X", { command: "ls" }, "ls");
  assert.notEqual(next, prev);
  assert.deepEqual(next[0].blocks[1], { ...tool("X"), input: { command: "ls" }, detail: "ls" });
  assert.equal(next[1], prev[1], "the card bubble stays the same object");
  assert.equal(prev[0].blocks[1].input, undefined, "the input is untouched");
  // An empty detail does not overwrite the old one (as upsertTool did before).
  assert.equal(applyToolInput(prev, "X", { script: "x" }, "")[0].blocks[1].detail, "old");
  // A child call of a subagent.
  const nested = [{ role: "assistant", blocks: [tool("P", { name: "Task", children: [tool("K")] })] }];
  assert.deepEqual(applyToolInput(nested, "K", { pattern: "*" }, "*")[0].blocks[0].children[0], { ...tool("K"), input: { pattern: "*" }, detail: "*" });
  // Unknown id, user bubble: the same array; the caller then creates it.
  assert.equal(applyToolInput(prev, "Z", {}, ""), prev);
  const onlyUser = [{ role: "user", blocks: [tool("X")] }];
  assert.equal(applyToolInput(onlyUser, "X", {}, ""), onlyUser);
});

// Codex counts its item ids anew per process (item_0, item_1, ... in every turn and every subagent, `connectors/codex.js`
// takes `item.id` raw). A finished block with the same id is a DIFFERENT call: only an open block is hit
// (without input and result, which is how content_block_start alone creates it).
// COUNTER-TEST: the condition on `bl.id === id` alone turns "turn 2" red (the old `ls` block is overwritten).
test("applyToolInput: repeated Codex ids: a finished or already filled block is a different call", () => {
  // Turn 1 is finished in the history, turn 2 brings the same name item_1 without a streaming start.
  const history = [
    { role: "assistant", blocks: [tool("item_1", { input: { command: "ls" }, detail: "ls", result: "a.txt", done: true })] },
    { role: "user", blocks: [] },
    { role: "assistant", blocks: [] },
  ];
  assert.equal(applyToolInput(history, "item_1", { command: "pwd" }, "pwd"), history, "turn 2: no hit, the caller creates it");
  // Two Codex subagents, one item_1 each: the child of A is filled but still without a result.
  const subs = [{ role: "assistant", blocks: [
    tool("toolu_A", { name: "cbase_agent", input: { prompt: "a" }, children: [tool("item_1", { input: { command: "ls A" } })] }),
    tool("toolu_B", { name: "cbase_agent", input: { prompt: "b" }, children: [] }),
  ] }];
  assert.equal(applyToolInput(subs, "item_1", { command: "ls B" }, "ls B"), subs, "the child of A stays untouched");
  // A Codex main call item_1 (filled) and the same name in the subagent: the agent row keeps its input.
  const main = [{ role: "assistant", blocks: [tool("item_1", { name: "cbase_agent", input: { prompt: "x" } })] }];
  assert.equal(applyToolInput(main, "item_1", { command: "ls sub" }, "ls sub"), main);
  // The open block of the same name behind the finished one is still found.
  const open = [...history.slice(0, 2), { role: "assistant", blocks: [tool("item_1")] }, { role: "monitor", blocks: [] }];
  const next = applyToolInput(open, "item_1", { command: "pwd" }, "pwd");
  assert.deepEqual(next[2].blocks[0], { ...tool("item_1"), input: { command: "pwd" }, detail: "pwd" });
  assert.equal(next[0], open[0], "turn 1 stays the same object");
});

// The histories ask the helper before they create: the coding chat (chatBubbles.ts, checked functionally in the reducer
// test). The agent dock and the manager chat that once stood here are gone.
// COUNTER-TEST (on a copy of the tree): a chatBubbles.ts whose upsertTool does not ask applyToolInput turns
// "...: upsertTool does not ask applyToolInput" red.
test("upsertTool in the coding chat searches via applyToolInput before it creates", () => {
  for (const rel of ["src/components/chat/chatBubbles.ts"]) {
    const q = fs.readFileSync(path.join(webDir, rel), "utf8");
    const i = q.indexOf("function upsertTool(");
    assert.ok(i >= 0, `${rel}: upsertTool is missing`);
    const body = q.slice(i, q.indexOf(rel.endsWith(".ts") ? "\n}\n" : "\n  }\n", i)); // top level or inside the component
    assert.match(body, /applyToolInput\((prev|bubbles), id, input, detail\)/, `${rel}: upsertTool does not ask applyToolInput`);
    assert.ok(body.indexOf("applyToolInput(") < body.search(/inBubbles\(|mutateBlocks\(/), `${rel}: it is only created without a hit`);
  }
});
