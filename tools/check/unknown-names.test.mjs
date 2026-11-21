// Guard against unknown names in the backend.
//
// Why: when two changes were merged, the import `instanceForProject` vanished from server/backend/electron/server/projects/routes.js
// while six calls stayed. `node --check` cannot see this (syntax is fine), the server starts (ESM binds the name at call time), and
// only at runtime does the route throw a ReferenceError — once as a 500, five times silently swallowed by a try/catch. Only a suite
// that happened to enter the path caught it; an untested path would stay open.
//
// The measurement: TypeScript (`checkJs`, from web/node_modules like the seams guard) over ALL .js under server/backend/electron;
// only the findings "Cannot find name '…'" (TS2304, TS2552 "Did you mean …" and siblings) are counted — a name that is used but
// declared or imported nowhere. The other checkJs messages (mostly type fuzziness like TS2339) do not count.
//
// What it does NOT catch: a name that @types/node knows as a global value (`crypto`, `fetch`, `navigator` …) — the error there would
// mostly be none at runtime. Hence deliberately WITHOUT the DOM library: with it `name`, `status`, `open`, `close` … would count as
// "known" (window.name), and a forgotten name of that kind would slip through.
//
// The exception list (EXCEPTIONS) is empty and may only shrink: an entry needs file, name and reason, and an entry without a finding
// is red. A `@ts-nocheck`/`@ts-ignore`/`@ts-expect-error` in the tree is red as well — it would silently switch the measurement off
// for its file or line.
//
// The counter-test is built in: the same measurement sees a copy of projects/routes.js (in memory, next to the original so its
// relative imports resolve) with the import of `instanceForProject` removed and must report the name there. If the import is no
// longer in the file, the test is red — then the counter-test needs a new target.
//
// Run:  node --test --test-reporter=tap tools/check/unknown-names.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadTs } from "./lib/seams.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT = path.join(REPO, "server", "backend", "electron");
const TYPES = path.join(REPO, "server", "backend", "node_modules", "@types");

// { file: "<relative to server/backend/electron>", name: "<name>", reason: "<why it may (still) stand, and who resolves it>" }
const EXCEPTIONS = [];

// The counter-test: this file, this name.
const COUNTER_PROBE = { file: "server/projects/routes.js", name: "instanceForProject" };
const COUNTER_PROBE_PATH = path.join(ROOT, "server", "projects", "__counter_probe-unknown-names.js");

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.isFile() && e.name.endsWith(".js")) out.push(p);
  }
  return out.sort();
}

/** Remove a name's import from the source text (the counter-test's sabotage); null if no import binds it. */
function withoutImport(text, name) {
  let hit = false;
  const fresh = text.replace(/import\s*\{([^}]*)\}\s*from\s*("[^"]+"|'[^']+')\s*;?/g, (whole, list, source) => {
    const names = list.split(",").map((s) => s.trim()).filter(Boolean);
    const rest = names.filter((n) => n !== name && !n.startsWith(`${name} as `) && !n.endsWith(` as ${name}`));
    if (rest.length === names.length) return whole;
    hit = true;
    return rest.length ? `import { ${rest.join(", ")} } from ${source};` : "";
  });
  return hit ? fresh : null;
}

/**
 * The measurement: all "Cannot find name" findings of TypeScript (checkJs) over `files`, plus `overlaid` (path → text, files
 * in memory only).
 * @returns {{ befunde: { pfad: string, zeile: number, name: string, code: number }[], dateien: number, allgemein: string[] }}
 */
function unknownNames(files, overlaid = new Map()) {
  const ts = loadTs(REPO);
  if (!fs.existsSync(path.join(TYPES, "node", "package.json"))) {
    throw new Error(`@types/node missing under ${TYPES} — without the Node types every \`process\` would be a finding (npm -C server/backend install).`);
  }
  const { options, errors } = ts.convertCompilerOptionsFromJson({
    allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true, maxNodeModuleJsDepth: 0,
    target: "es2023", module: "nodenext", moduleResolution: "nodenext", lib: ["es2023"],
    types: ["node"], typeRoots: [TYPES],
  }, REPO);
  assert.deepEqual(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), [], "the guard's compiler options are invalid");
  const host = ts.createCompilerHost(options);
  const readOrig = host.readFile.bind(host);
  const existsOrig = host.fileExists.bind(host);
  const sourceOrig = host.getSourceFile.bind(host);
  host.readFile = (f) => (overlaid.has(path.resolve(f)) ? overlaid.get(path.resolve(f)) : readOrig(f));
  host.fileExists = (f) => overlaid.has(path.resolve(f)) || existsOrig(f);
  host.getSourceFile = (f, language, ...rest) => (overlaid.has(path.resolve(f))
    ? ts.createSourceFile(f, overlaid.get(path.resolve(f)), language, true)
    : sourceOrig(f, language, ...rest));
  const roots = [...files, ...overlaid.keys()];
  const program = ts.createProgram({ rootNames: roots, options, host });
  for (const f of roots) assert.ok(program.getSourceFile(f), `TypeScript does not see ${path.relative(REPO, f)} — the measurement never checked the file`);
  const general = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  const findings = [];
  for (const d of program.getSemanticDiagnostics()) {
    const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    const m = /^Cannot find name '([^']+)'/.exec(text);
    if (!m || !d.file) continue;
    const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
    findings.push({ path: path.resolve(d.file.fileName), row: line + 1, name: m[1], code: d.code });
  }
  return { findings, files: roots.length, general };
}

test("no name is used without being declared (except the named exception list) — with a built-in counter-test", () => {
  const files = jsFiles(ROOT);
  assert.ok(files.length > 0, `no .js under ${ROOT}`);
  assert.ok(files.includes(path.join(ROOT, COUNTER_PROBE.file)), `the counter-test's file is missing: ${COUNTER_PROBE.file}`);

  // The sabotage: the name's import removed, in an in-memory copy (null: no import binds it — red below).
  const sabotaged = withoutImport(fs.readFileSync(path.join(ROOT, COUNTER_PROBE.file), "utf8"), COUNTER_PROBE.name);

  const since = Date.now();
  const { findings, files: seen, general } = unknownNames(files, sabotaged === null ? new Map() : new Map([[COUNTER_PROBE_PATH, sabotaged]]));
  const ms = Date.now() - since;
  assert.deepEqual(general, [], "general TypeScript messages — the measurement cannot be trusted");

  const against = findings.filter((b) => b.path === COUNTER_PROBE_PATH);
  const real = findings.filter((b) => b.path !== COUNTER_PROBE_PATH).map((b) => ({ ...b, file: path.relative(ROOT, b.path) }));
  const isException = (b) => EXCEPTIONS.some((a) => a.file === b.file && a.name === b.name);
  const fresh = real.filter((b) => !isException(b));
  const withoutFinding = EXCEPTIONS.filter((a) => !real.some((b) => b.file === a.file && b.name === a.name));
  const withoutReason = EXCEPTIONS.filter((a) => !String(a.reason || "").trim());
  console.log(`unknown names: ${files.length} files checked, ${real.length} findings, ${EXCEPTIONS.length} exceptions, counter-test ${against.length}× \`${COUNTER_PROBE.name}\`, ${seen} files in ${ms} ms`);

  assert.deepEqual(fresh.map((b) => `${b.file}:${b.row} ${b.name} (TS${b.code})`), [],
    "a name is used but neither declared nor imported — a ReferenceError at runtime. Add the import/declaration; only with a reason in EXCEPTIONS");
  assert.deepEqual(withoutFinding.map((a) => `${a.file} ${a.name}`), [], "an exception without a finding — remove the entry (the list may only shrink)");
  assert.deepEqual(withoutReason.map((a) => `${a.file} ${a.name}`), [], "an exception without a reason");

  // The counter-test: without it "zero findings" might only mean nothing was checked.
  assert.ok(sabotaged !== null, `the counter-test no longer bites: no import binds \`${COUNTER_PROBE.name}\` in ${COUNTER_PROBE.file} — pick a new target`);
  assert.ok(against.length > 0 && against.every((b) => b.name === COUNTER_PROBE.name),
    `counter-test: without the import of \`${COUNTER_PROBE.name}\` the measurement reports ${JSON.stringify(against.map((b) => b.name))} — the guard does not see this kind of error`);
});

test("no @ts-nocheck/@ts-ignore/@ts-expect-error under server/backend/electron — it would silently switch the measurement off", () => {
  const hits = [];
  for (const f of jsFiles(ROOT)) {
    fs.readFileSync(f, "utf8").split("\n").forEach((z, i) => {
      if (/^\s*(\/\/|\/?\*+)\s*@ts-(nocheck|ignore|expect-error)\b/.test(z)) hits.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
