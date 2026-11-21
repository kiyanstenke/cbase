// Dynamic workflows: a line that names a parent call the history does not (or no longer) know — for example because a compaction
// lost the call line — is discarded on EVERY path, for every line kind that can carry a parent call (text, thinking, tool). Here the
// two paths of the Coding chat in the web: the history build from the database (`buildBubbles`, rows in the form that runs/do-run.js
// and runs/agents.js write) and the live stream (`reduceChatEvent`, events with `parent_tool_use_id`). Both must show the SAME thing:
// after a reload the chat looks like it did in the stream. An entry with a KNOWN parent call still lands under its block.
//
// COUNTER-TEST: the old history build ("better into the bubble than lost") hangs the subagent text with an unknown parent call into
// the main bubble — the main-bubble check is then red, and both paths diverge.
//
// chatBubbles.ts is compiled without tsconfig as in reducer.test.mjs (leaf module).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let mod = null;
const out = fs.existsSync(tsc) ? fs.mkdtempSync(path.join(webDir, "node_modules", ".parent-test-")) : null;
if (out) {
  execFileSync(process.execPath, [
    tsc, path.join(webDir, "src", "components", "chat", "chatBubbles.ts"),
    "--outDir", out, "--rootDir", path.join(webDir, "src"), "--module", "es2022", "--target", "es2022",
    "--moduleResolution", "bundler", "--noCheck", "--isolatedModules", "--skipLibCheck",
  ], { cwd: webDir, stdio: "pipe" });
  mod = await import(pathToFileURL(path.join(out, "components", "chat", "chatBubbles.js")).href);
  try { fs.rmSync(out, { recursive: true, force: true }); }
  catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }
}

const AGENT = "mcp__cbase__cbase_agent";
const WAY = "toolu_compacted"; // the call whose line the compaction lost
const js = (o) => JSON.stringify(o);

// The scenario as database rows: a known agent call with text, thinking and tool below it, plus one line of each kind under the
// UNKNOWN call — including a child under the discarded tool and its result.
function rows() {
  const z = [];
  const add = (role, text) => z.push({ id: z.length + 1, role, text, ts: z.length + 1, attachments: [] });
  add("user", "Check this");
  add("assistant", "I ask an agent.");
  add("tool", js({ name: AGENT, detail: "Check", id: "toolu_known", input: { description: "Check" } }));
  add("sub_text", js({ text: "known finding", parent: "toolu_known" }));
  add("thinking", js({ text: "known thinking", parent: "toolu_known" }));
  add("tool", js({ name: "Read", detail: "/tmp/a", id: "toolu_r_known", input: { file_path: "/tmp/a" }, parent: "toolu_known" }));
  add("sub_text", js({ text: "orphaned finding", parent: WAY }));
  add("thinking", js({ text: "orphaned thinking", parent: WAY }));
  add("tool", js({ name: "Grep", detail: "x", id: "toolu_g_way", input: { pattern: "x" }, parent: WAY }));
  add("sub_text", js({ text: "orphaned grandchild", parent: "toolu_g_way" }));
  add("tool_result", js({ id: "toolu_g_way", result: "hits", isError: false }));
  add("assistant", "finished");
  return z;
}

// The same scenario as live stream — text and thinking as deltas, tools as assistant event (like subagent tools).
function events() {
  const toolUse = (id, name, input, parent = null) => ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name, input }] } });
  const delta = (d, parent) => ({ type: "stream_event", parent_tool_use_id: parent, event: { type: "content_block_delta", index: 0, delta: d } });
  const text = (s, parent = null) => delta({ type: "text_delta", text: s }, parent);
  const thinking = (s, parent) => delta({ type: "thinking_delta", thinking: s }, parent);
  return [
    { type: "harness", subtype: "run_started" },
    text("I ask an agent."),
    toolUse("toolu_known", AGENT, { description: "Check" }),
    text("known finding", "toolu_known"),
    thinking("known thinking", "toolu_known"),
    toolUse("toolu_r_known", "Read", { file_path: "/tmp/a" }, "toolu_known"),
    text("orphaned finding", WAY),
    thinking("orphaned thinking", WAY),
    toolUse("toolu_g_way", "Grep", { pattern: "x" }, WAY),
    text("orphaned grandchild", "toolu_g_way"),
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_g_way", content: "hits" }] } },
    text("finished"),
  ];
}

function fromStream() {
  const tt = (key, params) => key.replace(/\{(\w+)\}/g, (_, n) => String(params?.[n] ?? `{${n}}`));
  let stream = { open: false, gotText: false };
  let now = Date.UTC(2026, 8, 25, 12, 0, 0);
  let bubbles = [];
  for (const evt of events()) {
    const c = { stream, now, wfStatus: undefined, activeId: "c1", joined: false, runStart: null, inTok: 0, outTok: 0, t: tt, resultToText: (x) => String(x ?? "") };
    bubbles = mod.reduceChatEvent(bubbles, evt, c);
    stream = mod.streamAfterEvent(evt, c);
    now += 1000;
  }
  return bubbles;
}

// What lands where: per content the path of the call ids above it. The stream merges the main bubble into ONE text block, the
// history does not — so it is compared as text (`mainTexts`), everything below block by block (`under`).
function situation(bubbles) {
  const z = [];
  const run = (blocks, filePath) => {
    for (const b of blocks || []) {
      if (b.kind === "tool") { z.push(`${filePath}/tool:${b.id}`); run(b.children, `${filePath}/${b.id}`); }
      else if (b.kind === "text" || b.kind === "thinking") z.push(`${filePath}/${b.kind}:${b.text}`);
    }
  };
  for (const b of bubbles.filter((x) => x.role === "assistant")) run(b.blocks, "");
  return z;
}
const under = (bubbles) => situation(bubbles).filter((z) => !/^\/(text|thinking):/.test(z));
const mainTexts = (bubbles) => bubbles.filter((b) => b.role === "assistant").flatMap((b) => b.blocks)
  .filter((b) => b.kind === "text" || b.kind === "thinking").map((b) => b.text).join("");

function check(bubbles, way) {
  assert.equal(mainTexts(bubbles), "I ask an agent.finished", `${way}: the main bubble holds only the answer of the main agent`);
  const l = situation(bubbles).join("\n");
  for (const s of ["orphaned", "toolu_g_way"]) assert.ok(!l.includes(s), `${way}: "${s}" was filed — discarded means nowhere`);
  // Known parent call: text, thinking and tool under its block.
  for (const s of ["/toolu_known/text:known finding", "/toolu_known/thinking:known thinking", "/toolu_known/tool:toolu_r_known"]) {
    assert.ok(l.includes(s), `${way}: ${s} is missing under the known block`);
  }
}

test("history build: text, thinking and tool under an unknown parent call are dropped, nothing in the main bubble", (t) => {
  if (!mod) { t.skip("node_modules missing (tsc) — chatBubbles cannot be checked"); return; }
  check(mod.buildBubbles(rows()), "History");
});

test("live stream: same scenario, same result", (t) => {
  if (!mod) { t.skip("node_modules missing (tsc) — chatBubbles cannot be checked"); return; }
  check(fromStream(), "Stream");
});

test("a reload looks like the stream: history build and reducer put every content in the same place", (t) => {
  if (!mod) { t.skip("node_modules missing (tsc) — chatBubbles cannot be checked"); return; }
  assert.deepEqual(under(mod.buildBubbles(rows())), under(fromStream()));
  assert.equal(mainTexts(mod.buildBubbles(rows())), mainTexts(fromStream()));
});
