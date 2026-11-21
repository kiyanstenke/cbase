// Agent communication, name guard: the seven old tools (cbase_chat_list, _chat_read, _runs_overview, _channel_read, _channel_send,
// _channel_status, _channel_create) are merged EVERYWHERE into the tool pair cbase_agents_list / cbase_agent_send (and
// cbase_chat_assign). An old name in a string literal (or as key of an object literal) under server/backend/electron/server/ or
// server/backend/electron/mcp/ is text an agent reads (prompt, preamble, description, error message, template) and that sends
// it to a tool that no longer exists. Comments do not count (they tell the origin); the check walks the TypeScript syntax tree,
// not grep, so a comment, a regex or an identifier does not count and a multi-line literal does not escape.
//
// ONE named exception: the migration table (channels/migration-communication-table.js) - it MUST carry the old names, else the
// migration would not know what it replaces. The exception is bound in both directions: if the table carries no old name any
// more, the entry here is dead and red. It is NARROW: every old name appears exactly ONCE, as key of TOOL_REPLACEMENT, and a new
// literal with an old name there would again be text an agent reads. Counter-test: a literal `"use cbase_channel_send"` planted in
// the table => "The exception lives ..." red.
//
// Counter-tests: an earlier state with the old names in many files => red with 50+ findings; a planted literal in a copy of
// channels/delivery.js => red; the self-test below plants literal, template and comment in a synthetic text.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON = path.join(HERE, "..", "electron");
const ROOTS = [path.join(ELECTRON, "server"), path.join(ELECTRON, "mcp")];
const OLD_NAMES = ["cbase_chat_list", "cbase_chat_read", "cbase_runs_overview", "cbase_channel_read", "cbase_channel_send", "cbase_channel_status", "cbase_channel_create"];
const EXCEPTION = path.join(ELECTRON, "server", "channels", "migration-communication-table.js");

const LITERAL_KINDS = new Set([
  ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail,
]);

/** All findings "old name in a string literal" of a source text: [{ row, name }]. */
function oldNamesInLiterals(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const findings = [];
  const visits = (node) => {
    // A key of an object literal ({ cbase_x: ... }) is just as much a name the code acts on (pattern: FENCE_LOCKED).
    const key = node.kind === ts.SyntaxKind.Identifier && node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name === node;
    if (LITERAL_KINDS.has(node.kind) || key) {
      const content = String(node.text ?? "");
      for (const name of OLD_NAMES) {
        if (content.includes(name)) findings.push({ row: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, name });
      }
    }
    ts.forEachChild(node, visits);
  };
  visits(source);
  return findings;
}

function sourceFiles(root) {
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("self-test: literal, template, multi-line string and object key are found, comment, regex and identifier are not", () => {
  const text = [
    "// cbase_channel_send in a comment does not count",
    "/* cbase_chat_read in a block comment neither */",
    "const re = /cbase_runs_overview/;",
    "const cbase_chat_list_counter = 1;",
    "const a = \"use cbase_channel_read\";",
    "const b = `x ${a} cbase_channel_create y`;",
    "const c = 'first line \\",
    "cbase_channel_status';",
    "const d = { cbase_runs_overview: 1, x: cbase_chat_read };",
  ].join("\n");
  const findings = oldNamesInLiterals("selfTest.js", text);
  assert.deepEqual(findings.map((f) => `${f.row}:${f.name}`), ["5:cbase_channel_read", "6:cbase_channel_create", "7:cbase_channel_status", "9:cbase_runs_overview"]);
});

test("no old tool name in a string literal under server/ and mcp/ (exception: the migration table)", () => {
  const files = ROOTS.flatMap(sourceFiles);
  assert.ok(files.length > 100, `too few source files found (${files.length}) - wrong path?`);
  const findings = [];
  for (const file of files) {
    if (file === EXCEPTION) continue;
    for (const f of oldNamesInLiterals(file, fs.readFileSync(file, "utf8"))) findings.push(`${path.relative(ELECTRON, file)}:${f.row} ${f.name}`);
  }
  assert.deepEqual(findings, [], `old tool names in literals:\n${findings.join("\n")}`);
});

test("The exception lives and is narrow: the migration table carries each of the seven old names exactly once - as key of TOOL_REPLACEMENT", async () => {
  assert.ok(fs.existsSync(EXCEPTION), `${EXCEPTION} is missing - the exception of the name guard points nowhere`);
  const findings = oldNamesInLiterals(EXCEPTION, fs.readFileSync(EXCEPTION, "utf8"));
  assert.deepEqual(findings.map((f) => f.name).sort(), [...OLD_NAMES].sort(), `every name exactly once: ${JSON.stringify(findings)}`);
  const { TOOL_REPLACEMENT } = await import("../electron/server/channels/migration-communication-table.js");
  assert.deepEqual(Object.keys(TOOL_REPLACEMENT).sort(), [...OLD_NAMES].sort(), "the seven findings are the keys of the replacement table");
});
