// Approval marks per workspace.
//
// Before the managing teardown a browser test bench measured the marks at the manager (MCP
// page, the switch writes the mark). Now the "Approval marks" section in the outer loop sets them (web
// `components/outerloop/ApprovalMarks.tsx`, iOS `Code/ApprovalMarks.swift`), and no test bench walked that path any
// more. This file holds it in the gate:
//
//   1. Wire (lib/api/outerloop.ts) with a fake fetch, after the pattern of skills.test.mjs "wire": GET and PUT on
//      `/api/workspaces/:id/approval-marks`, the id encoded, the PUT body ALWAYS carries `tools`, even when empty (a
//      missing `tools` is a 400 at the server, not "no mark"; "empty is not unknown"), `normMarkers` takes only
//      strings and turns missing into an empty list, a server error throws with ITS text (the section takes the
//      switch back on it).
//   2. Binding: OuterLoopPane renders the section in web AND iOS, both sections speak only over this one path, and
//      the Swift body carries `tools` as a non-optional list (a synthesized Encodable would LEAVE OUT a `nil`). iOS is
//      read as text; no Swift compiler, hence NOT `onlyMacOS`.
//
// Counter-tests (each alone in a copy of web/src and the two Swift files, exactly one test red): `setApprovalMarks`
// sends `{}` on an empty list turns "wire: PUT" red; `normMarkers` takes `tools` unfiltered turns "wire: normMarkers"
// red; the line `<ApprovalMarksSection …/>` removed from OuterLoopPane.tsx turns "binding: web" red;
// `ApprovalMarksRow(…)` removed from OuterLoopPane.swift turns "binding: iOS" red; `let tools: [String]?` in the
// Swift body turns "binding: iOS" red.
//
// Run:  node --test --test-reporter=tap web/test/approval-marks.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-approval-markers-"));
after(() => { try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
// The wire: lib/api/outerloop.ts with core.ts; leaf modules with `.js` specifiers (README in lib/api/).
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "api", "outerloop.ts"), "--module", "esnext", "--target", "es2022",
  "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom", "--outDir", out,
], { cwd: webDir, stdio: "pipe" });
const wire = await import(pathToFileURL(path.join(out, "outerloop.js")).href);

const read = (abs) => fs.readFileSync(abs, "utf8");
// Comments drop out before every measurement; the history may stand there without coloring the test.
const withoutComments = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// A fake fetch: records every call and answers with `situation` (status and body).
function withFetch() {
  const prior = globalThis.fetch;
  const calls = [];
  const situation = { status: 200, body: {} };
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method ?? "GET", body: opts.body ?? null });
    return new Response(JSON.stringify(situation.body), { status: situation.status, headers: { "content-type": "application/json" } });
  };
  return { calls, situation, back: () => { globalThis.fetch = prior; } };
}

// ── 1. Wire ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("wire: GET on /api/workspaces/:id/approval-marks, the id encoded", async () => {
  const f = withFetch();
  try {
    f.situation.body = { tools: ["cbase_doc_delete"], markable: ["cbase_doc_delete", "cbase_todo_add"] };
    const state = await wire.loadApprovalMarks("w 1/x");
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0].url.endsWith("/api/workspaces/w%201%2Fx/approval-marks"), f.calls[0].url);
    assert.equal(f.calls[0].method, "GET");
    assert.equal(f.calls[0].body, null);
    assert.deepEqual(state, { tools: ["cbase_doc_delete"], markable: ["cbase_doc_delete", "cbase_todo_add"] });
  } finally { f.back(); }
});

test("wire: PUT always carries `tools`, even the empty list, and nothing else", async () => {
  const f = withFetch();
  try {
    f.situation.body = { tools: ["a", "b"], markable: ["a", "b", "c"] };
    const state = await wire.setApprovalMarks("w1", ["a", "b"]);
    assert.ok(f.calls[0].url.endsWith("/api/workspaces/w1/approval-marks"), f.calls[0].url);
    assert.equal(f.calls[0].method, "PUT");
    assert.deepEqual(JSON.parse(f.calls[0].body), { tools: ["a", "b"] });
    assert.deepEqual(state, { tools: ["a", "b"], markable: ["a", "b", "c"] }, "the server's answer is the new state");

    f.situation.body = { tools: [], markable: ["a"] };
    await wire.setApprovalMarks("w1", []);
    assert.equal(f.calls[1].method, "PUT");
    assert.deepEqual(JSON.parse(f.calls[1].body), { tools: [] }, "\"no mark\" is an empty list, not a missing field");
  } finally { f.back(); }
});

test("wire: normMarkers takes only strings, missing becomes the empty list", async () => {
  const f = withFetch();
  try {
    f.situation.body = { tools: ["a", 3, null, "b", { x: 1 }], markable: "a,b", foreign: true };
    assert.deepEqual(await wire.loadApprovalMarks("w1"), { tools: ["a", "b"], markable: [] });
    f.situation.body = {};
    assert.deepEqual(await wire.loadApprovalMarks("w1"), { tools: [], markable: [] });
    f.situation.body = [];
    assert.deepEqual(await wire.loadApprovalMarks("w1"), { tools: [], markable: [] });
  } finally { f.back(); }
});

test("wire: a server error throws with its text (the section takes the switch back on it)", async () => {
  const f = withFetch();
  try {
    f.situation.status = 400;
    f.situation.body = { error: "tools missing" };
    await assert.rejects(() => wire.setApprovalMarks("w1", ["a"]), /tools missing/);
  } finally { f.back(); }
});

// ── 2. Binding: web and iOS render the section ───────────────────────────────────────────────────────────────────────────────

test("binding: web — OuterLoopPane renders the section, the section speaks only over the wire", () => {
  const pane = withoutComments(read(path.join(webDir, "src/components/outerloop/OuterLoopPane.tsx")));
  assert.match(pane, /import\s*\{[^}]*\bApprovalMarksSection\b[^}]*\}\s*from\s*"@\/components\/outerloop\/ApprovalMarks"/,
    "OuterLoopPane imports ApprovalMarksSection");
  assert.match(pane, /<ApprovalMarksSection\s+workspaceId=\{workspaceId\}/, "OuterLoopPane renders <ApprovalMarksSection workspaceId={workspaceId} …/>");

  const part = withoutComments(read(path.join(webDir, "src/components/outerloop/ApprovalMarks.tsx")));
  assert.ok(part.includes("loadApprovalMarks(workspaceId)"), "the section loads through loadApprovalMarks");
  assert.ok(part.includes("setApprovalMarks(workspaceId, tools)"), "the section writes through setApprovalMarks");
  assert.ok(!/fetch\(|\/api\//.test(part), "no way of its own past the wire");
});

test("binding: iOS — OuterLoopPane renders the row, GET and PUT on the same path, `tools` not optional", () => {
  const pane = withoutComments(read(path.join(repo, "mobile/CbaseMobile/Code/OuterLoopPane.swift")));
  assert.match(pane, /ApprovalMarksRow\(\s*client:\s*client,\s*workspaceId:\s*workspaceId/, "OuterLoopPane.swift renders ApprovalMarksRow(client:workspaceId:…)");

  const part = withoutComments(read(path.join(repo, "mobile/CbaseMobile/Code/ApprovalMarks.swift")));
  const filePath = "\"/api/workspaces/\\(workspaceId)/approval-marks\"";
  const hits = part.split(filePath).length - 1;
  assert.ok(hits >= 2, `GET and PUT on ${filePath}; found ${hits}×`);
  assert.match(part, /client\.get\(\s*"\/api\/workspaces\/\\\(workspaceId\)\/approval-marks"/, "GET through client.get");
  assert.match(part, /body:\s*ApprovalMarksBody\(tools:\s*tools\)/, "PUT with ApprovalMarksBody(tools:)");
  assert.match(part, /struct ApprovalMarksBody: Encodable \{ let tools: \[String\] \}/,
    "the body carries `tools` as a non-optional list; a `[String]?` would let the synthesized Encodable drop it on nil");

  // The same path as in the web wire, except for the interpolation of the id.
  const webWire = read(path.join(webDir, "src/lib/api/outerloop.ts"));
  assert.ok(webWire.includes("`/api/workspaces/${enc(wid)}/approval-marks`"), "the web wire names the same path");
});
