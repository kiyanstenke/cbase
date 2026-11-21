// The FORM of a context entry, checked on write (server/projects/context-form.js): per pattern the hits that MUST give a hint and
// the false alarms that must give NONE (UUID, color value, sha256, date, path with "feature/", a branch as the subject of the
// knowledge, "state of the art" (German "Stand der Technik"), "Status-Codes", "C#" …), plus the lock over CONTEXT_BODY_LIMIT — only with the mark `ofAgent`,
// which only the MCP tools set — and its exception for existing entries. Behind it the runtime (no unbounded quantifier; pathological
// inputs under a deadline against hangs) and the seams: the routes (project POST/PUT, workspace POST/PUT, the project dump) carry
// `formHints`, a human never gets a 400 for the length, an agent over the REAL MCP server does — and `problems` reach it as text.
//
// The test data is German ON PURPOSE where the patterns are bilingual by design (German status headings such as "next steps", "open",
// "state", and a branch after the German "auf" …).
//
// Counter-tests (which sabotage turns which test red):
//   COMMIT without the commit word, BRANCH without the lookbehind, STATUS_WORD without the end anchor => "false-alarm counter-cases" red;
//   the check in the POST route replaced by an empty result => "form at the routes" red; "over 6,000 characters" removed from the
//   description of cbase_context_create => "the descriptions … name the limit" red; project dump and workspace dump without
//   withFormHints => "form at the routes" red.
//   The old patterns HEADING and CHECKBOX back => "pattern: no unbounded quantifier" red (the old HEADING also "pathological inputs"
//   at the deadline); the lock without the mark (`lock: true` fixed) => "lock only for agents" red; `ofAgent` removed from the tool
//   cbase_context_create => "… over the real MCP server" red; errorText in mcp/lib.js only `error` again => "… over the real MCP
//   server" red (problems); the length hint only up to the limit => "locks only `lock`" and "form at the routes" red; the workspace PUT
//   without hints, without lock => red each; `ofAgent` removed from cbase_workspace_context_update => "… over the real MCP server" red;
//   the old BRANCH pattern => "false-alarm counter-cases" (branch as subject) and the pattern guard red.
// Not covered: MERGING in the project dump (needs a duplicate hit).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTEXT_BODY_LIMIT, CONTEXT_BODY_HINT, CONTEXT_FORM_PATTERN, CONTEXT_CHECK_TEXT_CAP, formRejectionText, withFormHints, checkContextForm,
} from "../electron/server/projects/context-form.js";
import { TOOLS } from "../electron/mcp/catalog.js";
import { setUiLang } from "../electron/server/i18n.js";
import { json, makeProject, makeWorkspace, withMcp, withServer } from "./server-harness.mjs";

const FORM_FILE = fileURLToPath(new URL("../electron/server/projects/context-form.js", import.meta.url));
const hints = (f, o) => checkContextForm(f, o).formHints;
const one = (f, pattern, fall) => {
  const h = hints(f);
  assert.equal(h.length, 1, `${fall}: ${JSON.stringify(h)}`);
  assert.match(h[0], pattern, fall);
};
const none = (f, fall) => assert.deepEqual(hints(f), [], fall);

test("Form: every pattern gives EXACTLY its hint", () => {
  one({ body: "x".repeat(CONTEXT_BODY_HINT + 1) }, /body has 2001 characters/, "long body");
  one({ body: "Gebaut auf feature/login-new, danach gemergt." }, /the branch "feature\/login-new"/, "feature branch");
  one({ summary: "Liegt auf `fix/rundung` bereit." }, /the branch "fix\/rundung"/, "fix branch in summary");
  one({ body: "## Zwei Bugs (behoben, Branch `fix/issue-106-render`)" , category: "pitfalls" }, /the branch "fix\/issue-106-render"/, "fixed in the branch");
  one({ body: "**Branch:** `feat/neu` → develop" }, /the branch "feat\/neu"/, "bold branch with colon");
  one({ body: "Seit Commit a1b2c3d rechnet alles in Cent." }, /commit hash \("a1b2c3d"\)/, "commit hash");
  one({ body: "Stand: 3f9e2c1d8b — geprüft." }, /commit hash \("3f9e2c1d8b"\)/, "Stand with hash");
  one({ body: "HEAD@9c0ffee1 ist der Anker." }, /commit hash/, "HEAD@hash");
  one({ title: "#42 Login-Fehler behoben" }, /number "#42"/, "issue in the title");
  one({ title: "Rundung nach MR !17" }, /number "MR !17"/, "MR in the title");
  one({ title: "Ticket 815: Cent statt Euro" }, /number "Ticket 815"/, "ticket in the title");
  one({ body: "Text.\n\n## Status\n\nläuft", category: "architecture" }, /status section \("Status"\)/, "status heading");
  one({ body: "Text.\n\n### Nächste Schritte:\n- Tests", category: "architecture" }, /status section \("Nächste Schritte:"\)/, "next steps");
  one({ body: "Text.\n\n## Stand 2026-10-10\n", category: "architecture" }, /status section/, "Stand with date");
  one({ body: "Text.\n\n##   Offen   ##\n", category: "architecture" }, /status section \("Offen"\)/, "heading with closing #");
  one({ body: "Plan:\n- [ ] Migration\n- [x] Schema", category: "architecture" }, /checkboxes/, "checkbox");
  one({ body: "Plan:\n  * [ ]\nweiter", category: "architecture" }, /checkboxes/, "empty checkbox at the line end");
});

test("Form: false-alarm counter-cases give NO hint", () => {
  none({ body: "Die Sitzung trägt die Id 550e8400-e29b-41d4-a716-446655440000, Commit-frei." }, "UUID");
  none({ body: "Commit-Farbe ist #1a2b3c4d im Theme." }, "color value after a commit word");
  none({ body: "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 der leeren Datei." }, "sha256");
  none({ body: "Commit-Hash steht im Anker, der Stand 20261010 ist ein Datum." }, "date after Stand");
  none({ body: "Prüfsumme a1b2c3d4e5 ohne Commit-Bezug." }, "hex without a commit word");
  none({ body: "Commit abgelegt, Stand abgefragt." }, "words made of hex letters");
  none({ body: "Der Code liegt in src/feature/login und app/fix/rundung.ts." }, "path with feature/ and fix/");
  none({ body: "Fix/Workaround: erst die Sitzung schließen." }, "capitalised prose");
  none({ body: "Ein Feature-Flag schaltet es; features/x ist der Ordner." }, "features/ and feature flag");
  // A branch that is itself the subject of the knowledge (against the existing entries): no hint.
  none({ body: "Stamm ist `feat/programmsperre-gate` (echte Prozeduren); die Testsuite wandert aus `feat/permission-enforcement` hinein." }, "trunk branch");
  none({ body: "| | `feat/a` | `feat/b` |\n|---|---|---|\n| Docker | ja | nein |" }, "branch comparison as a table");
  none({ body: "**Beschluss:** `feat/programmsperre-gate` ist der Stamm." }, "decision about a branch");
  none({ body: "Ablauf feature/x ist ein Pfad im Repo." }, "\"auf\" as a word end");
  none({ title: "Alles rechnet in Cent, als Integer" }, "title as a statement");
  none({ title: "C# und F# teilen den Build" }, "C# without a number");
  none({ title: "Top 3 der Fallstricke!" }, "exclamation mark without a number after it");
  none({ title: "Prozess 12 ist der Worker" }, "pr as a word start");
  none({ body: "## Stand der Technik\n\n## Status-Codes der API\n\n## Verlauf der Daten\n\n## C#", category: "architecture" }, "headings that are no status sections");
  none({ body: "####### Status\n\n#Status", category: "architecture" }, "no ATX heading");
  none({ body: "## Offen\n- [ ] Migration klären", category: "open-points" }, "status and checkbox in open-points");
  none({ body: "x".repeat(CONTEXT_BODY_HINT) }, "exactly at the hint limit");
  none({}, "nothing written");
  none({ title: 42, body: null }, "no texts");
});

test("Form: over CONTEXT_BODY_LIMIT only `lock` blocks — when changing, only if the body grows; the length hint is always there", () => {
  const lang = "x".repeat(CONTEXT_BODY_LIMIT + 1);
  // Without a lock (human, dumps): no abort, but the length hint — also over the limit.
  const hint = checkContextForm({ body: lang });
  assert.equal(hint.rejection, null, "without `lock` nothing is ever blocked");
  assert.match(hint.formHints[0], /body has 6001 characters/, "over the limit without the mark: the length hint");
  // With a lock (agent): rejected, back at once — no hints that would belong to an entry that was not written.
  const fresh = checkContextForm({ body: lang + "\n## Status" }, { lock: true });
  assert.deepEqual(fresh.rejection, { length: CONTEXT_BODY_LIMIT + 11, limit: CONTEXT_BODY_LIMIT });
  assert.deepEqual(fresh.formHints, [], "after the lock nothing more is checked");
  const text = formRejectionText(fresh.rejection);
  assert.match(text, /body hat 6011 Zeichen \(Grenze 6000\) — nichts geschrieben/);
  assert.match(text, /open-points/);
  setUiLang("en");
  try { assert.match(formRejectionText(fresh.rejection), /nothing written/, "the English text comes through the translator"); }
  finally { setUiLang("de"); }
  assert.equal(checkContextForm({ body: "x".repeat(CONTEXT_BODY_LIMIT) }, { lock: true }).rejection, null, "exactly at the limit passes");
  const inventory = checkContextForm({ body: lang }, { previousBodyLength: 8961, lock: true });
  assert.equal(inventory.rejection, null, "an old, longer entry stays editable");
  assert.match(inventory.formHints[0], /body has 6001 characters/, "but with a hint");
  assert.ok(checkContextForm({ body: lang }, { previousBodyLength: 6000, lock: true }).rejection, "grown ⇒ rejected");
  assert.deepEqual(withFormHints({ a: 1 }, []), { a: 1 }, "without a hint no field");
  assert.deepEqual(withFormHints({ a: 1 }, ["h"]), { a: 1, formHints: ["h"] });
  // The cap of the pattern check: a finding behind CONTEXT_CHECK_TEXT_CAP characters does not count, the length does.
  const late = checkContextForm({ body: "y".repeat(CONTEXT_CHECK_TEXT_CAP) + "\nSince Commit a1b2c3d." });
  assert.equal(late.formHints.length, 1, JSON.stringify(late.formHints));
  assert.match(late.formHints[0], /body has \d+ characters/);
});

// ── Runtime ──────────────────────────────────────────────────────────────────
// An unbounded quantifier (`*`, `+`, `{n,}`) outside a character class, as a list of locations. Allowed is only `[^\n]*` directly
// before `$` (or `)$`): it runs to the line end, and `$` always succeeds there — no backtracking. Everything else is bounded, so the
// effort per start position is constant and the whole search linear.
function unlimitedQuantifiers(source) {
  const findings = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    let unlimited = c === "*" || c === "+";
    if (c === "{") { const m = /^\{\d+,\}/.exec(source.slice(i)); if (m) unlimited = true; }
    if (!unlimited) continue;
    if (c === "*" && source.slice(i - 5, i) === "[^\\n]" && /^\*\)?\$/.test(source.slice(i))) continue;
    findings.push(source.slice(Math.max(0, i - 12), i + 1));
  }
  return findings;
}

test("Pattern: no unbounded quantifier — an input cannot hold the backend for polynomial time", (t) => {
  // Every pattern of the file stands in CONTEXT_FORM_PATTERN — otherwise this guard would never check a new one.
  const source = fs.readFileSync(FORM_FILE, "utf8");
  const declared = [...source.matchAll(/^const ([A-Z_]+) = \//gm)].map((m) => m[1]);
  assert.ok(declared.length >= 6, `anchor: too few pattern declarations found (${declared.join(", ")})`);
  assert.deepEqual(declared.sort(), Object.keys(CONTEXT_FORM_PATTERN).sort(), "CONTEXT_FORM_PATTERN must carry every pattern of the file");
  for (const [name, re] of Object.entries(CONTEXT_FORM_PATTERN)) assert.deepEqual(unlimitedQuantifiers(re.source), [], name);
  t.diagnostic(`patterns: ${declared.length} checked, at most ${CONTEXT_CHECK_TEXT_CAP} characters per field`);
  // Built-in counter-test: the earlier patterns — the checker must see each of their quantifiers.
  const OLD = {
    HEADING: String.raw`^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$`,
    CHECKBOX: String.raw`^\s*[-*+]\s+\[[ xX]\]\s`,
    BRANCH: String.raw`(?<![\w/.-])(?:feature|feat|fix|bugfix|hotfix|chore|wip|release)\/[\w.\-/]*\w`,
    COMMIT: String.raw`\b(?:commits?|sha|hash|rev(?:ision)?|stand|head)\b[\s:=` + "`" + String.raw`„"'(@]*(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])([0-9a-f]{7,40})(?![\w-])`,
    NUMBER: String.raw`\b((?:issue|mr|merge[- ]request|ticket|pr)\s*[#!]?\d+)\b`,
  };
  for (const [name, q] of Object.entries(OLD)) assert.ok(unlimitedQuantifiers(q).length > 0, `${name}: the checker does not see the old quantifier`);
  // And the exception applies only exactly there; quantifiers in a class and escaped ones do not count.
  assert.deepEqual(unlimitedQuantifiers(String.raw`^#([^\n]*)$`), []);
  assert.equal(unlimitedQuantifiers(String.raw`^#([^\n]*)x`).length, 1);
  assert.equal(unlimitedQuantifiers(String.raw`a{2,}`).length, 1);
  assert.deepEqual(unlimitedQuantifiers(String.raw`[a*+]\*\+a{1,3}[\]*]`), []);
});

// A deadline against HANGS, no time measurement: the old patterns needed minutes for the first input (cubic: 1,600 spaces = 1.8 s,
// 5,000 per line here), the new ones milliseconds. In a child process, so that a regression turns the test red instead of holding
// the suite. What is quadratic and stays fast under the cap (the old CHECKBOX: 20,000 characters ≈ 0.25 s) is caught only by the
// pattern guard above — both together are the guard.
const DEADLINE_MS = 60_000;
test("Form: pathological inputs (200,000 characters) run through — deadline against hangs", (t) => {
  const script = `
    import { checkContextForm } from ${JSON.stringify(new URL("../electron/server/projects/context-form.js", import.meta.url).href)};
    const n = 200000;
    // The triggers repeated so that they also stand several times inside the check cap (CONTEXT_CHECK_TEXT_CAP) — a single
    // trigger at the end of 200,000 characters would fall victim to the cap and prove nothing.
    const cases = [
      { title: "x", body: ("# x" + " ".repeat(5000) + "y\\n").repeat(n / 5004) },
      { body: ("# x" + "\\t".repeat(5000) + "y\\n").repeat(n / 5004) },
      { body: "# x" + " ".repeat(n) + "y" },
      { body: "## Status" + " ".repeat(n) + "x" },
      { body: ("## " + "#".repeat(50) + " \\n").repeat(n / 54) },
      { body: "Text\\n" + " \\n".repeat(n / 2) + "End" },
      { body: "\\n".repeat(n) + "z" },
      { body: "- " + " ".repeat(n) + "[ ]" },
      { body: ("head " + "a".repeat(50) + " ").repeat(n / 56) },
      { body: "stand" + " ".repeat(n) + "x" },
      { summary: "commit " + "1".repeat(n) },
      { body: "auf feature/" + "-".repeat(n) },
      { body: ("Branch " + " ".repeat(3)).repeat(n / 10) },
      { title: "issue" + " ".repeat(n) + "x" },
      { title: "#" + "1".repeat(n) },
    ];
    let hints = 0;
    for (const f of cases) hints += checkContextForm(f).formHints.length;
    console.log("fertig " + cases.length + " " + hints);
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: DEADLINE_MS, env });
  assert.equal(r.signal, null, `aborted after ${DEADLINE_MS} ms (${r.signal}) — a pattern has become polynomial`);
  assert.equal(r.status, 0, r.stderr);
  const m = /^fertig (\d+) (\d+)/.exec(r.stdout);
  assert.ok(m, r.stdout);
  t.diagnostic(`pathological inputs: ${m[1]} cases, ${m[2]} hints, deadline ${DEADLINE_MS} ms`);
});

// The seam MCP description <-> server (two processes, no shared import): what cbase_context_create/_update tell the model about
// the lock and the response field is what the server does — the same limit, the same field name.
test("Form: the descriptions of cbase_context_create/_update name the server's limit and its response field", () => {
  const limit = CONTEXT_BODY_LIMIT.toLocaleString("en-US");
  for (const name of ["cbase_context_create", "cbase_context_update"]) {
    const w = TOOLS.find((x) => x.name === name);
    assert.ok(w, `${name} is missing in the catalog`);
    assert.ok(w.description.includes(`body over ${limit} characters`), `${name}: the limit ${limit} is missing in the description`);
    assert.ok(w.description.includes("`formHints`"), `${name}: the response field formHints is missing in the description`);
    assert.match(w.description, /FORM: the title IS the statement/, `${name}: the rule line is missing`);
  }
  assert.ok(TOOLS.find((x) => x.name === "cbase_context_create").inputSchema.properties.body.description.includes(`over ${limit}`), "the body field names the limit");
  const ws = TOOLS.find((x) => x.name === "cbase_workspace_context_update");
  assert.ok(ws.inputSchema.properties.body.description.includes(`over ${limit} characters`), "cbase_workspace_context_update: the body field names the limit");
});

test("Form at the routes: hints everywhere, lock only for agents (mark ofAgent) — a human never gets a 400 for the length", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Form", wsPath);
    const projPath = path.join(wsPath, "till");
    fs.mkdirSync(projPath, { recursive: true });
    const proj = await makeProject(base, ws.id, projPath);
    assert.ok(proj?.id, JSON.stringify(proj));
    const target = `${base}/api/projects/${proj.id}/context`;
    const clean = await json(target, { method: "POST", body: JSON.stringify({ category: "architecture", title: "Alles rechnet in Cent", summary: "Beträge sind Integer in Cent.", body: "Rundung nur an der Anzeige." }) });
    assert.equal(clean.status, 201, JSON.stringify(clean.body));
    assert.equal(clean.body.formHints, undefined, "a clean entry carries no field");
    const dirty = await json(target, { method: "POST", body: JSON.stringify({ category: "architecture", title: "#12 Rundung", summary: "Seit Commit a1b2c3d in Cent.", body: "## Status\n- [ ] prüfen", force: true }) });
    assert.equal(dirty.status, 201, JSON.stringify(dirty.body));
    assert.equal(dirty.body.formHints.length, 4, JSON.stringify(dirty.body.formHints));

    // Lock only for agents: web and iOS write through the same route WITHOUT the mark — created, with a length hint.
    const nineThousand = "x".repeat(9000);
    const human = await json(target, { method: "POST", body: JSON.stringify({ category: "architecture", title: "Vom Menschen, lang", body: nineThousand, force: true }) });
    assert.equal(human.status, 201, `over the limit without the mark: ${JSON.stringify(human.body).slice(0, 300)}`);
    assert.match(String(human.body.formHints), /body has 9000 characters/, "over the limit without the mark: the length hint");
    const agent = await json(target, { method: "POST", body: JSON.stringify({ category: "architecture", title: "Vom Agenten, lang", body: nineThousand, force: true, ofAgent: true }) });
    assert.equal(agent.status, 400, JSON.stringify(agent.body).slice(0, 300));
    assert.match(agent.body.error, /body hat 9000 Zeichen \(Grenze 6000\) — nichts geschrieben/);
    const list = (await json(`${target}?meta=1&status=all`)).body.filter((e) => e.origin !== "workspace");
    assert.deepEqual(list.map((e) => e.title).sort(), ["#12 Rundung", "Alles rechnet in Cent", "Vom Menschen, lang"], "the agent's entry was not created");

    const changed = await json(`${target}/${clean.body.id}`, { method: "PUT", body: JSON.stringify({ body: "Liegt auf feature/cent bereit." }) });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.match(changed.body.formHints[0], /feature\/cent/);
    const putHuman = await json(`${target}/${clean.body.id}`, { method: "PUT", body: JSON.stringify({ body: "y".repeat(9000) }) });
    assert.equal(putHuman.status, 200, "PUT over the limit without the mark passes");
    assert.match(String(putHuman.body.formHints), /body has 9000 characters/);
    const putAgent = await json(`${target}/${clean.body.id}`, { method: "PUT", body: JSON.stringify({ body: "z".repeat(9500), ofAgent: true }) });
    assert.equal(putAgent.status, 400, "PUT with the mark: grown over the limit => 400");
    assert.equal((await json(`${target}/${clean.body.id}`)).body.body, "y".repeat(9000), "the rejected PUT changed nothing");
    const putAgentShorter = await json(`${target}/${clean.body.id}`, { method: "PUT", body: JSON.stringify({ body: "z".repeat(8000), ofAgent: true }) });
    assert.equal(putAgentShorter.status, 200, "PUT with the mark, but shorter than the existing one: passes");

    // The dumps (a model sorts the text): only hints, never a lock — workspace level (cbase_workspace_context_add) and
    // project dump (cbase_context_dump).
    const throwText = "Deploy-Regel: erst auf feature/release-transaction testen, dann freigeben.";
    const ws1 = await json(`${base}/api/workspaces/${ws.id}/context`, { method: "POST", body: JSON.stringify({ text: throwText, route: "workspace" }) });
    assert.equal(ws1.status, 201, JSON.stringify(ws1.body));
    assert.match(String(ws1.body.formHints), /feature\/release-transaction/, JSON.stringify(ws1.body));
    const dump = await json(`${target}/dump`, { method: "POST", body: JSON.stringify({ text: throwText }) });
    assert.ok(dump.status === 201 || dump.status === 200, JSON.stringify(dump.body));
    assert.match(String(dump.body.formHints), /feature\/release-transaction/, JSON.stringify(dump.body));
    // (The workspace branch of /api/context/route fell with the context agent; an unclear dump now takes the "workspace" way above.)

    // Workspace PUT (cbase_workspace_context_update): hints; lock only with the mark.
    const wsTarget = `${base}/api/workspaces/${ws.id}/context/${ws1.body.item.id}`;
    const wsPut = await json(wsTarget, { method: "PUT", body: JSON.stringify({ body: "Seit Commit b4c5d6e7 gilt die Regel." }) });
    assert.equal(wsPut.status, 200, JSON.stringify(wsPut.body));
    assert.match(String(wsPut.body.formHints), /commit hash \("b4c5d6e7"\)/);
    const wsHuman = await json(wsTarget, { method: "PUT", body: JSON.stringify({ body: nineThousand }) });
    assert.equal(wsHuman.status, 200, "workspace PUT over the limit without the mark passes");
    assert.match(String(wsHuman.body.formHints), /body has 9000 characters/);
    const wsAgent = await json(wsTarget, { method: "PUT", body: JSON.stringify({ body: "w".repeat(9500), ofAgent: true }) });
    assert.equal(wsAgent.status, 400, JSON.stringify(wsAgent.body).slice(0, 300));
    assert.match(wsAgent.body.error, /nichts geschrieben/);
  });
});

// The whole path of an agent: the REAL MCP server, its tools set the mark, and what the route returns as `problems` stands in the
// error text to the model (mcp/lib.js errorText) — the descriptions promise "rejects it as `problems`".
test("Form over the real MCP server: the tools lock over the limit, and problems reach the model", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "FormMcp", wsPath);
    const projPath = path.join(wsPath, "lager");
    fs.mkdirSync(projPath, { recursive: true });
    const proj = await makeProject(base, ws.id, projPath);
    const wsItem = await json(`${base}/api/workspaces/${ws.id}/context`, { method: "POST", body: JSON.stringify({ text: "Ports ab 4000.", route: "workspace" }) });
    assert.equal(wsItem.status, 201, JSON.stringify(wsItem.body));
    await withMcp({ CBASE_BASE_URL: base, CBASE_PROJECT_ID: proj.id, CBASE_WORKSPACE_ID: ws.id }, async ({ call }) => {
      const tooLong = await call("cbase_context_create", { category: "architecture", title: "Lang", body: "x".repeat(9000), force: true });
      assert.equal(tooLong.isError, true, `the tool does not set the mark: ${tooLong.text.slice(0, 200)}`);
      assert.match(tooLong.text, /body hat 9000 Zeichen \(Grenze 6000\) — nichts geschrieben/);
      const short = await call("cbase_context_create", { category: "architecture", title: "Kurz", body: "Rundung an der Anzeige.", force: true });
      assert.equal(short.isError, false, short.text);
      const update = await call("cbase_context_update", { id: short.data.id, body: "y".repeat(9000) });
      assert.equal(update.isError, true, `cbase_context_update does not set the mark: ${update.text.slice(0, 200)}`);
      const wsUpdate = await call("cbase_workspace_context_update", { id: wsItem.body.item.id, body: "w".repeat(9000) });
      assert.equal(wsUpdate.isError, true, `cbase_workspace_context_update does not set the mark: ${wsUpdate.text.slice(0, 200)}`);
      // problems reach the model
      const broken = await call("cbase_context_create", { category: "architecture", title: "Kaputt", body: "Text.", status: "broken", force: true });
      assert.equal(broken.isError, true, broken.text);
      assert.match(broken.text, /OKF-Validierung fehlgeschlagen/);
      assert.match(broken.text, /problems:\n- status must be active\|deprecated\|superseded \(not "broken"\)/, broken.text);
    });
  });
});
