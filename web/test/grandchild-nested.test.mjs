// Dynamic workflows, depth 3: two children started in parallel, each with a grandchild — on the web each grandchild sits
// under the call block of ITS OWN parent agent, nested, nothing in the main bubble, nothing dropped.
// Both UI paths: the history from the database (`buildBubbles`, rows in the shape the server writes —
// server/backend/test/agent-depth.test.js covers the server side) and the live stream (`reduceChatEvent`, events with
// `parent_tool_use_id`). Counter-test: the same rows with the assignment of a LIFO fallback (the most recently opened
// block wins) turn the check red; it therefore measures the assignment, not just the shape.
//
// chatBubbles.ts is compiled without tsconfig, as in reducer.test.mjs (leaf module).
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
const out = fs.existsSync(tsc) ? fs.mkdtempSync(path.join(webDir, "node_modules", ".grandchild-test-")) : null;
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
const js = (o) => JSON.stringify(o);

// The rows the server writes for two parallel children (ONE, TWO), each with a grandchild. `parent(w)` says under which
// child block the grandchild of w sits — the correct one is its OWN.
function history(parent = (w) => `toolu_k_${w}`) {
  const z = [];
  const add = (role, text) => z.push({ id: z.length + 1, role, text, ts: z.length + 1, attachments: [] });
  add("user", "Two chains");
  add("tool", js({ name: AGENT, detail: "Part ONE", id: "toolu_one", input: { description: "Part ONE" } }));
  add("tool", js({ name: AGENT, detail: "Part TWO", id: "toolu_two", input: { description: "Part TWO" } }));
  for (const [w, main] of [["ONE", "toolu_one"], ["TWO", "toolu_two"]]) {
    add("tool", js({ name: AGENT, detail: `Child of ${w}`, id: `toolu_k_${w}`, input: { description: `Child of ${w}` }, parent: main }));
  }
  for (const w of ["ONE", "TWO"]) {
    add("sub_text", js({ text: `Finding ${w}-2`, parent: parent(w) }));
    add("tool", js({ name: "Read", detail: `/tmp/${w}-2`, id: `toolu_r_${w}`, input: { file_path: `/tmp/${w}-2` }, parent: parent(w) }));
  }
  for (const w of ["ONE", "TWO"]) {
    add("tool_result", js({ id: `toolu_k_${w}`, result: js({ agentId: `a-${w}-2`, status: "completed", report: `Finding ${w}-2` }), isError: false }));
    add("sub_text", js({ text: `Finding ${w}`, parent: w === "ONE" ? "toolu_one" : "toolu_two" }));
  }
  add("assistant", "finished");
  return z;
}

// The tree under a block: the texts and tool ids of its children, recursive per tool.
const blockWith = (blocks, id) => {
  for (const b of blocks || []) {
    if (b.kind === "tool" && b.id === id) return b;
    const deep = blockWith(b.children, id);
    if (deep) return deep;
  }
  return null;
};
const texts = (b) => (b?.children || []).filter((c) => c.kind === "text").map((c) => c.text);
const tools = (b) => (b?.children || []).filter((c) => c.kind === "tool").map((c) => c.id);

// The check: each grandchild under the block of its OWN parent agent, the child block under the main block, only the answer
// in the main bubble, nothing dropped.
function checkNesting(bubbles) {
  const asst = bubbles.filter((b) => b.role === "assistant");
  const all = asst.flatMap((b) => b.blocks);
  const top = all.filter((b) => b.kind === "text").map((b) => b.text);
  assert.deepEqual(top, ["finished"], "the main bubble holds only the main agent's answer");
  for (const [w, main] of [["ONE", "toolu_one"], ["TWO", "toolu_two"]]) {
    const h = blockWith(all, main);
    assert.ok(h, `main block ${main} is missing`);
    assert.ok(tools(h).includes(`toolu_k_${w}`), `the child block of ${w} is not under ${main}`);
    const k = blockWith(h.children, `toolu_k_${w}`);
    assert.deepEqual(texts(k), [`Finding ${w}-2`], `the wrong grandchild is under the block of child ${w}`);
    assert.deepEqual(tools(k), [`toolu_r_${w}`], `the tools of the grandchild of ${w}`);
  }
}

test("history from the database: each grandchild under its own parent block — the LIFO assignment is caught", (t) => {
  if (!mod) { t.skip("node_modules missing (tsc) — chatBubbles not testable"); return; }
  checkNesting(mod.buildBubbles(history()));
  // Counter-test: LIFO — both grandchildren under the most recently opened block (TWO).
  assert.throws(() => checkNesting(mod.buildBubbles(history(() => "toolu_k_TWO"))), /wrong grandchild/);
});

test("live stream: child and grandchild events with parent_tool_use_id land nested, nothing in the main bubble", (t) => {
  if (!mod) { t.skip("node_modules missing (tsc) — chatBubbles not testable"); return; }
  const tt = (key, params) => key.replace(/\{(\w+)\}/g, (_, n) => String(params?.[n] ?? `{${n}}`));
  let stream = { open: false, gotText: false };
  let now = Date.UTC(2026, 8, 24, 12, 0, 0);
  const ctx = () => ({ stream, now, wfStatus: undefined, activeId: "c1", joined: false, runStart: null, inTok: 0, outTok: 0, t: tt, resultToText: (c) => String(c ?? "") });
  const toolUse = (id, name, input, parent = null) => ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name, input }] } });
  const text = (s, parent) => ({ type: "stream_event", parent_tool_use_id: parent, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } } });
  const events = [
    { type: "harness", subtype: "run_started" },
    toolUse("toolu_one", AGENT, { description: "Part ONE" }),
    toolUse("toolu_two", AGENT, { description: "Part TWO" }),
    toolUse("toolu_k_ONE", AGENT, { description: "Child of ONE" }, "toolu_one"),
    toolUse("toolu_k_TWO", AGENT, { description: "Child of TWO" }, "toolu_two"),
    // The grandchildren write interleaved — each under its own parent block.
    text("Finding TWO-2", "toolu_k_TWO"),
    text("Finding ONE-2", "toolu_k_ONE"),
    toolUse("toolu_r_ONE", "Read", { file_path: "/tmp/ONE-2" }, "toolu_k_ONE"),
    toolUse("toolu_r_TWO", "Read", { file_path: "/tmp/TWO-2" }, "toolu_k_TWO"),
    text("finished", null),
  ];
  let bubbles = [];
  for (const evt of events) {
    const c = ctx();
    bubbles = mod.reduceChatEvent(bubbles, evt, c);
    stream = mod.streamAfterEvent(evt, c);
    now += 1000;
  }
  checkNesting(bubbles);
});
