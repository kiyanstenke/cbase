// Project creation, slice 2 — the client side of the removal of "Detect". The server no longer has
// `GET /api/workspaces/:id/detect-projects` and `POST /api/workspaces/:id/projects/import` (guards tools/check/routes.test.mjs and
// server/backend/test/tool-list-without-project-create.test.js: 404 on the real server). A client that still calls them would get a
// 404 — the "Detect" button would show an error, and after creating a workspace the detection would run into the void.
//
// The promise: no client carries either path — web (`web/src`), iOS (`mobile/CbaseMobile`) and the client shell (`client/`).
// Comments do not count (they tell what was dropped). In addition `GET /api/projectbox/relocation-tick`, the route of the dropped
// relocation beat (its successor `/api/projectbox/ops-status` only reads the operator's status check). No client ever carried it — the guard
// holds that none reintroduces it; the sabotage (2) shows the pattern red. A seam guard that reads client source only for dropped
// routes — no UI test.
//
// Counter-test: against the state before the removal, (1) is red at exactly the four places of web and iOS (workspaces/page.tsx:
// detect-projects and projects/import; Code/ProjectsPane.swift: projects/import and detect-projects). The built-in sabotage (2) shows
// the patterns red on artificial sources and a comment green.
//
// Run:  node --test web/test/project-creation-legacy-data.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");

// The path as a segment: `/detect-projects` and `/projects/import` (not `/projects/imported`, not `/projects/<id>`).
const PATTERN = [
  ["detect-projects", /\/detect-projects(?![\w-])/],
  ["projects/import", /\/projects\/import(?![\w-])/],
  ["relocation-tick", /\/projectbox\/relocation-tick(?![\w-])/],
];
const SUFFIXES = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".swift"]);

function files(root) {
  const output = [];
  const go = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "dist" || e.name === "out") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) go(p);
      else if (SUFFIXES.has(path.extname(e.name))) output.push(p);
    }
  };
  go(root);
  return output;
}
// Lines that are only a comment drop out — a header that tells what was dropped is not a call.
const isComment = (z) => /^\s*(\/\/|\/\*|\*|\{\/\*)/.test(z);
/** The findings of a source: `<pattern>:<line>` per hit outside comment lines. */
function hits(text) {
  const output = [];
  text.split("\n").forEach((z, i) => {
    if (isComment(z)) return;
    for (const [name, re] of PATTERN) if (re.test(z)) output.push(`${name}:${i + 1}`);
  });
  return output;
}

test("(1) no client calls GET …/detect-projects, POST …/projects/import or GET /api/projectbox/relocation-tick (web, iOS, client shell)", () => {
  const roots = [path.join(webDir, "src"), path.join(repo, "mobile", "CbaseMobile"), path.join(repo, "client")];
  const all = roots.flatMap(files);
  assert.ok(all.length > 300, `too few sources read (${all.length}) — paths moved?`);
  const findings = all.map((d) => [path.relative(repo, d), hits(fs.readFileSync(d, "utf8"))]).filter(([, t]) => t.length);
  assert.deepEqual(findings, [], "dropped route still in use");
});

test("(2) sabotage: the patterns hit artificial sources, a comment does not", () => {
  assert.deepEqual(hits("const det = await api(`/api/workspaces/${wsId}/detect-projects`);"), ["detect-projects:1"]);
  assert.deepEqual(hits('await api(`/api/workspaces/${id}/projects/import`, { method: "POST" });'), ["projects/import:1"]);
  assert.deepEqual(hits('let r: X = try await client.get("/api/workspaces/\\(workspace.id)/detect-projects")'), ["detect-projects:1"]);
  assert.deepEqual(hits('x\n    try await client.send("/api/workspaces/\\(workspace.id)/projects/import", body: b)'), ["projects/import:2"]);
  assert.deepEqual(hits('const t = await api("/api/projectbox/relocation-tick");'), ["relocation-tick:1"]);
  assert.deepEqual(hits('let t: T = try await client.get("/api/projectbox/relocation-tick")'), ["relocation-tick:1"]);
  assert.deepEqual(hits("  // GET …/detect-projects and POST …/projects/import were dropped"), [], "a comment does not count");
  assert.deepEqual(hits("  /* /detect-projects */"), [], "a block comment does not count");
  // Neighbors that stay: creating, a project, another word.
  assert.deepEqual(hits('await api(`/api/workspaces/${id}/projects`, { method: "POST" });'), []);
  assert.deepEqual(hits("await api(`/api/workspaces/${id}/projects/${pid}`, { method: \"DELETE\" });"), []);
  assert.deepEqual(hits('const p = "/projects/imported";'), []);
  assert.deepEqual(hits('const b = "/api/projectbox/ops-status";'), [], "the successor is not a dropped route");
});
