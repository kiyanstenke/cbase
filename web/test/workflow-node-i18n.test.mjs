// Every English UI string of the node dialog, the trigger part and (also) the "Workflow settings" modal has EXACTLY ONE row in
// src/lib/i18n-de.ts — also those that are not written as `t("…")` but come as `t(TABLE[x])` from a constant (COMMAND_TEXT,
// PLACEHOLDER_TEXT, HEADER_TEXT in the dialog; EVENTS, GROUPS, EVENT_PLACEHOLDER in the trigger part; LOCK_TEXT, PERM_OPTIONS and
// the tabs WFE_CATEGORIES from lib/workflow-settings.ts in the modal).
//
// Why a guard: `t()` SILENTLY falls back to the English key when a row is missing (lib/i18n.ts), `tsc` does not see a string as a
// key, and a grep for `t("…")` literals — the manual check — does not find the table values. A duplicate key, in turn, breaks the
// web build (TS1117), and a gate after it silently measures the old bundle. Both are red here.
//
// The guard knows its own blind spot: every NON-literal `t(…)` call in the three files must belong to one of the tables — a new
// `t(NEW_TABLE[x])` is red until the table is entered here. Otherwise this test would be exactly the manual measurement it replaces.
//
// Run:  node --test web/test/workflow-node-i18n.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const read = (rel) => fs.readFileSync(path.join(webDir, rel), "utf8");
const enRows = read("src/lib/i18n-de.ts").split("\n");

// The three files with their tables: `fields` null = a record table, EVERY value is a key; otherwise only the named properties of
// the entries (in EVENTS `kind` is none). `source` = the table stands in ANOTHER sheet than the file it translates. `calls` are
// the non-literal `t(…)` forms that point at these tables.
const FILES = [
  {
    file: "src/components/workflow/WorkflowNodeDialog.tsx",
    tables: [
      { name: "COMMAND_TEXT", fields: null },
      { name: "PLACEHOLDER_TEXT", fields: null },
      { name: "HEADER_TEXT", fields: null },
    ],
    calls: ["COMMAND_TEXT[name]", "PLACEHOLDER_TEXT[token]", "headerInfo"], // headerInfo = HEADER_TEXT[node.type]
  },
  {
    file: "src/components/workflow/WorkflowTriggerSettings.tsx",
    tables: [
      { name: "EVENTS", fields: ["label"] },
      { name: "GROUPS", fields: ["title"] },
      { name: "EVENT_PLACEHOLDER", fields: ["title"] },
    ],
    calls: ["meta.label", "g.title", "c.title"], // EVENTS entry, GROUPS entry, EVENT_PLACEHOLDER entry
  },
  {
    file: "src/components/workflow/WorkflowSettings.tsx",
    tables: [
      { name: "LOCK_TEXT", fields: ["label", "hint"] },
      { name: "PERM_OPTIONS", fields: ["label"] },
      { name: "WFE_CATEGORIES", fields: ["title"], source: "src/lib/workflow-settings.ts" },
    ],
    // o.label/o.hint = LOCK_TEXT or PERM_OPTIONS entry, k.title/category.title = WFE_CATEGORIES entry.
    // The effort marker is translated by the part `effortEntries` in lib/effort.ts, not by the modal — its rows are bound by
    // effort.test.mjs; a `t(effortMarker(…))` here would again be an assembly of its own.
    calls: ["o.label", "o.hint", "k.title", "category.title"],
  },
];

// A string literal in quotes, as it stands in the source (escapes stay raw — both sides are TS literals, the source text is
// compared).
const STR = String.raw`"((?:[^"\\]|\\.)*)"`;

// All `t("…")` literals of a file (the first argument; `{n}` parameters after it do not matter).
const literals = (source) => [...source.matchAll(new RegExp(String.raw`\bt\(\s*${STR}`, "g"))].map((m) => m[1]);
// All `t(…)` calls whose first argument is NOT a literal — the text up to the closing parenthesis.
const notLiterals = (source) => [...source.matchAll(/\bt\((?!\s*")([^)]*)\)/g)].map((m) => m[1].trim());

// The block `const NAME… = {|[` up to the line `};` or `];` — line by line, as the tables are written in both files (one line per
// entry).
function table(source, name, location) {
  const rows = source.split("\n");
  const start = rows.findIndex((z) => new RegExp(String.raw`^(?:export )?const ${name}\b`).test(z));
  assert.ok(start >= 0, `the table ${name} is missing in ${location} — renamed or moved? Then update FILES, do not delete the test`);
  const end = rows.findIndex((z, i) => i > start && /^[\]}](?: as const)?;\s*$/.test(z));
  assert.ok(end > start, `the table ${name} in ${location} does not end with "];", "] as const;" or "};" on its own line`);
  return rows.slice(start + 1, end).join("\n");
}
function valuesFrom(block, fields) {
  const re = fields
    ? new RegExp(String.raw`\b(?:${fields.join("|")}):\s*${STR}`, "g")
    : new RegExp(String.raw`^\s*(?:${STR}|\w+)\s*:\s*${STR}`, "gm");
  // In the record form the second group is the value (the first a string key like "{{input}}").
  return [...block.matchAll(re)].map((m) => (fields ? m[1] : m[2]));
}

test("every UI string of the node dialog, the trigger part and the workflow settings has exactly one row — literals AND table values", () => {
  const report = [];
  for (const { file, tables, calls } of FILES) {
    const source = read(file);
    const location = path.basename(file);
    const lit = literals(source);
    assert.ok(lit.length > 0, `${location}: not a single t("…") found — does the regex still apply?`);
    const tab = [];
    for (const { name, fields, source: other } of tables) {
      const values = valuesFrom(table(other ? read(other) : source, name, other ? path.basename(other) : location), fields);
      assert.ok(values.length > 0, `${location}: the table ${name} yields no value — shape changed?`);
      tab.push(...values);
    }
    for (const key of [...lit, ...tab]) {
      const hits = enRows.filter((z) => z.trimStart().startsWith(`"${key}":`)).length;
      assert.equal(hits, 1, `${location}: "${key}" has ${hits} rows in i18n-de.ts (exactly one: 0 shows the English key in the German UI, 2 breaks the build)`);
    }
    // The guard's blind spot: a non-literal call that none of the tables above covers.
    const foreign = notLiterals(source).filter((a) => !calls.includes(a));
    assert.deepEqual(foreign, [], `${location}: t(…) with an argument this guard does not know — enter the table in FILES, else its content is unmeasured`);
    report.push(`${location} ${lit.length} literals + ${tab.length} table values`);
  }
  console.log(`  [i18n] ${report.join(" · ")}`);
});
